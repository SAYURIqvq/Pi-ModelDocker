#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Credentials, PiModelDocker, PiModelDockerError, Registry, SqliteStore, type ChatMessage } from './index.js';

const args = process.argv.slice(2);
function option(name: string): string | undefined {
  const index = args.indexOf(name); if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1]!.startsWith('--')) throw new Error('Missing option value.');
  const value = args[index + 1]; args.splice(index, 2); return value;
}
async function main() {
  const database = option('--db') ?? process.env.PI_MODELDOCKER_DB ?? './pi-modeldocker.sqlite';
  const image = option('--image'); const mode = option('--mode') ?? 'text';
  const command = args.shift();
  if (!command || ['help', '--help', '-h'].includes(command)) {
    console.log(`PiModelDocker — independent model registry and router

pi-modeldocker init CONFIG.json [--db FILE]       Import only into an empty registry
pi-modeldocker import CONFIG.json [--db FILE]     Atomically replace the configuration
pi-modeldocker export CONFIG.json [--db FILE]     Export config (references, never keys)
pi-modeldocker catalog [--db FILE]                Print a UI-safe model catalog
pi-modeldocker select ROUTE [--db FILE]           Persist the preferred route
pi-modeldocker chat ROUTE TEXT [--image FILE] [--db FILE]
pi-modeldocker stream ROUTE TEXT [--image FILE] [--db FILE]
pi-modeldocker test ROUTE [--mode text|vision] [--db FILE]

Set API keys in environment variables referenced by configuration.
chat/stream/test call your provider and may incur charges; other commands do not.
ROUTE '-' uses the selected route. No server, upload, or background agent is started.`);
    return;
  }
  const store = new SqliteStore(database); const registry = new Registry(store); const credentials = new Credentials();
  try {
    if (command === 'init' || command === 'import') {
      if (args.length !== 1) throw new Error('Expected one configuration file.');
      const current = registry.snapshot();
      if (command === 'init' && (current.revision || current.document.providers.length)) throw new PiModelDockerError('conflict', 'Registry already initialized; use import to replace it.');
      const revision = registry.importConfig(JSON.parse(await readFile(args[0]!, 'utf8')), current.revision);
      console.log(JSON.stringify({ saved: true, catalogRevision: revision })); return;
    }
    if (command === 'export') {
      if (args.length !== 1) throw new Error('Expected an output file.');
      if (resolve(args[0]!) === resolve(database)) throw new Error('Export must not overwrite the database.');
      await writeFile(args[0]!, JSON.stringify(registry.exportConfig(), null, 2) + '\n', { flag: 'wx', mode: 0o600 }); return;
    }
    if (command === 'catalog') { console.log(JSON.stringify(await registry.catalog(credentials), null, 2)); return; }
    if (command === 'select') {
      if (args.length !== 1) throw new Error('Expected a route ID.');
      console.log(JSON.stringify({ catalogRevision: registry.select(args[0]!) })); return;
    }
    if (!['chat', 'stream', 'test'].includes(command)) throw new Error('Unknown command; use help.');
    let routeId = args.shift();
    if (routeId === '-') routeId = registry.exportConfig().selectedRouteId ?? undefined;
    if (!routeId) throw new Error('Specify a route or select one first.');
    let content: ChatMessage['content'] = [{ type: 'text', text: args.join(' ') }];
    if (command === 'test') {
      if (!['text', 'vision'].includes(mode)) throw new Error('Test mode must be text or vision.');
      content = [{ type: 'text', text: mode === 'vision' ? 'Describe the color of this small test image.' : 'Reply with OK.' }];
      if (mode === 'vision') content.push({ type: 'image', mimeType: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC' });
    }
    if (image) {
      const bytes = await readFile(image);
      let mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
      if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) mimeType = 'image/png';
      else if (bytes[0] === 255 && bytes[1] === 216) mimeType = 'image/jpeg';
      else if (bytes.toString('ascii', 0, 3) === 'GIF') mimeType = 'image/gif';
      else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') mimeType = 'image/webp';
      else throw new Error('Unsupported image file.');
      content.push({ type: 'image', mimeType, data: bytes.toString('base64') });
    }
    if (!content.some(p => p.type === 'image' || p.text.trim())) throw new Error('Provide text or an image.');
    const adapters: Record<string, import('./contracts.js').Adapter> = {};
    if (registry.exportConfig().providers.some(p => p.engine === 'pi-ai')) {
      const { PiAdapter } = await import('./adapters/pi.js'); adapters['pi-ai'] = new PiAdapter();
    }
    const client = new PiModelDocker(registry, credentials, adapters);
    const controller = new AbortController(); const stop = () => controller.abort();
    process.once('SIGINT', stop);
    try {
      const input = { routeId, messages: [{ role: 'user' as const, content }], signal: controller.signal };
      if (command === 'stream') {
        for await (const event of client.stream(input)) {
          console.log(JSON.stringify(event));
          if (event.type === 'failed' || event.type === 'cancelled') process.exitCode = 1;
        }
      } else console.log(JSON.stringify(await client.chat(input), null, 2));
    } finally { process.removeListener('SIGINT', stop); }
  } finally { store.close(); }
}
main().catch(error => {
  const publicError = error instanceof PiModelDockerError
    ? { code: error.code, message: error.message, status: error.status }
    : { code: 'cli_error', message: 'Command failed. Check arguments, file access and configuration; use help for syntax.' };
  console.error(JSON.stringify(publicError)); process.exitCode = 1;
});
