# v0.1.2 验证报告

验证日期：2026-10-01。所有操作在本机完成，未推送代码、未发布 npm 包、未访问付费模型 API。

以下记录包含此前版本的完整验证；本次命名变更重新执行构建、双 Node 版本测试、离线示例及图表解析。独立安装与消费项目检查为此前版本的验证记录。

## 结果

| 检查 | 结果 |
|---|---|
| TypeScript strict 构建及声明生成 | 通过 |
| Node.js 25.1.0 测试 | 41 passed，0 failed，0 skipped |
| 最低支持 Node.js 22.19.0 测试 | 41 passed，0 failed，0 skipped |
| 删除 dist/node_modules 的独立副本执行 npm ci | 通过 |
| 独立副本构建与测试 | 41 passed，0 failed，0 skipped |
| 离线示例的真实本地 HTTP 往返 | 通过，无 Key、无外网调用 |
| npm pack 本地打包 | 通过；没有 npm publish |
| 在单独消费项目安装包，省略可选 pi-ai | 核心导入、SQLite、目录读取通过 |
| 原 AutoAIAnswer 仓库 | 未修改；原有无关未跟踪文件保留 |
| 源码内真实 Key、私人图片、数据库 | 未包含 |

Node 内置 SQLite 在验证版本中显示 ExperimentalWarning，这不是测试失败；库明确要求 Node >=22.19.0。

## 覆盖内容

- 真实本地 HTTP 服务验证 Chat Completions 的非流式、图片 MIME、历史和 system prompt 透传。
- 流式增量、跨字节 UTF-8、CR/LF/CRLF、多行 SSE、结束标记、空结果、截断流与错误事件。
- Responses 的流式与非流式，及未完成结果的拒绝。
- 401/403/402/404/429/500 的规范化和敏感上游内容过滤。
- 重定向不转发凭据（直接 HTTP 路径）。
- 实际安装并加载 pi-ai 0.99.1，对本地模拟服务运行 Chat Completions、Responses、Anthropic、Google 四类协议。
- SQLite 重启恢复、配置事务、版本冲突、增删改、选中项、目录脱敏、引用校验。
- 能力检查、禁用路线、无 Key、未知路线、一次显式 402 回退、部分输出后不回退。
- 运行中删除模型/换 Key 时请求继续使用原快照，超时、取消和提前结束迭代。
- JavaScript 非法输入、CLI 初始化/导出/选择/问答/图片测试和失败退出码。
- 内置测试图片为 64×64 合成纯色 PNG，不含用户数据。

## 尚未验证或未实现

- 没有用真实付费账号调用本项目的任何供应商接口；本地协议测试不能证明特定账号、模型权限或供应商当前可用。
- 测试主机是 macOS；没有声称完成 Windows/Linux 实机测试。Node 最低版本验证同样是在本机进行。
- 不包含截图/手机/桌面 UI、Windows 系统凭据、原应用迁移、Agent 工具循环或 EXE。
- Google pi 适配器使用 SDK 原生传输，无法像其它路线一样注入 fetch、读取所有 HTTP 状态或统一控制重定向，详见 README。
- token usage/finishReason 受上游字段质量限制，不评估回答正确率，不估算费用。

## 重现

```bash
npm ci
npm run check
node examples/offline-demo.mjs
```

最低版本运行（需要能够安装对应 Node 分发包）：

```bash
npx --yes --package=node@22.19.0 node --import tsx --test tests/*.test.ts
```

测试不需要真实 API Key。CLI 真正连接平台需由使用者主动运行 chat/stream/test 命令并提供自己的密钥。

## v0.1.2 命名与文档检查

包名、CLI、主类、示例与锁文件已统一为 Pi ModelDocker 命名；命名入口统一为新版，已有数据库可通过 --db 指定。README 内直接提供 3 张 Mermaid 图：分层架构、请求时序、配置实体关系。目录名建议为 `pi-modeldocker`。

使用 Mermaid 11 解析器校验了 README 的 3 张图和 ARCHITECTURE 的 1 张图，全部通过语法检查。图表保留为可版本管理的 Mermaid 代码。
