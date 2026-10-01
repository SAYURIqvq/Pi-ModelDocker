import { configSchema, PiModelDockerError, type ConfigDocument, type ModelConfig, type ProviderConfig } from './contracts.js';
import { invalid } from './errors.js';

export function normalizeBaseUrl(value: string, allowHttp: boolean): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) invalid('Base URL must not contain credentials, a query or fragment.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowHttp)) invalid('Use HTTPS, or explicitly set allowHttp for a trusted HTTP endpoint.');
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/(chat\/completions|responses)$/, '');
  return url.toString().replace(/\/+$/, '');
}
export function validateConfig(value: unknown): ConfigDocument {
  const parsed = configSchema.safeParse(value);
  if (!parsed.success) throw new PiModelDockerError('invalid_config', 'Invalid configuration shape, value or unknown field. See the configuration schema.');
  const config = parsed.data;
  const providers = new Map<string, ProviderConfig>();
  for (const p of config.providers) {
    if (providers.has(p.id)) invalid('Duplicate provider ID.');
    p.baseUrl = normalizeBaseUrl(p.baseUrl, p.allowHttp);
    providers.set(p.id, p);
  }
  const models = new Map<string, ModelConfig>();
  for (const m of config.models) {
    if (models.has(m.routeId)) invalid('Duplicate route ID.');
    const provider = providers.get(m.providerId);
    if (!provider) invalid('Model references a missing provider.');
    const protocol = m.protocol ?? provider.protocol;
    if (provider.engine === 'http' && !['chat_completions', 'responses'].includes(protocol)) invalid('Native HTTP adapter supports Chat Completions and Responses only.');
    if (provider.engine === 'pi-ai' && (!provider.credentialRef || !m.contextWindow || !m.maxOutputTokens)) invalid('pi-ai models require credentialRef, contextWindow and maxOutputTokens.');
    if (provider.engine === 'pi-ai' && !m.stream) invalid('pi-ai uses upstream streaming. Use engine=http for a true non-streaming request.');
    if (provider.engine === 'pi-ai' && Object.keys(m.requestOptions).length) invalid('requestOptions are supported by the direct HTTP adapter only.');
    if (protocol === 'responses' && m.requestOptions.reasoning_effort) invalid('reasoning_effort is a Chat Completions option.');
    models.set(m.routeId, m);
  }
  for (const model of models.values()) for (const target of model.fallbackRouteIds) {
    if (target === model.routeId || !models.has(target)) invalid('Fallback must reference another existing route.');
  }
  if (config.selectedRouteId !== null && !models.has(config.selectedRouteId)) invalid('Selected route does not exist.');
  return config;
}
