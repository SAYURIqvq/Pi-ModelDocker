import test from 'node:test';
import assert from 'node:assert/strict';
import { config, setup, request, server, reply, chatSse } from './helpers.js';
import { readSse } from '../src/adapters/sse.js';

test('true non-streaming Chat Completions preserves prompt, history and MIME types', async () => {
  let observed: any;
  const app = await server((body, req, res) => { observed = { body, path: req.url, auth: req.headers.authorization }; reply(res); });
  const { store, client } = setup(config(app.url));
  try {
    const result = await client.chat({ ...request, systemPrompt: 'Original prompt', messages: [
      { role: 'assistant', content: [{ type: 'text', text: 'History' }] },
      { role: 'user', content: [{ type: 'text', text: 'Question' }, { type: 'image', mimeType: 'image/png', data: 'AQIDBA==' }] },
    ] });
    assert.equal(observed.body.stream, false); assert.equal(observed.body.model, 'model-a');
    assert.equal(observed.path, '/v1/chat/completions'); assert.equal(observed.auth, 'Bearer fake-key-a');
    assert.equal(observed.body.messages[0].content, 'Original prompt');
    assert.equal(observed.body.messages[2].content[1].image_url.url, 'data:image/png;base64,AQIDBA==');
    assert.equal(result.text, 'answer'); assert.equal(result.usage?.totalTokens, 7); assert.equal(result.finishReason, 'stop');
  } finally { store.close(); await app.close(); }
});
test('Chat Completions SSE outputs exact text and one terminal event', async () => {
  const app = await server((_body, _req, res) => chatSse(res)); const doc = config(app.url); doc.models[0]!.stream = true;
  const { store, client } = setup(doc);
  try {
    const events = await Array.fromAsync(client.stream(request));
    assert.deepEqual(events.filter(e => e.type === 'text_delta').map(e => e.delta), ['你好']);
    assert.equal(events.filter(e => e.type === 'completed').length, 1);
  } finally { store.close(); await app.close(); }
});
test('SSE decoder handles one-byte UTF-8 chunks, CRLF split, comments and multi-line data', async () => {
  const bytes = new TextEncoder().encode(': heartbeat\r\ndata: 你\r\ndata: 好\r\n\r\ndata: [DONE]\n\n');
  const body = new ReadableStream({ start(controller) { for (const b of bytes) controller.enqueue(Uint8Array.of(b)); controller.close(); } });
  assert.deepEqual(await Array.fromAsync(readSse(body)), ['你\n好', '[DONE]']);
});
for (const stream of [false, true]) test(`Responses protocol supports stream=${stream}`, async () => {
  let body: any; const app = await server((b, req, res) => {
    body = b; assert.equal(req.url, '/v1/responses');
    const result = { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'yes' }] }], usage: { input_tokens: 3, output_tokens: 1 } };
    if (!stream) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(result)); }
    else { res.setHeader('content-type', 'text/event-stream'); res.end(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'yes' })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: result })}\n\n`); }
  });
  const doc = config(app.url); doc.providers[0]!.protocol = 'responses'; doc.models[0]!.stream = stream;
  const { store, client } = setup(doc);
  try {
    const result = await client.chat({ ...request, systemPrompt: 'keep' });
    assert.equal(result.text, 'yes'); assert.equal(body.instructions, 'keep'); assert.equal(body.input[0].content[0].type, 'input_text'); assert.equal(result.usage?.inputTokens, 3); assert.equal(result.usage?.totalTokens, undefined);
  } finally { store.close(); await app.close(); }
});
for (const [status, code] of [[401, 'auth'], [403, 'auth'], [402, 'payment_required'], [404, 'not_found'], [429, 'rate_limited'], [500, 'http_error']] as const) {
  test(`HTTP ${status} is normalized without leaking upstream secrets`, async () => {
    const app = await server((_b, _q, res) => { res.statusCode = status; res.end('fake-key-a sensitive upstream detail'); });
    const { store, client } = setup(config(app.url));
    try { await assert.rejects(client.chat(request), (error: any) => error.code === code && error.status === status && !error.message.includes('fake-key')); }
    finally { store.close(); await app.close(); }
  });
}
test('empty JSON, malformed JSON, truncated SSE and upstream error events are failures', async () => {
  for (const [stream, payload] of [[false, '{}'], [false, 'bad json'], [true, 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'], [true, 'data: {"error":{"message":"secret"}}\n\n']] as const) {
    const app = await server((_b, _q, res) => { res.setHeader('content-type', stream ? 'text/event-stream' : 'application/json'); res.end(payload); });
    const doc = config(app.url); doc.models[0]!.stream = stream; const { store, client } = setup(doc);
    try { await assert.rejects(client.chat(request), { code: 'invalid_response' }); }
    finally { store.close(); await app.close(); }
  }
});
test('redirects are not followed with credentials', async () => {
  let hit = false; const sink = await server((_b, _q, res) => { hit = true; reply(res); });
  const app = await server((_b, _q, res) => { res.statusCode = 307; res.setHeader('location', sink.url); res.end(); });
  const { store, client } = setup(config(app.url));
  try { await assert.rejects(client.chat(request), { code: 'network' }); assert.equal(hit, false); }
  finally { store.close(); await app.close(); await sink.close(); }
});
test('Responses requires completed status/event rather than a partial body or bare DONE', async () => {
  for (const stream of [false, true]) {
    const app = await server((_b, _q, res) => {
      res.setHeader('content-type', stream ? 'text/event-stream' : 'application/json');
      res.end(stream ? 'data: {"type":"response.output_text.delta","delta":"unfinished"}\n\ndata: [DONE]\n\n'
        : JSON.stringify({ status: 'in_progress', output_text: 'unfinished' }));
    });
    const doc = config(app.url); doc.providers[0]!.protocol = 'responses'; doc.models[0]!.stream = stream;
    const { store, client } = setup(doc);
    try { await assert.rejects(client.chat(request), { code: 'invalid_response' }); }
    finally { store.close(); await app.close(); }
  }
});
