// Server-side configuration. Each process reads only what it needs; nothing
// here is imported by client components.
export type Env = Record<string, string | undefined>;
import { z } from 'zod';
import { validateSizingConfig, type SizingConfig } from './sizing';

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => (v === undefined ? def : v === 'true' || v === '1'));
const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') return def;
      const n = Number(v);
      if (!Number.isSafeInteger(n)) {
        ctx.addIssue({ code: 'custom', message: `expected integer, got ${v}` });
        return z.NEVER;
      }
      return n;
    });
const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') return def;
      const n = Number(v);
      if (!Number.isFinite(n)) {
        ctx.addIssue({ code: 'custom', message: `expected number, got ${v}` });
        return z.NEVER;
      }
      return n;
    });
const optStr = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v === '' ? undefined : v));

const viewSchema = z.object({
  MAP_DEFAULT_TOPIC_DEPTH: int(2),
  MAP_MAX_VISIBLE_NODES: int(200),
  MAP_CONTENT_PAGE_SIZE: int(50),
  MAP_NODE_MIN_DIAMETER_PX: num(64),
  MAP_NODE_MAX_DIAMETER_PX: num(220),
  MAP_NODE_SIZE_REFERENCE_COUNT: int(10_000),
  DEFAULT_DISPLAY_TIMEZONE: z.string().default('Asia/Singapore'),
  AUTO_READ_DWELL_MS: int(2000),
});

export type ViewConfig = {
  defaultTopicDepth: number;
  maxVisibleNodes: number;
  contentPageSize: number;
  sizing: SizingConfig;
  defaultTimezone: string;
  autoReadDwellMs: number;
};

export function loadViewConfig(env: Env = process.env): ViewConfig {
  const v = viewSchema.parse(env);
  if (v.MAP_DEFAULT_TOPIC_DEPTH < 0) throw new Error('MAP_DEFAULT_TOPIC_DEPTH must be >= 0');
  if (v.MAP_MAX_VISIBLE_NODES < 4) throw new Error('MAP_MAX_VISIBLE_NODES must be >= 4');
  if (v.MAP_CONTENT_PAGE_SIZE < 1 || v.MAP_CONTENT_PAGE_SIZE > 500) {
    throw new Error('MAP_CONTENT_PAGE_SIZE must be within 1..500');
  }
  return {
    defaultTopicDepth: v.MAP_DEFAULT_TOPIC_DEPTH,
    maxVisibleNodes: v.MAP_MAX_VISIBLE_NODES,
    contentPageSize: v.MAP_CONTENT_PAGE_SIZE,
    sizing: validateSizingConfig({
      minDiameterPx: v.MAP_NODE_MIN_DIAMETER_PX,
      maxDiameterPx: v.MAP_NODE_MAX_DIAMETER_PX,
      referenceCount: v.MAP_NODE_SIZE_REFERENCE_COUNT,
    }),
    defaultTimezone: v.DEFAULT_DISPLAY_TIMEZONE,
    autoReadDwellMs: v.AUTO_READ_DWELL_MS,
  };
}

const appSchema = z.object({
  NODE_ENV: z.string().default('development'),
  APP_MODE: z.enum(['hosted', 'development']).default('development'),
  PORT: int(3000),
  PUBLIC_ORIGIN_MODE: z.enum(['database_bootstrap', 'explicit']).default('database_bootstrap'),
  DEPLOYMENT_ID: optStr,
  APP_URL: optStr,
  BETTER_AUTH_URL: optStr,
  BETTER_AUTH_SECRET: optStr,
  PUBLIC_DEMO_ENABLED: bool(true),
  PUBLIC_DEMO_PAIRING_ENABLED: bool(false),
  WHATSAPP_PAIRING_ENABLED: bool(true),
  SOURCE_PROVIDER: z.enum(['baileys', 'fixture']).default('baileys'),
  LLM_PROVIDER: z.enum(['nebius', 'fixture']).default('nebius'),
  STORAGE_DRIVER: z.enum(['s3', 'local']).default('local'),
  MAX_ATTACHMENT_MIB: int(50),
  MAX_MEDIA_CACHE_MIB: int(500),
});

export type AppConfig = z.infer<typeof appSchema>;

export function loadAppConfig(env: Env = process.env): AppConfig {
  const cfg = appSchema.parse(env);
  if (cfg.PUBLIC_DEMO_PAIRING_ENABLED) {
    // Demo guests may never pair; refuse an unsafe configuration outright.
    throw new Error('PUBLIC_DEMO_PAIRING_ENABLED=true is not supported');
  }
  return cfg;
}

