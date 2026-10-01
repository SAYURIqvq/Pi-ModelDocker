import { PiModelDockerError } from './contracts.js';
export function httpError(status: number): PiModelDockerError {
  const mapping = {
    401: ['auth', 'API key was rejected.'], 403: ['auth', 'Provider denied access to this model.'],
    402: ['payment_required', 'Provider reports insufficient credit.'],
    404: ['not_found', 'Endpoint or upstream model was not found.'],
    429: ['rate_limited', 'Provider rate limit was reached.'],
  } as const;
  const item = mapping[status as keyof typeof mapping];
  return item ? new PiModelDockerError(item[0], item[1], status)
    : new PiModelDockerError('http_error', `Provider request failed (HTTP ${status}).`, status);
}
export function safeError(error: unknown, signal?: AbortSignal): PiModelDockerError {
  if (signal?.aborted) return signal.reason instanceof PiModelDockerError ? signal.reason
    : new PiModelDockerError('cancelled', 'Request cancelled.');
  if (error instanceof PiModelDockerError) return error;
  // Never serialize SDK messages, response bodies, request URLs, headers or causes.
  return new PiModelDockerError('network', 'Request failed. Check the provider connection and configuration.');
}
export function invalid(message: string): never { throw new PiModelDockerError('invalid_config', message); }
