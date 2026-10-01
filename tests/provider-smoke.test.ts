import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error The user-facing example is JavaScript, executed without compilation.
import { runSmoke, presets } from '../examples/provider-smoke.mjs';
import { server, reply, chatSse } from './helpers.js';

test('smoke rejects missing credentials and invalid selections before any request', async () => {
  let calls = 0;
  const options = { env: {}, fetcher: async () => { calls++; throw new Error('Unexpected network'); } };
  await assert.rejects(runSmoke('deepseek', 'all', options), /DEEPSEEK_API_KEY/);
  await assert.rejects(runSmoke('constructor', 'chat', options), /平台/);
  await assert.rejects(runSmoke('deepseek', 'unknown', options), /模式/);
  assert.equal(calls, 0);
});

for (const provider of ['deepseek', 'doubao', 'openrouter']) {
  test(`smoke ${provider}: all modes use the chosen model and credential, without contacting vendors`, async () => {
    const seen: any[] = [];
    const app = await server((body, req, res) => {
      seen.push(body);
      assert.equal(req.headers.authorization, 'Bearer local-only-test-key');
      assert.equal(body.model, 'custom-test-model');
      if (body.stream) chatSse(res, '2'); else reply(res, '2');
    });
    try {
      const preset = presets[provider];
      const reports = await runSmoke(provider, 'all', {
        env: { [preset.keyEnv]: 'local-only-test-key', [preset.modelEnv]: 'custom-test-model' },
        fetcher: async (url: string, init: RequestInit) => {
          assert.equal(String(url), `${preset.baseUrl}/chat/completions`);
          return fetch(`${app.url}/chat/completions`, init);
        },
      });
      assert.equal(reports.length, 3);
      assert.ok(reports.every((r: any) => r.ok && r.answer === '2' && r.httpStatuses[0] === 200));
      assert.ok(reports[1].textDeltaEvents > 0 && reports[2].textDeltaEvents > 0);
      assert.deepEqual(seen.map(b => b.stream), [false, true, true]);
      assert.ok(!JSON.stringify(reports).includes('local-only-test-key'));
      assert.deepEqual(app.errors, []);
    } finally { await app.close(); }
  });
}

test('smoke reports upstream failure safely and rejects an incorrect answer', async () => {
  const opts = { env: { DEEPSEEK_API_KEY: 'local-only-test-key' } };
  const failed = await runSmoke('deepseek', 'chat', { ...opts,
    fetcher: async () => new Response('local-only-test-key should not leak', { status: 401 }) });
  assert.equal(failed[0].ok, false); assert.equal(failed[0].code, 'auth');
  assert.ok(!JSON.stringify(failed).includes('local-only-test-key'));
  const wrong = await runSmoke('deepseek', 'chat', { ...opts,
    fetcher: async () => Response.json({ choices: [{ message: { content: '3' }, finish_reason: 'stop' }] }) });
  assert.equal(wrong[0].ok, false); assert.equal(wrong[0].answer, '3');
});
