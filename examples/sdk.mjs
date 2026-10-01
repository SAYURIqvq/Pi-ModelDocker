// After `npm run build`: set AKAII_API_KEY, then `node examples/sdk.mjs`.
// This makes a paid request to your configured provider.
import { readFile } from 'node:fs/promises';
import { Credentials, PiModelDocker, Registry, SqliteStore } from '../dist/index.js';

const store = new SqliteStore(':memory:');
try {
  const registry = new Registry(store);
  registry.importConfig(JSON.parse(await readFile(new URL('./akaii.json', import.meta.url), 'utf8')));
  const ai = new PiModelDocker(registry, new Credentials());
  const result = await ai.chat({
    routeId: 'akaii-gpt-5.5',
    systemPrompt: '请用中文简洁回答。', // Caller owns the prompt; the core does not replace it.
    messages: [{ role: 'user', content: [{ type: 'text', text: '用一句话解释模型路由。' }] }],
  });
  console.log(result.text);
} finally { store.close(); }
