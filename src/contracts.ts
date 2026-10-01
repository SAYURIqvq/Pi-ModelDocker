import { z } from 'zod';

export const protocolSchema = z.enum(['chat_completions', 'responses', 'anthropic_messages', 'google_generative_ai']);
export type Protocol = z.infer<typeof protocolSchema>;
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/);
const timeout = z.number().int().min(100).max(600_000);
export const providerSchema = z.object({
  id, name: z.string().trim().min(1).max(120),
  baseUrl: z.string().url(), protocol: protocolSchema,
  engine: z.enum(['http', 'pi-ai']).default('http'),
  credentialRef: z.string().regex(/^(env|memory):[a-zA-Z0-9_.-]+$/).optional(),
  enabled: z.boolean().default(true), timeoutMs: timeout.default(120_000),
  allowHttp: z.boolean().default(false),
}).strict();
export const modelSchema = z.object({
  routeId: id, providerId: id,
  name: z.string().trim().min(1).max(120), modelId: z.string().trim().min(1).max(256),
  enabled: z.boolean().default(true),
  capabilities: z.object({ text: z.boolean().default(true), vision: z.boolean().default(false) }).strict().default({}),
  stream: z.boolean().default(true),
  protocol: protocolSchema.optional(), timeoutMs: timeout.optional(),
  temperature: z.number().min(0).max(2).optional(), maxOutputTokens: z.number().int().positive().max(1_000_000).optional(),
  contextWindow: z.number().int().positive().optional(),
  requestOptions: z.object({
    thinking: z.object({ type: z.literal('disabled') }).strict().optional(),
    reasoning_effort: z.enum(['none', 'minimal', 'low', 'medium', 'high']).optional(),
  }).strict().default({}),
  fallbackRouteIds: z.array(id).max(1).default([]),
}).strict();
export const configSchema = z.object({
  schemaVersion: z.literal(1), providers: z.array(providerSchema), models: z.array(modelSchema),
  selectedRouteId: id.nullable().default(null),
}).strict();
export type ProviderConfig = z.infer<typeof providerSchema>;
export type ModelConfig = z.infer<typeof modelSchema>;
export type ProviderInput = z.input<typeof providerSchema>;
export type ModelInput = z.input<typeof modelSchema>;
export type ConfigDocument = z.infer<typeof configSchema>;
export type ConfigInput = z.input<typeof configSchema>;

const partSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
  z.object({ type: z.literal('image'), mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
    data: z.string().min(4).max(28_000_000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) }).strict(),
]);
export const inputSchema = z.object({
  routeId: id, systemPrompt: z.string().optional(),
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']),
    content: z.array(partSchema).min(1) }).strict()).min(1).max(1000),
}).strict();
export type ChatInput = z.infer<typeof inputSchema> & { signal?: AbortSignal };
export type ChatMessage = z.infer<typeof inputSchema>['messages'][number];
export interface Usage { inputTokens?: number; outputTokens?: number; totalTokens?: number }
export interface ChatResult {
  requestId: string; requestedRouteId: string; routeId: string; providerId: string; modelId: string;
  text: string; usage?: Usage; finishReason?: string;
}
export type ChatEvent =
  | { type: 'started'; requestId: string; routeId: string; catalogRevision: number }
  | { type: 'text_delta'; requestId: string; routeId: string; delta: string }
  | { type: 'fallback'; requestId: string; fromRouteId: string; toRouteId: string; reason: 'payment_required' }
  | { type: 'completed'; result: ChatResult }
  | { type: 'failed'; requestId: string; code: ErrorCode; message: string; status?: number }
  | { type: 'cancelled'; requestId: string };
export type ErrorCode = 'invalid_config' | 'conflict' | 'not_found' | 'unavailable' | 'credential_missing'
  | 'unsupported_capability' | 'unsupported_protocol' | 'auth' | 'payment_required' | 'rate_limited'
  | 'http_error' | 'network' | 'timeout' | 'cancelled' | 'invalid_response' | 'adapter_missing';
export class PiModelDockerError extends Error {
  constructor(public readonly code: ErrorCode, message: string, public readonly status?: number) {
    super(message); this.name = 'PiModelDockerError';
  }
}
export interface RequestSnapshot {
  provider: ProviderConfig; model: ModelConfig; protocol: Protocol;
  request: Omit<ChatInput, 'signal'>; apiKey?: string; signal: AbortSignal;
}
export type AdapterEvent = { type: 'text'; text: string }
  | { type: 'done'; usage?: Usage; finishReason?: string };
export interface Adapter { run(snapshot: RequestSnapshot): AsyncIterable<AdapterEvent> }