const llmSchema = z.object({
  LLM_PROVIDER: z.enum(['nebius', 'fixture']).default('nebius'),
  NEBIUS_API_KEY: optStr,
  NEBIUS_BASE_URL: z.string().url().default('https://api.tokenfactory.nebius.com/v1/'),
  NEBIUS_MODEL_REASONING: optStr,
  NEBIUS_MODEL_FAST: optStr,
  NEBIUS_MODEL_BALANCED: optStr,
  // Image understanding for photos and video preview frames (Token Factory has no audio model).
  NEBIUS_MODEL_VISION: z.string().default('nvidia/Nemotron-3.5-Super-VL'),
  NEBIUS_THINKING_OFF_ROLES: z.string().default('fast'),
  ALLOW_REASONING_FALLBACK: bool(false),
  NEBIUS_MODEL_REASONING_FALLBACK: optStr,
  LLM_MAX_USD_PER_JOB: num(1),
  LLM_MAX_USD_PER_DAY: num(5),
  LLM_MAX_CALLS_PER_JOB: int(100),
  // Lifetime spend per user (USD); 0 disables the cap. Numbers in
  // LLM_UNLIMITED_PHONES (digits with country code, comma-separated) skip the
  // per-user, per-job USD and daily caps.
  LLM_MAX_USD_PER_USER: num(0.2),
  LLM_UNLIMITED_PHONES: optStr,
  LLM_MICROBATCH_MAX_MESSAGES: int(60),
  // Messages per extraction call; bigger batches made Nano skip messages.
  LLM_EXTRACT_MAX_MESSAGES: int(20),
  LLM_MICROBATCH_MAX_WAIT_MS: int(3000),
  LLM_MAX_INPUT_TOKENS_PER_CALL: int(8000),
  LLM_MAX_OUTPUT_TOKENS_PER_CALL: int(4096),
  LLM_CONCURRENCY: int(2),
  LLM_HTTP_TIMEOUT_MS: int(120_000),
  LLM_MAX_NETWORK_RETRIES: int(2),
  LLM_MAX_SCHEMA_REPAIRS: int(1),
  // Optional per-million-token prices for cost accounting (USD). When absent the
  // call/token caps still apply and cost is recorded as unknown.
  NEBIUS_PRICE_JSON: optStr,
  // Web search for concept maps (Tavily). Without a key, concept maps use the chat alone.
  TAVILY_API_KEY: optStr,
  STUDY_MAP_MAX_SEARCHES: int(4),
});

export type LlmConfig = z.infer<typeof llmSchema>;
export const loadLlmConfig = (env: Env = process.env): LlmConfig => llmSchema.parse(env);

const waSchema = z.object({
  WHATSAPP_AUTH_ENCRYPTION_KEY: optStr,
  WHATSAPP_INITIAL_SYNC_MODE: z.enum(['available_history', 'new_only']).default('available_history'),
  WHATSAPP_HISTORY_MAX_MESSAGES_PER_CHAT: int(10_000),
  WHATSAPP_PRESELECTION_BUFFER_MIB: int(32),
  WHATSAPP_PRESELECTION_BUFFER_TTL_SECONDS: int(300),
  WHATSAPP_MARK_ONLINE_ON_CONNECT: bool(false),
  // opened_chat_images: images in opened chats download right away so the vision model can read them;
  // video, voice and documents (and everything in on_demand mode) download only when the owner asks.
  MEDIA_DOWNLOAD_MODE: z.enum(['on_demand', 'opened_chat_images']).default('opened_chat_images'),
  MAX_ATTACHMENT_MIB: int(50),
  MAX_MEDIA_CACHE_MIB: int(500),
});
export type WhatsAppConfig = z.infer<typeof waSchema>;
export function loadWhatsAppConfig(env: Env = process.env): WhatsAppConfig {
  const cfg = waSchema.parse(env);
  if (cfg.WHATSAPP_MARK_ONLINE_ON_CONNECT) throw new Error('WHATSAPP_MARK_ONLINE_ON_CONNECT must remain false');
  return cfg;
}

const storageSchema = z.object({
  STORAGE_DRIVER: z.enum(['s3', 'local']).default('local'),
  LOCAL_STORAGE_DIR: z.string().default('.data/objects'),
  S3_ENDPOINT: optStr,
  S3_REGION: optStr,
  S3_BUCKET: optStr,
  S3_ACCESS_KEY_ID: optStr,
  S3_SECRET_ACCESS_KEY: optStr,
});
export type StorageConfig = z.infer<typeof storageSchema>;
export const loadStorageConfig = (env: Env = process.env): StorageConfig => storageSchema.parse(env);
