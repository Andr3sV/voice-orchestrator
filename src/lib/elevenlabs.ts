import axios from 'axios';
import type { AxiosInstance } from 'axios';
import { env } from './env.js';

export type OutboundCallPayload = {
  workspaceId: string;
  agentId: string;
  agentPhoneNumberId: string | undefined;
  fromNumber: string | undefined;
  toNumber: string;
  metadata: Record<string, unknown> | undefined;
  variables: Record<string, unknown> | undefined;
  scheduleAtIso?: string;
};

export type OutboundCallResponse = {
  callId: string;
  status: 'queued' | 'in_progress' | 'completed' | 'failed';
};

export class ElevenLabsClient {
  private http: AxiosInstance;
  private outboundCallsPath: string;

  constructor() {
    this.http = axios.create({
      baseURL: env.ELEVENLABS_BASE_URL,
      headers: {
        Authorization: `Bearer ${env.ELEVENLABS_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 30_000,
    });
    this.outboundCallsPath = env.ELEVENLABS_OUTBOUND_CALLS_PATH ?? '/v1/convai/sip-trunk/outbound-call';
  }

  async createOutboundCall(payload: OutboundCallPayload): Promise<OutboundCallResponse> {
    const sanitize = (s: string) => s.replace(/\s+/g, '');
    
    // Use Twilio native integration only if explicitly configured
    const useTwilioNative = this.outboundCallsPath.includes('/convai/twilio/outbound-call');

    if (useTwilioNative) {
      const twilioHttp = axios.create({
        baseURL: env.ELEVENLABS_BASE_URL,
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': env.ELEVENLABS_API_KEY,
        },
        timeout: 30_000,
      });
      const body: Record<string, unknown> = {
        agent_id: payload.agentId,
        agent_phone_number_id: payload.agentPhoneNumberId,
        to_number: sanitize(payload.toNumber),
      };
      if (payload.variables && Object.keys(payload.variables).length > 0) {
        body.conversation_initiation_client_data = { dynamic_variables: payload.variables };
      }
      try {
        const { data } = await twilioHttp.post(this.outboundCallsPath, body);
        return {
          callId: data.callSid ?? data.conversation_id ?? 'unknown',
          status: data.success === true ? 'queued' : 'failed',
        };
      } catch (err: any) {
        const status = err?.response?.status;
        const data = err?.response?.data;
        const msg = `ElevenLabs Twilio outbound error${status ? ` (${status})` : ''}: ${typeof data === 'string' ? data : JSON.stringify(data)}`;
        throw Object.assign(new Error(msg), { statusCode: status ?? 500 });
      }
    }

    // SIP trunk endpoint requires xi-api-key header and specific payload structure
    const sipTrunkHttp = axios.create({
      baseURL: env.ELEVENLABS_BASE_URL,
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': env.ELEVENLABS_API_KEY,
      },
      timeout: 30_000,
    });

    const path = this.outboundCallsPath;
    // SIP trunk endpoint requires agent_phone_number_id
    if (!payload.agentPhoneNumberId) {
      throw Object.assign(new Error('SIP trunk outbound call requires agentPhoneNumberId'), { statusCode: 400 });
    }

    const body: Record<string, unknown> = {
      agent_id: payload.agentId,
      agent_phone_number_id: payload.agentPhoneNumberId,
      to_number: sanitize(payload.toNumber),
    };
    
    if (payload.variables && Object.keys(payload.variables).length > 0) {
      body.conversation_initiation_client_data = { dynamic_variables: payload.variables };
    }

    try {
      const { data } = await sipTrunkHttp.post(path, body);
      return {
        callId: data.conversation_id ?? data.sip_call_id ?? 'unknown',
        status: data.success === true ? 'queued' : 'failed',
      };
    } catch (err: any) {
      const status = err?.response?.status;
      const data = err?.response?.data;
      const msg = `ElevenLabs SIP trunk outbound error${status ? ` (${status})` : ''}: ${typeof data === 'string' ? data : JSON.stringify(data)}`;
      throw Object.assign(new Error(msg), { statusCode: status ?? 500 });
    }
  }
}

export const elevenLabsClient = new ElevenLabsClient();


