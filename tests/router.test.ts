import test from 'node:test';
import assert from 'node:assert/strict';
import { PiModelDocker, PiModelDockerError, type Adapter } from '../src/index.js';
import { config, setup, request, server, reply, chatSse } from './helpers.js';

function fallbackConfig() {
  const doc = config();
  doc.providers.push({ id: 'b', name: 'B', baseUrl: 'https://b.invalid/v1', protocol: 'chat_completions', credentialRef: 'memory:b' });
  doc.models.push({ routeId: 'backup', name: 'Backup', providerId: 'b', modelId: 'model-b', capabilities: { vision: true } });
  doc.models[0]!.fallbackRouteIds = ['backup']; return doc;
}
test('missing/disabled models and missing keys do not dispatch a request', async () => {
  const { store, registry, credentials } = setup(); let calls = 0;
  const adapter: Adapter = { async *run() { calls++; yield { type: 'text', text: 'x' }; yield { type: 'done' }; } };
  const client = new PiModelDocker(registry, credentials, { http: adapter });
  try {
    await assert.rejects(client.chat({ ...request, routeId: 'unknown' }), { code: 'not_found' });
    registry.putModel({ ...registry.exportConfig().models[0]!, enabled: false });
    await assert.rejects(client.chat(request), { code: 'unavailable' });
    registry.putModel({ ...registry.exportConfig().models[0]!, enabled: true }); credentials.delete('memory:a');
    await assert.rejects(client.chat(request), { code: 'credential_missing' }); assert.equal(calls, 0);
  } finally { store.close(); }
});
test('vision capabilities and assistant image input checked before network', async () => {
  const doc = config(); doc.models[0]!.capabilities = { text: true, vision: false };
  const { store, client } = setup(doc);
  const image = { type: 'image' as const, mimeType: 'image/png' as const, data: 'AQIDBA==' };
  try {
    await assert.rejects(client.chat({ ...request, messages: [{ role: 'user', content: [image] }] }), { code: 'unsupported_capability' });
    await assert.rejects(client.chat({ ...request, messages: [{ role: 'assistant', content: [image] }] }), { code: 'unsupported_capability' });
  } finally { store.close(); }
});
test('explicit 402 fallback is one-shot, visible and uses its own model/key', async () => {
  const { store, registry, credentials } = setup(fallbackConfig()); credentials.set('memory:b', 'fake-key-b');
  const calls: string[] = [];
  const adapter: Adapter = { async *run(s) {
    calls.push(s.model.routeId); if (s.model.routeId === 'vision') throw new PiModelDockerError('payment_required', 'No credit', 402);
    assert.equal(s.apiKey, 'fake-key-b'); assert.equal(s.model.modelId, 'model-b');
    yield { type: 'text', text: 'backup answer' }; yield { type: 'done' };
  } };
  try {
    const events = await Array.fromAsync(new PiModelDocker(registry, credentials, { http: adapter }).stream(request));
    assert.deepEqual(calls, ['vision', 'backup']); assert.equal(events.filter(e => e.type === 'fallback').length, 1);
    const last = events.at(-1); assert.equal(last?.type, 'completed');
    if (last?.type === 'completed') { assert.equal(last.result.routeId, 'backup'); assert.equal(last.result.requestedRouteId, 'vision'); }
  } finally { store.close(); }
});
test('no default fallback and no mixing a partial response with another provider', async () => {
  for (const partial of [false, true]) {
    const doc = partial ? fallbackConfig() : config(); const { store, registry, credentials } = setup(doc); credentials.set('memory:b', 'fake-key-b');
    let calls = 0; const adapter: Adapter = { async *run() { calls++; if (partial) yield { type: 'text', text: 'partial' }; throw new PiModelDockerError('payment_required', 'No credit', 402); } };
    try { await assert.rejects(new PiModelDocker(registry, credentials, { http: adapter }).chat(request), { code: 'payment_required' }); assert.equal(calls, 1); }
    finally { store.close(); }
  }
});
test('fallback target capability checked and fallback does not recurse', async () => {
  const doc = fallbackConfig(); doc.models[1]!.fallbackRouteIds = ['vision'];
  const { store, registry, credentials } = setup(doc); credentials.set('memory:b', 'fake-key-b');
  let calls = 0; const adapter: Adapter = { async *run() { calls++; throw new PiModelDockerError('payment_required', 'No credit', 402); } };
  try { await assert.rejects(new PiModelDocker(registry, credentials, { http: adapter }).chat(request)); assert.equal(calls, 2); }
  finally { store.close(); }
});
test('request snapshots isolate deletion, model updates and key rotation mid-request', async () => {
  let release!: () => void; const gate = new Promise<void>(r => release = r);
  let started!: () => void; const entered = new Promise<void>(r => started = r);
  const app = await server(async (body, req, res) => {
    const oldKey = req.headers.authorization; started(); await gate;
    reply(res, `${body.model}:${oldKey}`);
  });
  const { store, registry, credentials, client } = setup(config(app.url));
  try {
    const pending = client.chat(request); await entered;
    registry.deleteModel('vision'); credentials.set('memory:a', 'rotated'); release();
    const result = await pending; assert.equal(result.text, 'model-a:Bearer fake-key-a');
    await assert.rejects(client.chat(request), { code: 'not_found' });
  } finally { release(); store.close(); await app.close(); }
});
test('deadline cancels blocked HTTP and pre-aborted calls have one cancelled event', async () => {
  const app = await server(() => {}); const doc = config(app.url); doc.models[0]!.timeoutMs = 100;
  const { store, client } = setup(doc);
  try {
    const start = Date.now(); await assert.rejects(client.chat(request), { code: 'timeout' }); assert.ok(Date.now() - start < 2000);
    const controller = new AbortController(); controller.abort();
    const events = await Array.fromAsync(client.stream({ ...request, signal: controller.signal }));
    assert.equal(events.length, 1); assert.equal(events[0]!.type, 'cancelled');
  } finally { store.close(); await app.close(); }
});
test('early iterator return aborts adapter and prevents further content', async () => {
  const { store, registry, credentials } = setup(); let signal: AbortSignal | undefined;
  const adapter: Adapter = { async *run(s) { signal = s.signal; yield { type: 'text', text: 'first' }; yield { type: 'text', text: 'second' }; yield { type: 'done' }; } };
  try {
    const events = new PiModelDocker(registry, credentials, { http: adapter }).stream(request);
    await events.next(); const delta = await events.next(); assert.equal(delta.value?.type, 'text_delta');
    await events.return(); assert.equal(signal?.aborted, true);
  } finally { store.close(); }
});
test('cancelled streaming response terminates with no completed event', async () => {
  const { store, registry, credentials } = setup(); const controller = new AbortController();
  const adapter: Adapter = { async *run() { yield { type: 'text', text: 'first' }; await new Promise(() => {}); } };
  try {
    const stream = new PiModelDocker(registry, credentials, { http: adapter }).stream({ ...request, signal: controller.signal });
    await stream.next(); await stream.next(); const pending = stream.next(); controller.abort();
    assert.equal((await pending).value?.type, 'cancelled'); await stream.next();
  } finally { store.close(); }
});
test('hanging credential resolver is also bounded by logical deadline', async () => {
  const doc = config(); doc.models[0]!.timeoutMs = 100; const { store, registry } = setup(doc);
  try { await assert.rejects(new PiModelDocker(registry, { resolve: () => new Promise(() => {}) }).chat(request), { code: 'timeout' }); }
  finally { store.close(); }
});
test('JavaScript callers receive normalized errors for malformed input and signals', async () => {
  const { store, client } = setup();
  try {
    for (const input of [null, undefined, { ...request, signal: 'bad-signal' }]) {
      await assert.rejects(client.chat(input as any), { code: 'invalid_config' });
    }
  } finally { store.close(); }
});
