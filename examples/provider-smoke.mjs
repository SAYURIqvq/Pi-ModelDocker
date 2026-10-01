// Real provider smoke test. Keys are resolved from the environment, never persisted.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Credentials, Registry, SqliteStore, PiModelDocker, HttpAdapter } from '../dist/index.js';

export const presets = {
  deepseek: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', keyEnv: 'DEEPSEEK_API_KEY', modelEnv: 'DEEPSEEK_MODEL', model: 'deepseek-flash' },
  doubao: { name: '豆包（火山方舟）', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', keyEnv: 'ARK_API_KEY', modelEnv: 'DOUBAO_MODEL', model: 'doubao-seed-2-1-pro-260628' },
  openrouter: { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY', modelEnv: 'OPENROUTER_MODEL', model: 'deepseek/deepseek-v3.2' },
};

export async function runSmoke(providerId, mode = 'chat', { env = process.env, fetcher = globalThis.fetch } = {}) {
  if (!Object.hasOwn(presets, providerId)) throw new Error('平台请选择 deepseek、doubao 或 openrouter。');
  if (!['chat', 'stream', 'pi', 'all'].includes(mode)) throw new Error('模式请选择 chat、stream、pi 或 all。');
  const preset = presets[providerId];
  if (!env[preset.keyEnv]?.trim()) throw new Error(`请先在 .env 中填写 ${preset.keyEnv}。`);
  const modelId = env[preset.modelEnv]?.trim() || preset.model;
  const credentials = new Credentials(env);
  const store = new SqliteStore(':memory:');
  const registry = new Registry(store);
  const results = [];
  try {
    const modes = mode === 'all' ? ['chat', 'stream', 'pi'] : [mode];
    for (const current of modes) {
      const engine = current === 'pi' ? 'pi-ai' : 'http';
      registry.importConfig({ schemaVersion: 1,
        providers: [{ id: providerId, name: preset.name, baseUrl: preset.baseUrl,
          protocol: 'chat_completions', engine, credentialRef: `env:${preset.keyEnv}`, timeoutMs: 60000 }],
        models: [{ routeId: 'smoke', providerId, name: preset.name, modelId,
          capabilities: { text: true, vision: false }, stream: current !== 'chat',
          // Conservative metadata for this tiny prompt, not the provider's advertised limit.
          contextWindow: 16384, maxOutputTokens: 1024,
          ...(providerId === 'deepseek' && engine === 'http' ? { requestOptions: { thinking: { type: 'disabled' } } } : {}) }],
      });
      const statuses = [];
      const observedFetch = async (input, init) => {
        const response = await fetcher(input, init);
        statuses.push(response.status);
        return response;
      };
      const adapters = { http: new HttpAdapter(observedFetch) };
      if (engine === 'pi-ai') {
        const { PiAdapter } = await import('../dist/adapters/pi.js');
        try { await import('@earendil-works/pi-ai'); }
        catch { throw new Error('pi 模式需要安装依赖：npm install --no-save @earendil-works/pi-ai@0.99.1'); }
        adapters['pi-ai'] = new PiAdapter(observedFetch);
      }
      const client = new PiModelDocker(registry, credentials, adapters);
      const input = { routeId: 'smoke', messages: [{ role: 'user', content: [{ type: 'text', text: '1+1等于几？只输出数字2，不要解释。' }] }] };
      let result, deltaEvents = 0;
      try {
        if (current === 'chat') result = await client.chat(input);
        else for await (const event of client.stream(input)) {
          if (event.type === 'text_delta') deltaEvents++;
          else if (event.type === 'completed') result = event.result;
          else if (event.type === 'failed') throw Object.assign(new Error(event.message), { code: event.code });
          else if (event.type === 'cancelled') throw Object.assign(new Error('请求已取消。'), { code: 'cancelled' });
        }
        results.push({ provider: providerId, model: modelId, mode: current, httpStatuses: statuses,
          ok: result?.text.trim() === '2' && result.finishReason === 'stop', answer: result?.text,
          finishReason: result?.finishReason, usage: result?.usage, textDeltaEvents: deltaEvents });
      } catch (error) {
        // Never print raw SDK errors, headers, credentials or request bodies.
        results.push({ provider: providerId, model: modelId, mode: current, httpStatuses: statuses,
          ok: false, code: error.code ?? 'request_failed', message: '调用失败，请按错误码检查密钥、余额、模型权限和网络。' });
      }
    }
    return results;
  } finally { store.close(); }
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || ['--help', '-h'].includes(args[0])) {
    console.log('用法：npm run smoke -- <deepseek|doubao|openrouter> [chat|stream|pi|all]\n先复制 .env.example 为 .env 并填写所选平台的密钥。默认 chat 调用一次；all 调用三次，可能产生费用。');
    return;
  }
  if (args.length > 2) throw new Error('参数过多，请运行 npm run smoke -- --help。');
  const results = await runSmoke(args[0], args[1]);
  console.log(JSON.stringify(results, null, 2));
  if (results.some(result => !result.ok)) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
