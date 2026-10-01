# DeepSeek、豆包、OpenRouter 实测教程

脚本：[examples/provider-smoke.mjs](../examples/provider-smoke.mjs)。通过 Pi ModelDocker 的统一入口调用平台，不是绕开项目单独发送请求。配置和密钥引用只放在内存数据库中，退出后释放。

## 1. 安装

需要 Node.js >= 22.19.0。在仓库目录运行：

```bash
npm ci
```

复制 `.env.example` 为 `.env`。macOS/Linux：

```bash
cp .env.example .env
```

Windows PowerShell：

```powershell
Copy-Item .env.example .env
```

用编辑器打开 `.env`，只填写你准备测试的平台密钥。不要把真实密钥写进 `.env.example`；`.env` 已被 Git 忽略。已有系统环境变量优先于 `.env`，更换密钥时也要检查系统环境变量。

## 2. 填写密钥和模型

| 平台 | 密钥变量 | 默认模型 | 模型覆盖变量 |
|---|---|---|---|
| DeepSeek 官方 | `DEEPSEEK_API_KEY` | `deepseek-flash` | `DEEPSEEK_MODEL` |
| 豆包／火山方舟（北京） | `ARK_API_KEY` | `doubao-seed-2-1-pro-260628` | `DOUBAO_MODEL` |
| OpenRouter | `OPENROUTER_API_KEY` | `deepseek/deepseek-v3.2` | `OPENROUTER_MODEL` |

默认模型有调用权限时，填密钥即可测试。豆包使用火山方舟 API Key；不是豆包 App 登录凭据，也不是火山引擎 Access Key。若默认模型未开通，在控制台开通它，或将 `DOUBAO_MODEL` 改为已开通的模型 ID / `ep-...` 推理接入点 ID。OpenRouter 也可以换成账号可用的完整 `供应商/模型` 标识。脚本不自动寻找或购买模型。

三个平台分别使用各自的 Key，不能混用。地址已固定到对应官方服务，没有把 DeepSeek 的 Key 转发给另外两家。

## 3. 运行

每条命令默认只调用所选平台一次，并自动构建代码：

```bash
npm run smoke -- deepseek
npm run smoke -- doubao
npm run smoke -- openrouter
```

指定测试模式：

```bash
npm run smoke -- deepseek chat
npm run smoke -- deepseek stream
npm run smoke -- deepseek pi
npm run smoke -- deepseek all
```

将 `deepseek` 换成 `doubao` 或 `openrouter` 即可。`chat` 是 HTTP 非流式，`stream` 是 HTTP 流式，`pi` 是实际 pi-ai SDK 流式；`all` 按顺序执行这三种模式，共三次调用。真实请求可能计费；脚本不会自动测试其它平台。全新源码执行 `npm ci` 会安装固定版本的 pi-ai；生产环境省略开发依赖时，pi 模式可能需执行：

```bash
npm install --no-save @earendil-works/pi-ai@0.99.1
```

固定问题为“1+1等于几？只输出数字2，不要解释。”每次请求上限 1024 输出 token、60 秒，不设置自动重试。DeepSeek 的 HTTP 模式关闭思考；pi 模式与其它平台使用 SDK／平台默认思考行为，token 消耗可能不同。模型覆盖后若一直思考、没有正文，应选择合适模型后重试；不要把空输出当作成功。

## 4. 看结果

成功时输出 `ok: true`、`httpStatuses: [200]`、`answer: "2"` 和 `finishReason: "stop"`，并附 token usage（上游提供时）及文本增量事件数。脚本汇总后一次性打印 JSON；流式模式仍在内部消费真实 SSE，不逐字打印到终端。

`all` 中任一模式失败，进程以状态码 1 退出。即使 HTTP 200，回答不等于 `2` 或结束原因不是 `stop` 也不会算测试通过；可查看 `answer` 和 `finishReason` 排查。

| 错误 | 检查内容 |
|---|---|
| 提示未填写密钥变量 | 检查当前目录 `.env` 和变量名称 |
| `auth` / 401 / 403 | 密钥是否来自所选平台、是否有效、账号是否有权限 |
| `payment_required` / 402 | 余额或额度 |
| `not_found` / 404 | 模型 ID 是否正确、豆包接入点是否存在 |
| `http_error` / 400 | 模型或参数不兼容；豆包模型是否开通 |
| `timeout` / `network` | 网络、代理、服务可达性、超时 |
| `invalid_response` | 上游未返回完整文本，或输出预算内没有生成正文 |

## 5. 验证范围

2026-10-01：原始测试通过真实 DeepSeek 官方接口完成 HTTP 非流式、HTTP 流式和 pi-ai 三条路线，均 HTTP 200、回答 `2`。本次整理后的可运行脚本也再次通过三条路线：chat / stream / pi 均回答 `2`，totalTokens 分别为 19 / 19 / 58。豆包与 OpenRouter 的默认地址、模型来自官方资料；没有这两个平台的测试密钥，因此只做本地模拟服务验证，不声称已完成真实账号调用。

普通 `npm test` 不调用付费服务。只有主动运行 `npm run smoke -- 平台名` 才会发送这里的真实测试请求。

## 官方资料

- [DeepSeek 接口说明](https://api-docs.deepseek.com/)
- [火山方舟 Base URL 与鉴权](https://docs.volcengine.com/docs/ark/base-url-and-authentication?lang=en)
- [OpenRouter 快速开始](https://openrouter.ai/docs/quickstart)
- [OpenRouter 默认示例模型](https://openrouter.ai/deepseek/deepseek-v3.2)

模型名称和权限可能随平台变更；预设不是永久可用承诺。
