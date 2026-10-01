import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore, Registry, Credentials, validateConfig, PiModelDockerError } from '../src/index.js';
import { config, setup } from './helpers.js';

test('SQLite persists routes, defaults and selection across reopening', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-modeldocker-')); const file = join(dir, 'config.sqlite');
  try {
    const first = new SqliteStore(file); const reg = new Registry(first);
    reg.importConfig(config()); reg.select('vision'); first.close();
    const second = new SqliteStore(file); const saved = second.read();
    assert.equal(saved.revision, 2); assert.equal(saved.document.selectedRouteId, 'vision');
    assert.equal(saved.document.models[0]!.capabilities.text, true); second.close();
  } finally { rmSync(dir, { recursive: true }); }
});
test('atomic import rejects invalid config and duplicate IDs without changing state', () => {
  const { store, registry } = setup();
  try {
    const before = registry.snapshot(); const bad = config(); bad.models.push({ ...bad.models[0]! });
    assert.throws(() => registry.importConfig(bad), { code: 'invalid_config' });
    assert.deepEqual(registry.snapshot(), before);
    assert.throws(() => registry.importConfig({ ...config(), apiKey: 'secret' }), { code: 'invalid_config' });
    assert.deepEqual(registry.snapshot(), before);
  } finally { store.close(); }
});
test('optimistic revisions prevent lost writes between connections', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-modeldocker-')); const path = join(dir, 'db');
  const a = new SqliteStore(path); const b = new SqliteStore(path);
  try { const old = a.read(); b.replace(config()); assert.throws(() => a.replace(config(), old.revision), { code: 'conflict' }); assert.equal(a.read().revision, 1); }
  finally { a.close(); b.close(); rmSync(dir, { recursive: true }); }
});
test('platform/model CRUD supports one-to-many, cascading delete and clearing selection', () => {
  const { store, registry } = setup();
  try {
    registry.putModel({ routeId: 'second', providerId: 'a', modelId: 'model-b', name: 'Second' });
    registry.putModel({ ...registry.exportConfig().models[0]!, fallbackRouteIds: ['second'] });
    registry.select('second'); registry.deleteModel('second');
    assert.equal(registry.exportConfig().selectedRouteId, null);
    assert.deepEqual(registry.exportConfig().models[0]!.fallbackRouteIds, []);
    registry.deleteProvider('a'); assert.equal(registry.exportConfig().models.length, 0);
  } finally { store.close(); }
});
test('catalog excludes credentials and addresses; key readiness is not connection success', async () => {
  const { store, registry, credentials } = setup();
  try {
    const ready = await registry.catalog(credentials); assert.equal(ready.models[0]!.available, true);
    assert.ok(!JSON.stringify(ready).includes('fake-key')); assert.ok(!JSON.stringify(ready).includes('memory:a'));
    assert.ok(!JSON.stringify(ready).includes('https:'));
    credentials.delete('memory:a'); assert.equal((await registry.catalog(credentials)).models[0]!.unavailableReason, 'credential_missing');
  } finally { store.close(); }
});
test('config and database contain only credential references', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-modeldocker-')); const path = join(dir, 'db');
  const store = new SqliteStore(path); const registry = new Registry(store); const credentials = new Credentials({ KEY: 'unique-sensitive-key' });
  try {
    const doc = config(); doc.providers[0]!.credentialRef = 'env:KEY'; registry.importConfig(doc);
    assert.equal(await credentials.resolve('env:KEY'), 'unique-sensitive-key');
    assert.ok(!readFileSync(path).includes(Buffer.from('unique-sensitive-key')));
    assert.ok(!JSON.stringify(registry.exportConfig()).includes('unique-sensitive-key'));
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});
test('normalizes complete standard endpoint and rejects credentials/query/implicit HTTP', () => {
  assert.equal(validateConfig(config('https://host.test/v1/chat/completions/')).providers[0]!.baseUrl, 'https://host.test/v1');
  for (const url of ['https://user:pass@host.test/v1', 'https://host.test/v1?key=secret', 'https://host.test/v1#x']) assert.throws(() => validateConfig(config(url)), PiModelDockerError);
  const doc = config('http://host.test/v1'); doc.providers[0]!.allowHttp = false;
  assert.throws(() => validateConfig(doc), { code: 'invalid_config' });
});
test('validates dangling/self fallback, foreign model names are allowed, unknown selection rejected', () => {
  const doc = config(); doc.models[0]!.modelId = 'arbitrary-foreign-model'; assert.doesNotThrow(() => validateConfig(doc));
  doc.models[0]!.fallbackRouteIds = ['vision']; assert.throws(() => validateConfig(doc));
  doc.models[0]!.fallbackRouteIds = ['missing']; assert.throws(() => validateConfig(doc));
  const { store, registry } = setup(); try { assert.throws(() => registry.select('unknown')); } finally { store.close(); }
});
test('pi-ai requires streaming and explicit model metadata; native protocols need pi adapter', () => {
  const doc = config(); doc.providers[0]!.engine = 'pi-ai';
  assert.throws(() => validateConfig(doc));
  doc.models[0]!.stream = true; doc.models[0]!.contextWindow = 32000; doc.models[0]!.maxOutputTokens = 1024;
  assert.doesNotThrow(() => validateConfig(doc));
  doc.providers[0]!.protocol = 'anthropic_messages'; doc.providers[0]!.engine = 'http'; assert.throws(() => validateConfig(doc));
});
