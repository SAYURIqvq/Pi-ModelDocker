import type { Context, Model, Api, ProviderStreams, Usage as PiUsage } from '@earendil-works/pi-ai';
import { PiModelDockerError, type Adapter, type AdapterEvent, type RequestSnapshot } from '../contracts.js';
import { httpError } from '../errors.js';

const apiNames = {
  chat_completions: 'openai-completions', responses: 'openai-responses',
  anthropic_messages: 'anthropic-messages', google_generative_ai: 'google-generative-ai',
} as const;
const emptyUsage: PiUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** Optional pi-ai bridge. Importing PiModelDocker's core never imports the pi runtime. */
export class PiAdapter implements Adapter {
  constructor(private readonly fetcher: typeof fetch = globalThis.fetch) {}
  async *run(s: RequestSnapshot): AsyncGenerator<AdapterEvent> {
    if (!s.model.stream) throw new PiModelDockerError('unsupported_protocol', 'pi-ai requires upstream streaming. Use the HTTP adapter for stream=false.');
    if (!s.apiKey) throw new PiModelDockerError('credential_missing', 'The pi-ai adapter requires an explicit configured credential.');
    const { createModels, createProvider, envApiKeyAuth } = await import('@earendil-works/pi-ai');
    let implementation: ProviderStreams;
    switch (s.protocol) {
      case 'chat_completions': implementation = await import('@earendil-works/pi-ai/api/openai-completions') as ProviderStreams; break;
      case 'responses': implementation = await import('@earendil-works/pi-ai/api/openai-responses') as ProviderStreams; break;
      case 'anthropic_messages': implementation = await import('@earendil-works/pi-ai/api/anthropic-messages') as ProviderStreams; break;
      case 'google_generative_ai': implementation = await import('@earendil-works/pi-ai/api/google-generative-ai') as ProviderStreams; break;
    }
    const model: Model<Api> = { id: s.model.modelId, name: s.model.name, provider: s.provider.id,
      api: apiNames[s.protocol], baseUrl: s.provider.baseUrl,
      input: s.model.capabilities.vision ? ['text', 'image'] : ['text'], reasoning: false,
      contextWindow: s.model.contextWindow!, maxTokens: s.model.maxOutputTokens!,
      // Required SDK metadata only. PiModelDocker deliberately does not publish estimated costs.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const collection = createModels();
    collection.setProvider(createProvider({ id: s.provider.id, name: s.provider.name,
      auth: { apiKey: envApiKeyAuth(s.provider.name, []) }, models: [model], api: implementation }));
    const context: Context = { systemPrompt: s.request.systemPrompt,
      messages: s.request.messages.map(message => message.role === 'user'
        ? { role: 'user' as const, content: message.content, timestamp: Date.now() }
        : { role: 'assistant' as const, content: message.content.filter(p => p.type === 'text'),
          api: model.api, provider: model.provider, model: model.id, usage: structuredClone(emptyUsage),
          stopReason: 'stop' as const, timestamp: Date.now() }) };
    let status: number | undefined;
    const guardedFetch: typeof fetch = async (input, init) => {
      const response = await this.fetcher(input, { ...init, redirect: 'error', signal: s.signal });
      status = response.status; return response;
    };
    s.signal.throwIfAborted();
    if (s.protocol === 'google_generative_ai' && this.fetcher !== globalThis.fetch) {
      throw new PiModelDockerError('unsupported_protocol', 'The pinned Google SDK adapter does not support an injected fetch implementation.');
    }
    const stream = collection.stream(model, context, {
      apiKey: s.apiKey, signal: s.signal, timeoutMs: s.model.timeoutMs ?? s.provider.timeoutMs,
      maxRetries: 0, maxRetryDelayMs: 0,
      ...(s.protocol === 'google_generative_ai' ? {} : { fetch: guardedFetch }),
      temperature: s.model.temperature, maxTokens: s.model.maxOutputTokens ?? 4096,
    });
    for await (const event of stream) {
      s.signal.throwIfAborted();
      if (event.type === 'text_delta') yield { type: 'text', text: event.delta };
      else if (event.type === 'error') {
        if (status && status >= 400) throw httpError(status);
        throw new PiModelDockerError('invalid_response', 'pi-ai could not complete this request. Check the configured protocol and model.');
      } else if (event.type === 'done') {
        const u = event.message.usage;
        yield { type: 'done', finishReason: event.reason,
          usage: u.totalTokens || u.input || u.output ? { inputTokens: u.input, outputTokens: u.output, totalTokens: u.totalTokens } : undefined };
        return;
      }
    }
    throw new PiModelDockerError('invalid_response', 'pi-ai ended without a completion event.');
  }
}
