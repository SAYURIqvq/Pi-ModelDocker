import test from 'node:test';
import assert from 'node:assert/strict';
import { PiModelDocker } from '../src/index.js';
import { PiAdapter } from '../src/adapters/pi.js';
import { config, setup, request, server, chatSse } from './helpers.js';

function piConfig(url: string) {
  const doc = config(url); doc.providers[0]!.engine = 'pi-ai';
  Object.assign(doc.models[0]!, { stream: true, contextWindow: 32000, maxOutputTokens: 1024 }); return doc;
}
test('actual pinned pi-ai runtime bridges custom Chat Completions, images and key', async () => {
  let body: any, auth: any;
  const app = await server((b, req, res) => { body = b; auth = req.headers.authorization; chatSse(res, 'pi bridge'); });
  const { store, registry, credentials } = setup(piConfig(app.url));
  try {
    const client = new PiModelDocker(registry, credentials, { 'pi-ai': new PiAdapter() });
    const result = await client.chat({ ...request, messages: [{ role: 'user', content: [
      { type: 'text', text: 'hello' }, { type: 'image', mimeType: 'image/png', data: 'AQIDBA==' },
    ] }] });
    assert.equal(result.text, 'pi bridge'); assert.equal(auth, 'Bearer fake-key-a');
    assert.equal(body.model, 'model-a'); assert.equal(body.stream, true);
    assert.ok(JSON.stringify(body.messages).includes('data:image/png;base64,AQIDBA=='));
    assert.equal(result.usage?.totalTokens, 7);
  } finally { store.close(); await app.close(); }
});
test('pi HTTP errors preserve safe status and do not leak provider bodies', async () => {
  const app = await server((_b, _q, res) => { res.statusCode = 401; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: { message: 'fake-key-a should not leak' } })); });
  const { store, registry, credentials } = setup(piConfig(app.url));
  try {
    await assert.rejects(new PiModelDocker(registry, credentials, { 'pi-ai': new PiAdapter() }).chat(request),
      (e: any) => e.code === 'auth' && e.status === 401 && !e.message.includes('fake-key'));
  } finally { store.close(); await app.close(); }
});
test('pi native Anthropic adapter is wired to configured endpoint and normalized events', async () => {
  let path: string | undefined; let key: unknown;
  const app = await server((_b, req, res) => {
    path = req.url; key = req.headers['x-api-key']; res.setHeader('content-type', 'text/event-stream');
    const events = [
      { type: 'message_start', message: { id: 'msg_x', type: 'message', role: 'assistant', model: 'model-a', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'native anthropic' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ];
    res.end(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
  });
  const doc = piConfig(app.url.replace('/v1', '')); doc.providers[0]!.protocol = 'anthropic_messages';
  const { store, registry, credentials } = setup(doc);
  try {
    const result = await new PiModelDocker(registry, credentials, { 'pi-ai': new PiAdapter() }).chat(request);
    assert.equal(result.text, 'native anthropic'); assert.equal(new URL(path!, 'http://test').pathname, '/v1/messages'); assert.equal(key, 'fake-key-a');
  } finally { store.close(); await app.close(); }
});
test('pi Google adapter uses SDK transport with image input and normalized output', async () => {
  let body: any; let path = ''; let key: unknown;
  const app = await server((b, req, res) => {
    body = b; path = req.url!; key = req.headers['x-goog-api-key'];
    res.setHeader('content-type', 'text/event-stream');
    res.end(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'native google' }] }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 } })}\n\n`);
  });
  const doc = piConfig(app.url); doc.providers[0]!.protocol = 'google_generative_ai';
  const { store, registry, credentials } = setup(doc);
  try {
    const result = await new PiModelDocker(registry, credentials, { 'pi-ai': new PiAdapter() }).chat({ ...request, messages: [{ role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: 'AQIDBA==' }, { type: 'text', text: 'describe' }] }] });
    assert.equal(result.text, 'native google'); assert.equal(key, 'fake-key-a'); assert.ok(path.includes('model-a:streamGenerateContent'));
    assert.ok(JSON.stringify(body).includes('AQIDBA==')); assert.equal(result.usage?.totalTokens, 6);
  } finally { store.close(); await app.close(); }
});
test('pi Responses uses registered custom model and protocol', async () => {
  const app = await server((_b, req, res) => {
    assert.equal(req.url, '/v1/responses'); res.setHeader('content-type', 'text/event-stream');
    const message = { type: 'message', id: 'msg_1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'pi responses', annotations: [] }] };
    const events = [
      { type: 'response.created', response: { id: 'resp_1', model: 'model-a', status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } },
      { type: 'response.content_part.added', item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'pi responses' },
      { type: 'response.output_text.done', item_id: 'msg_1', output_index: 0, content_index: 0, text: 'pi responses' },
      { type: 'response.output_item.done', output_index: 0, item: message },
      { type: 'response.completed', response: { id: 'resp_1', model: 'model-a', status: 'completed', output: [message], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } },
    ];
    res.end(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''));
  });
  const doc = piConfig(app.url); doc.providers[0]!.protocol = 'responses';
  const { store, registry, credentials } = setup(doc);
  try { const result = await new PiModelDocker(registry, credentials, { 'pi-ai': new PiAdapter() }).chat(request); assert.equal(result.text, 'pi responses'); }
  finally { store.close(); await app.close(); }
});
