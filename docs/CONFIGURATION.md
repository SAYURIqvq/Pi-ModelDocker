# 配置与 API 契约

## 配置文件

根字段：`schemaVersion:1`、`providers:[]`、`models:[]`，可选 `selectedRouteId`。所有层级拒绝未知字段；schema 由 `src/contracts.ts` 导出，可供管理界面复用。

### 平台

| 字段 | 默认/约束 |
|---|---|
| id | 必填；字母/数字起始，后续允许字母数字、点、下划线、连字符；1–64 字符 |
| name | 必填；1–120 字符 |
| baseUrl | 必填绝对地址；无 userinfo、query、fragment |
| protocol | chat_completions / responses / anthropic_messages / google_generative_ai |
| engine | 默认 http；可选 pi-ai |
| credentialRef | 可选 env:NAME 或 memory:NAME；省略表示无鉴权 HTTP 服务 |
| enabled | true |
| timeoutMs | 120000；范围 100–600000 |
| allowHttp | false；显式允许受信任 HTTP 地址 |

平台记录更新按完整 upsert 处理。id 是引用，不随显示名称改变。跨平台共用一个环境变量只有显式设置相同 credentialRef 才发生；库不自动使用其它平台 Key。

### 模型

| 字段 | 默认/约束 |
|---|---|
| routeId | 必填、全局唯一，字符规则与平台 id 相同 |
| providerId | 必须指向存在的平台 |
| name / modelId | 必填；modelId 是精确上游 ID，不能用显示名替代 |
| enabled | true |
| capabilities | 默认 text=true、vision=false |
| stream | true；pi-ai 必须 true |
| protocol | 可选；覆盖平台协议 |
| timeoutMs | 可选；初始路线覆盖平台超时 |
| temperature | 可选 0–2；未提供则不强制发送 |
| maxOutputTokens | 可选正整数；pi-ai 必填 |
| contextWindow | 可选正整数；pi-ai 必填，来自平台资料 |
| requestOptions | 默认 {}；直接 HTTP 专用白名单 |
| fallbackRouteIds | 默认 []；最多一个其它已存在路线 |

requestOptions 白名单：`thinking: {type:"disabled"}`、Chat Completions 的 `reasoning_effort: "none"|"minimal"|"low"|"medium"|"high"`。它们用于供应商明确支持的兼容参数；选择不支持的上游仍会报错。不能覆盖 model、messages、stream、Authorization。

## SDK 方法

```text
new SqliteStore(path?)               # 默认 :memory:；close() 必须显式调用
new Registry(store)
registry.snapshot()                 # {revision, document}
registry.importConfig(document, expectedRevision?) → revision
registry.exportConfig() → document  # 包含凭据引用，不含 Key
registry.putProvider(fullRecord) → revision
registry.putModel(fullRecord) → revision
registry.deleteProvider(id) → revision  # 连同关联模型，并清理回退引用
registry.deleteModel(routeId) → revision
registry.select(routeId | null) → revision
registry.catalog(credentials) → Promise<publicCatalog>

new Credentials(env?)
credentials.set('memory:name', key)
credentials.delete(reference)
credentials.resolve(reference)

new PiModelDocker(registry, credentials, adapterOverrides?)
ai.chat(input) → Promise<ChatResult>
ai.stream(input) → AsyncGenerator<ChatEvent>
```

配置修改成功才增加 catalogRevision。catalog 获取不会发送 API 请求。未选择模型不影响显式传 routeId 调用；CLI 的 `-` 才表示读取选中路线。

## 消息

```typescript
{
  routeId: 'stable-route',
  systemPrompt?: string,
  messages: Array<{
    role: 'user' | 'assistant',
    content: Array<
      {type: 'text', text: string} |
      {type: 'image', mimeType: 'image/png'|'image/jpeg'|'image/webp'|'image/gif', data: string}
    >
  }>,
  signal?: AbortSignal
}
```

图片只能出现在 user 消息中；data 必须是有效形式的标准 Base64。库校验编码形式及长度，不验证图片像素是否能被供应商识别。当前每张 Base64 最多 2800 万字符，完整非流式响应/聚合文本上限约 1600 万字节/字符；没有自动压缩图片或按 token 截断上下文。

## 结果

```typescript
{
  requestId: string,
  requestedRouteId: string,
  routeId: string,
  providerId: string,
  modelId: string,
  text: string,
  usage?: {inputTokens?: number, outputTokens?: number, totalTokens?: number},
  finishReason?: string
}
```

finishReason 保留协议/SDK的值（例如 stop、length、completed），不是可靠的答案正确性或充分性判断。usage 缺失不补零、不猜测费用。

## 错误码

| code | 含义 |
|---|---|
| invalid_config | 配置或输入不合法 |
| conflict | 配置版本冲突/拒绝覆盖 |
| not_found | 路线不存在，或上游 HTTP 404 |
| unavailable | 平台/模型禁用 |
| credential_missing | 指定引用无可用 Key |
| unsupported_capability | 图片/文本能力不匹配 |
| unsupported_protocol | 当前引擎不支持请求方式 |
| adapter_missing | 未注册所需 Adapter |
| auth | 可取得的 HTTP 401/403 |
| payment_required | 可取得的 HTTP 402 |
| rate_limited | 可取得的 HTTP 429 |
| http_error | 其它可取得的失败 HTTP 状态 |
| network | 连接/传输等无法进一步分类的失败 |
| timeout | 整次逻辑调用超时 |
| cancelled | 主动取消或提前终止 |
| invalid_response | 无正文、坏 JSON、缺失完成信号或 SDK 无可用结果 |

不把原始上游错误文本原样转发给调用者。需要更细的厂商错误诊断时，应另行设计脱敏诊断通道，而不是输出完整请求和密钥。
