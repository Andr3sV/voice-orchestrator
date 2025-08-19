import type { FastifyInstance } from 'fastify';
import { logger } from '../lib/logger.js';
import WS from 'ws';
import { env } from '../lib/env.js';

// Minimal G.711 µ-law encode/decode for PCM16 mono
const ULAW_BIAS = 0x84;
const ULAW_CLIP = 32635;

function linearToULaw(sample: number): number {
  let sign = 0;
  if (sample < 0) {
    sign = 0x80;
    sample = -sample;
  }
  if (sample > ULAW_CLIP) sample = ULAW_CLIP;
  sample = sample + ULAW_BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent--;
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  const ulaw = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return ulaw;
}

function uLawToLinear(uVal: number): number {
  uVal = ~uVal & 0xff;
  const sign = uVal & 0x80;
  const exponent = (uVal >> 4) & 0x07;
  const mantissa = uVal & 0x0f;
  let sample = ((mantissa << 4) + 0x08) << (exponent + 3);
  sample = sample - ULAW_BIAS;
  return sign ? -sample : sample;
}

function muLawEncode(pcm16: Buffer): Buffer {
  const out = Buffer.allocUnsafe(pcm16.length / 2);
  for (let i = 0, o = 0; i < pcm16.length; i += 2, o++) {
    const s = pcm16.readInt16LE(i);
    out[o] = linearToULaw(s);
  }
  return out;
}

function muLawDecode(ulaw: Buffer): Buffer {
  const out = Buffer.allocUnsafe(ulaw.length * 2);
  for (let i = 0, o = 0; i < ulaw.length; i++, o += 2) {
    const s = uLawToLinear(ulaw[i]!);
    out.writeInt16LE(s, o);
  }
  return out;
}

// Simple PCM16 mono resamplers
function upsample8kTo16kPCM16(pcm8k: Buffer): Buffer {
  const sampleCount = pcm8k.length / 2;
  const out = Buffer.allocUnsafe(pcm8k.length * 2);
  for (let i = 0; i < sampleCount; i++) {
    const s = pcm8k.readInt16LE(i * 2);
    out.writeInt16LE(s, i * 4);
    out.writeInt16LE(s, i * 4 + 2);
  }
  return out;
}

function downsample16kTo8kPCM16(pcm16k: Buffer): Buffer {
  const sampleCount = pcm16k.length / 2;
  const out = Buffer.allocUnsafe(Math.floor(sampleCount / 2) * 2);
  let o = 0;
  for (let i = 0; i + 1 < sampleCount; i += 2) {
    // simple average of each pair
    const s1 = pcm16k.readInt16LE(i * 2);
    const s2 = pcm16k.readInt16LE((i + 1) * 2);
    const avg = (s1 + s2) >> 1;
    out.writeInt16LE(avg, o);
    o += 2;
  }
  return out;
}

type TwilioMediaEvent = {
  event: string;
  start?: { callSid: string; streamSid: string };
  media?: { track: string; chunk: number; timestamp: string; payload: string };
  stop?: { callSid: string; streamSid: string };
  mark?: { name: string };
};

export async function registerStreamsRoutes(app: FastifyInstance) {
  app.get('/ws/stream', { websocket: true }, (connection, req) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    const callId = url.searchParams.get('callId') || 'unknown';
    const callSid = url.searchParams.get('sid') || 'unknown';
    const agentId = url.searchParams.get('agentId') || '';

    logger.info({ callId, callSid }, 'Media stream connected');

    // Outgoing WS to ElevenLabs ConvAI
    let elWs: WS | null = null;
    let twilioStreamSid: string | null = null;

    // Track streamSid for Twilio replies
    // No external resampler; use simple up/down sampling helpers above
    try {
      const target = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${encodeURIComponent(agentId)}`;
      if (!agentId) {
        logger.warn({ callId }, 'Missing agentId, closing WS');
        try { connection.close(); } catch {}
        return;
      }
      elWs = new WS(target, { headers: { 'xi-api-key': env.ELEVENLABS_API_KEY } as any });
      elWs.on('open', () => {
        logger.info({ callId }, 'Connected to ElevenLabs');
        try {
          // Ask ElevenLabs to emit audio events and start speaking when ready
          elWs?.send(
            JSON.stringify({
              enable_audio_events: true,
              sample_rate: 16000,
              text_input: 'Hello',
            })
          );
        } catch (e) {
          logger.warn({ e, callId }, 'Failed to send EL init message');
        }
      });
      elWs.on('close', (code: number, reason: Buffer) => logger.info({ callId, code, reason: reason?.toString() }, 'ElevenLabs WS closed'));
      elWs.on('error', (err: Error) => logger.error({ err, callId }, 'ElevenLabs WS error'));
      elWs.on('message', (data: WS.RawData) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'audio' && msg?.audio_event?.audio_base_64) {
            // ElevenLabs -> Twilio: base64 PCM16 16k mono -> downsample to 8k -> mu-law -> send
            try {
              const elPcm16 = Buffer.from(msg.audio_event.audio_base_64, 'base64');
              const pcm8 = downsample16kTo8kPCM16(elPcm16);
              const mu = muLawEncode(pcm8);
              if (twilioStreamSid) {
                connection.send(JSON.stringify({ event: 'media', streamSid: twilioStreamSid, media: { payload: mu.toString('base64') } }));
              }
            } catch (err) {
              logger.warn({ err, callId }, 'Failed to process ElevenLabs audio');
            }
          } else if (msg.type === 'interruption') {
            if (twilioStreamSid) connection.send(JSON.stringify({ event: 'clear', streamSid: twilioStreamSid }));
          } else if (msg.type === 'transcription' && msg.text) {
            logger.info({ callId, text: msg.text }, 'EL transcription');
          }
        } catch (e) {
          logger.warn({ e, callId }, 'Failed to parse EL message');
        }
      });
    } catch (err) {
      logger.error({ err, callId }, 'Failed to connect to ElevenLabs ConvAI');
    }

    connection.on('message', (message: Buffer) => {
      try {
        const text = message.toString('utf8');
        const evt = JSON.parse(text) as TwilioMediaEvent;
        if (evt.event === 'start') {
          twilioStreamSid = evt.start?.streamSid ?? null;
          logger.info({ callId, callSid, twilioStreamSid, start: evt.start }, 'Stream start');
          return;
        }
        if (evt.event === 'media') {
          // Twilio -> ElevenLabs: mu-law 8k payload -> decode to PCM16 -> upsample to 16k -> send to EL
          const payload = evt.media?.payload;
          if (payload && elWs && elWs.readyState === WS.OPEN) {
            try {
              const mu = Buffer.from(payload, 'base64');
              const pcm8 = muLawDecode(mu);
              const pcm16 = upsample8kTo16kPCM16(pcm8);
              elWs?.send(JSON.stringify({ user_audio_chunk: pcm16.toString('base64') }));
            } catch (err) {
              logger.warn({ err, callId }, 'Failed to process Twilio media frame');
            }
          }
          return;
        }
        if (evt.event === 'mark') {
          logger.debug({ callId, callSid, mark: evt.mark }, 'Stream mark');
          return;
        }
        if (evt.event === 'stop') {
          logger.info({ callId, callSid, stop: evt.stop }, 'Stream stop');
          return;
        }
        logger.debug({ callId, callSid, evt }, 'Stream event');
      } catch (err) {
        logger.warn({ err, callId, callSid }, 'Failed to parse stream message');
      }
    });

    connection.on('close', () => {
      try { elWs?.close(); } catch {}
      logger.info({ callId, callSid }, 'Media stream disconnected');
    });
  });
}


