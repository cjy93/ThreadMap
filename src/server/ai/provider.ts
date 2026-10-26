// Model providers. NebiusModelProvider calls Token Factory's OpenAI-compatible
// API; FixtureModelProvider answers deterministically from the fixture
// manifest for development and can never satisfy a live-inference gate.
import OpenAI from 'openai';
import type { LlmConfig } from '../../lib/config';

export type Role = 'reasoning' | 'fast' | 'balanced';

export interface FixtureHints {
  refs?: Record<string, string>; // local ref -> native message id
  units?: Record<string, string[]>; // unit key -> native ids
  topicPaths?: Record<string, string>; // existing topic id -> fixture path
  chatJid?: string;
}

export interface CompletionRequest {
  role: Role;
  operation: string;
  system: string;
  user: string;
  maxOutputTokens: number;
  schemaName: string;
  jsonSchema?: Record<string, unknown>;
  fixtureHints?: FixtureHints;
  /** false disables the model's reasoning trace; undefined uses the role default. */
  thinking?: boolean;
}

export interface CompletionResult {
  text: string;
  modelId: string;
  fallback: boolean;
  usage: { input: number | null; output: number | null; reasoning: number | null };
  /** The provider stopped at max_tokens, so the text is incomplete. */
  truncated?: boolean;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: 'rate_limit' | 'timeout' | 'unavailable' | 'auth' | 'bad_request' | 'not_configured',
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface ModelProvider {
  readonly kind: 'nebius' | 'fixture';
  modelIdFor(role: Role): string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

/** Remove reasoning traces and extract the first top-level JSON value. */
export function extractJson(text: string): string {
  const noThink = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fenced = noThink.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : noThink;
  const start = body.search(/[[{]/);
  if (start < 0) return body.trim();
  const open = body[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return body.slice(start, i + 1);
  }
  return body.slice(start).trim();
}

export class NebiusModelProvider implements ModelProvider {
  readonly kind = 'nebius' as const;
  private client: OpenAI;
  /** Roles whose model passed a JSON-schema capability check. */
  readonly jsonSchemaRoles = new Set<Role>();
  /** Roles whose reasoning trace is off by default (Nano otherwise spends the whole output budget on it). */
  readonly thinkingOffRoles: Set<Role>;

  constructor(private cfg: LlmConfig) {
    if (!cfg.NEBIUS_API_KEY) throw new ProviderError('NEBIUS_API_KEY is not configured', 'not_configured', false);
    this.client = new OpenAI({
      apiKey: cfg.NEBIUS_API_KEY,
      baseURL: cfg.NEBIUS_BASE_URL,
      timeout: cfg.LLM_HTTP_TIMEOUT_MS,
      maxRetries: 0, // retries are bounded and accounted for by the router
    });
    this.thinkingOffRoles = new Set(cfg.NEBIUS_THINKING_OFF_ROLES.split(',').filter(Boolean) as Role[]);
  }

  modelIdFor(role: Role): string {
    const id = role === 'reasoning' ? this.cfg.NEBIUS_MODEL_REASONING : role === 'fast' ? this.cfg.NEBIUS_MODEL_FAST : this.cfg.NEBIUS_MODEL_BALANCED;
    if (!id) throw new ProviderError(`model for role ${role} is not configured`, 'not_configured', false);
    return id;
  }

  async listModels(): Promise<string[]> {
    const out: string[] = [];
    for await (const m of this.client.models.list()) out.push(m.id);
    return out;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    let modelId = this.modelIdFor(req.role);
    let fallback = false;
    try {
      return await this.call(modelId, req, fallback);
    } catch (e) {
      const err = e as ProviderError;
      if (req.role === 'reasoning' && this.cfg.ALLOW_REASONING_FALLBACK && this.cfg.NEBIUS_MODEL_REASONING_FALLBACK && err.kind === 'unavailable') {
        modelId = this.cfg.NEBIUS_MODEL_REASONING_FALLBACK;
        fallback = true;
        return this.call(modelId, req, fallback);
      }
      throw e;
    }
  }

  private async call(modelId: string, req: CompletionRequest, fallback: boolean): Promise<CompletionResult> {
    const responseFormat =
      req.jsonSchema && this.jsonSchemaRoles.has(req.role)
        ? { type: 'json_schema' as const, json_schema: { name: req.schemaName, schema: req.jsonSchema, strict: false } }
        : { type: 'json_object' as const };
    const thinkingOff = req.thinking === false || (req.thinking === undefined && this.thinkingOffRoles.has(req.role));
    try {
      const r = await this.client.chat.completions.create({
        model: modelId,
        temperature: 0.2,
        max_tokens: req.maxOutputTokens,
        response_format: responseFormat,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
        // Nemotron chat-template switch; Token Factory honours it (reasoning output drops to 0).
        ...(thinkingOff ? { chat_template_kwargs: { enable_thinking: false } } : {}),
      } as OpenAI.ChatCompletionCreateParamsNonStreaming);
      const choice = r.choices[0];
      const usage = r.usage as (OpenAI.CompletionUsage & { completion_tokens_details?: { reasoning_tokens?: number } }) | undefined;
      return {
        text: choice?.message?.content ?? '',
        modelId: r.model ?? modelId,
        fallback,
        truncated: choice?.finish_reason === 'length',
        usage: {
          input: usage?.prompt_tokens ?? null,
          output: usage?.completion_tokens ?? null,
          reasoning: usage?.completion_tokens_details?.reasoning_tokens ?? null,
        },
      };
    } catch (e) {
      throw mapOpenAiError(e);
    }
  }
}

export function mapOpenAiError(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  const status = (e as { status?: number }).status;
  const name = (e as { name?: string }).name ?? '';
  if (status === 429) return new ProviderError('provider rate limit', 'rate_limit', true);
  if (status === 401 || status === 403) return new ProviderError('provider authentication failed', 'auth', false);
  if (status === 404) return new ProviderError('model not found or not enabled', 'unavailable', false);
  if (status === 400 || status === 422) return new ProviderError('provider rejected the request', 'bad_request', false);
  if (status && status >= 500) return new ProviderError(`provider error ${status}`, 'unavailable', true);
  if (/timeout/i.test(name) || /timeout/i.test(String((e as Error).message))) return new ProviderError('provider timeout', 'timeout', true);
  return new ProviderError('provider connection failed', 'unavailable', true);
}
