import { PiModelDockerError, type Adapter, type AdapterEvent, type RequestSnapshot, type Usage } from '../contracts.js';
import { httpError } from '../errors.js';
import { readSse } from './sse.js';

type Json = Record<string, any>;
function json(value: string): Json {
  try { const parsed = JSON.parse(value); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed; }
  catch { /* No raw upstream payload in errors. */ }
  throw new PiModelDockerError('invalid_response', 'Provider returned invalid JSON.');
}
function usage(value: Json | undefined): Usage | undefined {
  if (!value) return undefined;
  const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
  const result = { inputTokens: finite(value.prompt_tokens ?? value.input_tokens),
    outputTokens: finite(value.completion_tokens ?? value.output_tokens), totalTokens: finite(value.total_tokens) };
  return Object.values(result).some(v => v !== undefined) ? result : undefined;
}
function responseText(value: Json): string {
  if (typeof value.output_text === 'string') return value.output_text;
  return Array.isArray(value.output) ? value.output.flatMap((item: Json) =>
    Array.isArray(item.content) ? item.content.filter((p: Json) => p.type === 'output_text' && typeof p.text === 'string').map((p: Json) => p.text) : []).join('') : '';
}
function payload(s: RequestSnapshot): Json {
  const responses = s.protocol === 'responses';
  const mapContent = (role: string, content: RequestSnapshot['request']['messages'][number]['content']) => content.map(part => {
    if (part.type === 'text') return { type: responses ? (role === 'assistant' ? 'output_text' : 'input_text') : 'text', text: part.text };
    const url = `data:${part.mimeType};base64,${part.data}`;
    return responses ? { type: 'input_image', image_url: url } : { type: 'image_url', image_url: { url } };
  });
  const messages: Json[] = s.request.messages.map(message => ({ role: message.role, content: mapContent(message.role, message.content) }));
  const body: Json = { model: s.model.modelId, stream: s.model.stream };
  if (responses) {
    body.input = messages;
    if (s.request.systemPrompt !== undefined) body.instructions = s.request.systemPrompt;
    if (s.model.maxOutputTokens !== undefined) body.max_output_tokens = s.model.maxOutputTokens;
  } else {
    if (s.request.systemPrompt !== undefined) messages.unshift({ role: 'system', content: s.request.systemPrompt });
    body.messages = messages;
    if (s.model.maxOutputTokens !== undefined) body.max_tokens = s.model.maxOutputTokens;
  }
  if (s.model.temperature !== undefined) body.temperature = s.model.temperature;
  Object.assign(body, s.model.requestOptions);
  return body;
}
async function limitedText(response: Response): Promise<string> {
  if (!response.body) throw new PiModelDockerError('invalid_response', 'Provider returned no body.');
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let size = 0, text = '';
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 16_000_000) throw new PiModelDockerError('invalid_response', 'Response exceeded the size limit.');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export class HttpAdapter implements Adapter {
  constructor(private readonly fetcher: typeof fetch = globalThis.fetch) {}
  async *run(s: RequestSnapshot): AsyncGenerator<AdapterEvent> {
    if (!['chat_completions', 'responses'].includes(s.protocol)) throw new PiModelDockerError('unsupported_protocol', 'HTTP protocol is unsupported.');
    const suffix = s.protocol === 'responses' ? '/responses' : '/chat/completions';
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: s.model.stream ? 'text/event-stream' : 'application/json' };
    if (s.apiKey) headers.Authorization = `Bearer ${s.apiKey}`;
    const response = await this.fetcher(s.provider.baseUrl + suffix, {
      method: 'POST', headers, body: JSON.stringify(payload(s)), signal: s.signal, redirect: 'error',
    });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw httpError(response.status); }
    if (!s.model.stream) {
      const result = json(await limitedText(response));
      if (result.error || (s.protocol === 'responses' && result.status && result.status !== 'completed')) throw new PiModelDockerError('invalid_response', 'Provider did not complete the response.');
      const choice = result.choices?.[0];
      const text = s.protocol === 'responses' ? responseText(result) : choice?.message?.content;
      if (typeof text !== 'string' || !text.trim()) throw new PiModelDockerError('invalid_response', 'Provider returned no text answer.');
      yield { type: 'text', text };
      yield { type: 'done', usage: usage(result.usage), finishReason: choice?.finish_reason ?? result.status };
      return;
    }
    if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
      await response.body?.cancel().catch(() => {});
      throw new PiModelDockerError('invalid_response', 'Expected an SSE streaming response.');
    }
    let finished = false, emitted = false, finishReason: string | undefined, finalUsage: Usage | undefined;
    for await (const line of readSse(response.body)) {
      s.signal.throwIfAborted();
      if (line.trim() === '[DONE]') {
        if (s.protocol === 'responses' && !finished) throw new PiModelDockerError('invalid_response', 'Responses stream ended without response.completed.');
        finished = true; break;
      }
      const event = json(line);
      if (event.error || ['error', 'response.failed', 'response.incomplete'].includes(event.type)) throw new PiModelDockerError('invalid_response', 'Provider reported a streaming error.');
      if (s.protocol === 'responses') {
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string' && event.delta) {
          emitted = true; yield { type: 'text', text: event.delta };
        }
        if (event.type === 'response.completed') {
          if (event.response?.error || (event.response?.status && event.response.status !== 'completed')) throw new PiModelDockerError('invalid_response', 'Provider did not complete the response.');
          if (!emitted) { const text = responseText(event.response ?? {}); if (text) { emitted = true; yield { type: 'text', text }; } }
          finalUsage = usage(event.response?.usage); finishReason = 'completed'; finished = true; break;
        }
      } else {
        const choice = event.choices?.[0]; const delta = choice?.delta?.content;
        if (typeof delta === 'string' && delta) { emitted = true; yield { type: 'text', text: delta }; }
        if (typeof choice?.finish_reason === 'string') { finishReason = choice.finish_reason; finished = true; }
        if (event.usage) finalUsage = usage(event.usage);
      }
    }
    if (!finished || !emitted) throw new PiModelDockerError('invalid_response', 'Stream ended without a complete text response.');
    yield { type: 'done', usage: finalUsage, finishReason };
  }
}
