import dotenv from 'dotenv';

dotenv.config();

type RequiredEnv = {
	ELEVENLABS_API_KEY: string;
	ELEVENLABS_BASE_URL: string;
	REDIS_URL: string;
};

type OptionalEnv = {
	ELEVENLABS_OUTBOUND_CALLS_PATH: string | undefined; // e.g. /v1/voice/agents/{agentId}/calls
	ELEVENLABS_SIP_ADDRESS?: string; // ElevenLabs SIP trunk address
	SERVICE_PORT: string | undefined;
	TWILIO_ACCOUNT_SID?: string;
	TWILIO_AUTH_TOKEN?: string;
	TWILIO_FROM_FALLBACK?: string;
	PUBLIC_BASE_URL?: string; // e.g., https://voice.ateneai.com
};

type ExtraEnv = {
	RETENTION_DAYS: number; // days to keep detailed Call rows
};

export type Env = RequiredEnv & OptionalEnv & ExtraEnv;

function ensureEnvVariable(name: keyof RequiredEnv, value: string | undefined): string {
	if (!value || value.length === 0) {
		// Fail fast with a clear message
		throw new Error(`Missing required environment variable: ${name}`);
	}
	return value;
}

export const env: Env = {
	ELEVENLABS_API_KEY: ensureEnvVariable('ELEVENLABS_API_KEY', process.env.ELEVENLABS_API_KEY),
	ELEVENLABS_BASE_URL: ensureEnvVariable('ELEVENLABS_BASE_URL', process.env.ELEVENLABS_BASE_URL),
	REDIS_URL: ensureEnvVariable('REDIS_URL', process.env.REDIS_URL),
	ELEVENLABS_OUTBOUND_CALLS_PATH: process.env.ELEVENLABS_OUTBOUND_CALLS_PATH,
	ELEVENLABS_SIP_ADDRESS: process.env.ELEVENLABS_SIP_ADDRESS,
	SERVICE_PORT: process.env.PORT ?? process.env.SERVICE_PORT,
	RETENTION_DAYS: Number.parseInt(process.env.RETENTION_DAYS || '15', 10),
	TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
	TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
	TWILIO_FROM_FALLBACK: process.env.TWILIO_FROM_FALLBACK,
	PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
} as unknown as Env;


