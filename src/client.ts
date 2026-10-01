import { randomUUID } from 'node:crypto';
import { inputSchema, PiModelDockerError, type Adapter, type ChatEvent, type ChatInput, type ChatResult, type RequestSnapshot } from './contracts.js';
import type { CredentialResolver } from './credentials.js';
import { safeError } from './errors.js';
import { HttpAdapter } from './adapters/http.js';
import { Registry } from './registry.js';

export class PiModelDocker {
  private readonly adapters: Record<string, Adapter>;
  constructor(readonly registry: Registry, private readonly credentials: CredentialResolver,
    adapters: Record<string, Adapter> = {}) { this.adapters = { http: new HttpAdapter(), ...adapters }; }

  /** Full response. Provider errors throw a sanitized PiModelDockerError. */
  async chat(input: ChatInput): Promise<ChatResult> {
    for await (const event of this.stream(input)) {
      if (event.type === 'completed') return event.result;
      if (event.type === 'failed') throw new PiModelDockerError(event.code, event.message, event.status);
      if (event.type === 'cancelled') throw new PiModelDockerError('cancelled', 'Request cancelled.');
    }
    throw new PiModelDockerError('invalid_response', 'No completion event was received.');
  }

  /** One terminal event. Breaking iteration also aborts the underlying HTTP/SDK call. */
  async *stream(input: ChatInput): AsyncGenerator<ChatEvent> {
    const requestId = randomUUID(); const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => controller.abort(new PiModelDockerError('cancelled', 'Request cancelled.'));
    const external = input?.signal instanceof AbortSignal ? input.signal : undefined;
    external?.addEventListener('abort', cancel, { once: true });
    if (external?.aborted) cancel();
    const abortPromise = new Promise<never>((_, reject) => {
      if (controller.signal.aborted) reject(controller.signal.reason);
      else controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    });
    // The deadline promise can reject while the generator is paused between yields.
    void abortPromise.catch(() => {});
    try {
      controller.signal.throwIfAborted();
      if (!input || typeof input !== 'object' || (input.signal !== undefined && !external)) throw new PiModelDockerError('invalid_config', 'Invalid chat input or cancellation signal.');
      const { signal: _, ...raw } = input;
      const parsed = inputSchema.safeParse(raw);
      if (!parsed.success) throw new PiModelDockerError('invalid_config', 'Invalid chat input. Use text/image message parts.');
      const request = parsed.data;
      if (request.messages.some(m => m.role === 'assistant' && m.content.some(p => p.type === 'image'))) throw new PiModelDockerError('unsupported_capability', 'Images are supported in user messages only.');
      const { document, revision } = this.registry.snapshot();
      const model = document.models.find(m => m.routeId === request.routeId);
      if (!model) throw new PiModelDockerError('not_found', 'Route not found.');
      const routes = [model, ...model.fallbackRouteIds.map(id => document.models.find(m => m.routeId === id)!)];
      const candidates = routes.map(m => ({ model: m, provider: document.providers.find(p => p.id === m.providerId)! }));
      const timeoutMs = model.timeoutMs ?? candidates[0]!.provider.timeoutMs;
      timer = setTimeout(() => controller.abort(new PiModelDockerError('timeout', 'Request deadline exceeded.')), timeoutMs);
      const keyTasks = candidates.map(async c => {
        if (!c.provider.credentialRef) return undefined;
        try { return await this.credentials.resolve(c.provider.credentialRef); }
        catch { return undefined; }
      });
      const keys = await Promise.race([Promise.all(keyTasks), abortPromise]);
      const hasImages = request.messages.some(m => m.content.some(p => p.type === 'image'));
      const hasText = !!request.systemPrompt || request.messages.some(m => m.content.some(p => p.type === 'text' && p.text));
      yield { type: 'started', requestId, routeId: model.routeId, catalogRevision: revision };
      let previous: string | undefined;
      for (let index = 0; index < candidates.length; index++) {
        controller.signal.throwIfAborted();
        const candidate = candidates[index]!;
        if (!candidate.provider.enabled || !candidate.model.enabled) throw new PiModelDockerError('unavailable', 'The model or provider is disabled.');
        if (hasImages && !candidate.model.capabilities.vision || hasText && !candidate.model.capabilities.text) throw new PiModelDockerError('unsupported_capability', 'The selected model does not support this input.');
        const apiKey = keys[index];
        if (candidate.provider.credentialRef && !apiKey) throw new PiModelDockerError('credential_missing', 'The configured credential is unavailable.');
        const adapter = this.adapters[candidate.provider.engine];
        if (!adapter) throw new PiModelDockerError('adapter_missing', 'Install and register the requested adapter.');
        if (previous) yield { type: 'fallback', requestId, fromRouteId: previous, toRouteId: candidate.model.routeId, reason: 'payment_required' };
        const snapshot: RequestSnapshot = { ...candidate, protocol: candidate.model.protocol ?? candidate.provider.protocol, request, apiKey, signal: controller.signal };
        let text = '', finished = false;
        const iterator = adapter.run(snapshot)[Symbol.asyncIterator]();
        try {
          for (;;) {
            const step = await Promise.race([iterator.next(), abortPromise]);
            controller.signal.throwIfAborted();
            if (step.done) break;
            const event = step.value;
            if (event.type === 'text') {
              text += event.text;
              if (text.length > 16_000_000) throw new PiModelDockerError('invalid_response', 'Answer exceeded the size limit.');
              if (event.text) yield { type: 'text_delta', requestId, routeId: candidate.model.routeId, delta: event.text };
            } else {
              if (!text.trim()) throw new PiModelDockerError('invalid_response', 'Provider returned no text answer.');
              finished = true;
              yield { type: 'completed', result: { requestId, requestedRouteId: model.routeId,
                routeId: candidate.model.routeId, providerId: candidate.provider.id, modelId: candidate.model.modelId,
                text, usage: event.usage, finishReason: event.finishReason } };
              return;
            }
          }
          if (!finished) throw new PiModelDockerError('invalid_response', 'Adapter did not complete the answer.');
        } catch (error) {
          const safe = safeError(error, controller.signal);
          if (safe.code === 'payment_required' && index === 0 && !text && candidates.length > 1) { previous = candidate.model.routeId; continue; }
          throw safe;
        } finally {
          // A misbehaving external adapter must not make cancellation wait forever.
          void Promise.resolve(iterator.return?.()).catch(() => {});
        }
      }
    } catch (error) {
      const safe = safeError(error, controller.signal);
      if (safe.code === 'cancelled') yield { type: 'cancelled', requestId };
      else yield { type: 'failed', requestId, code: safe.code, message: safe.message, status: safe.status };
    } finally {
      if (timer) clearTimeout(timer);
      external?.removeEventListener('abort', cancel);
      controller.abort(new PiModelDockerError('cancelled', 'Request ended.'));
    }
  }
}
