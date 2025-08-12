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
    this.outboundCallsPath = env.ELEVENLABS_OUTBOUND_CALLS_PATH ?? '/v1/voice/agents/{agentId}/calls';
  }

  async createOutboundCall(payload: OutboundCallPayload): Promise<OutboundCallResponse> {
    const sanitize = (s: string) => s.replace(/\s+/g, '');
    const useTwilio = this.outboundCallsPath.includes('/convai/twilio/outbound-call') || !!payload.agentPhoneNumberId;

    if (useTwilio) {
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
      const { data } = await twilioHttp.post(this.outboundCallsPath, body);
      return {
        callId: data.callSid ?? data.conversation_id ?? 'unknown',
        status: data.success === true ? 'queued' : 'failed',
      };
    }

    const path = this.outboundCallsPath.replace('{agentId}', payload.agentId);
    const body: Record<string, unknown> = {
      from_number: payload.fromNumber ? sanitize(payload.fromNumber) : undefined,
      to_number: sanitize(payload.toNumber),
    };
    if (payload.metadata) body.metadata = payload.metadata;
    if (payload.variables) body.variables = payload.variables;
    if (payload.scheduleAtIso) body.schedule_at = payload.scheduleAtIso;

    const { data } = await this.http.post(path, body);
    return {
      callId: data.id ?? data.call_id ?? data.callId ?? 'unknown',
      status: data.status ?? 'queued',
    };
  }
}

export const elevenLabsClient = new ElevenLabsClient();


