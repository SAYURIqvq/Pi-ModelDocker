import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Credentials, Registry, SqliteStore, PiModelDocker, type ConfigInput } from '../src/index.js';

export const request = { routeId: 'vision', messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hello' }] }] };
export function config(baseUrl = 'https://example.invalid/v1'): ConfigInput {
  return { schemaVersion: 1, providers: [{ id: 'a', name: 'A', baseUrl,
    protocol: 'chat_completions', credentialRef: 'memory:a', allowHttp: baseUrl.startsWith('http:') }],
    models: [{ routeId: 'vision', providerId: 'a', name: 'Vision', modelId: 'model-a', capabilities: { vision: true }, stream: false }] };
}
export function setup(input: ConfigInput = config()) {
  const store = new SqliteStore(); const registry = new Registry(store); registry.importConfig(input);
  const credentials = new Credentials({}); credentials.set('memory:a', 'fake-key-a');
  return { store, registry, credentials, client: new PiModelDocker(registry, credentials) };
}
export async function server(handler: (body: any, req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const errors: unknown[] = [];
  const app = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      await handler(body, req, res);
    } catch (error) { errors.push(error); res.statusCode = 500; res.end('{}'); }
  });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const address = app.address(); if (!address || typeof address === 'string') throw new Error('No address');
  return { url: `http://127.0.0.1:${address.port}/v1`, errors,
    async close() { app.closeAllConnections(); await new Promise<void>(resolve => app.close(() => resolve())); } };
}
export function reply(res: ServerResponse, text = 'answer') {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }));
}
export function chatSse(res: ServerResponse, text = '你好') {
  res.setHeader('content-type', 'text/event-stream');
  res.end(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'model-a', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
}
