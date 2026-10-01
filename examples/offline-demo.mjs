// No key, no external API and no charges. A real local HTTP server simulates a provider.
import { createServer } from 'node:http';
import { PiModelDocker, Registry, SqliteStore, Credentials } from '../dist/index.js';

const server = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ choices: [{ message: { content: `PiModelDocker 已通过统一入口调用 ${body.model}。` }, finish_reason: 'stop' }] }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const store = new SqliteStore(':memory:');
try {
  const registry = new Registry(store);
  registry.putProvider({ id: 'local', name: 'Offline demo',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, protocol: 'chat_completions', allowHttp: true });
  registry.putModel({ routeId: 'demo', providerId: 'local', name: 'Demo model', modelId: 'simulated-model', stream: false });
  const ai = new PiModelDocker(registry, new Credentials({}));
  console.log(await registry.catalog(new Credentials({})));
  console.log(await ai.chat({ routeId: 'demo', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }));
} finally {
  store.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
