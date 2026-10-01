import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, server, reply } from './helpers.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
async function run(args: string[], cwd: string, env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [cli, ...args], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  return { code, stdout, stderr };
}
test('CLI initializes, exports, selects and invokes without storing its environment key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-modeldocker-cli-'));
  let imageTestBody: any;
  const app = await server((body, req, res) => { imageTestBody = body; assert.equal(body.stream, false); assert.equal(req.headers.authorization, 'Bearer cli-test-key'); reply(res, 'CLI works'); });
  try {
    const doc = config(app.url); doc.providers[0]!.credentialRef = 'env:PI_MODELDOCKER_TEST_KEY';
    await writeFile(join(dir, 'config.json'), JSON.stringify(doc));
    assert.equal((await run(['init', 'config.json'], dir)).code, 0);
    assert.equal((await run(['init', 'config.json'], dir)).code, 1);
    assert.equal((await run(['select', 'vision'], dir)).code, 0);
    const catalog = await run(['catalog'], dir, { PI_MODELDOCKER_TEST_KEY: 'cli-test-key' });
    assert.equal(JSON.parse(catalog.stdout).models[0].available, true);
    assert.ok(!catalog.stdout.includes('cli-test-key')); assert.ok(!catalog.stdout.includes('credentialRef'));
    const result = await run(['chat', '-', 'hello'], dir, { PI_MODELDOCKER_TEST_KEY: 'cli-test-key' });
    assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).text, 'CLI works');
    const vision = await run(['test', 'vision', '--mode', 'vision'], dir, { PI_MODELDOCKER_TEST_KEY: 'cli-test-key' });
    assert.equal(vision.code, 0, vision.stderr);
    const imageUrl = imageTestBody.messages[0].content.find((part: any) => part.type === 'image_url').image_url.url;
    const png = Buffer.from(imageUrl.split(',')[1], 'base64');
    assert.equal(png.readUInt32BE(16), 64); assert.equal(png.readUInt32BE(20), 64);
    assert.equal((await run(['export', 'export.json'], dir)).code, 0);
    assert.ok(!(await readFile(join(dir, 'export.json'), 'utf8')).includes('cli-test-key'));
    assert.equal((await run(['export', 'export.json'], dir)).code, 1);
    assert.equal((await run(['export', 'pi-modeldocker.sqlite'], dir)).code, 1);
    assert.equal((await run(['catalog'], dir)).code, 0);
  } finally { await app.close(); await rm(dir, { recursive: true }); }
});
test('CLI invalid JSON has nonzero exit status and does not echo sensitive input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-modeldocker-cli-'));
  try {
    await writeFile(join(dir, 'bad.json'), '{"secret-key-value"');
    const result = await run(['init', 'bad.json'], dir);
    assert.equal(result.code, 1); assert.ok(!result.stderr.includes('secret-key-value'));
  } finally { await rm(dir, { recursive: true }); }
});
