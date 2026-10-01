# 与 AutoAIAnswer SPEC v1.0 的对应关系

这次任务的边界是先单独实现模型调用架构，供以后放入独立仓库。原 spec 中绑定 AutoAIAnswer/Windows 产品的要求不应被误标为已经完成。

| 原规格 | 本项目状态 |
|---|---|
| Provider / Model 一对多、稳定 route ID | 已实现 |
| 配置持久化、原子提交、目录版本 | SQLite 已实现；并发写入采用乐观冲突检查 |
| 原始 prompt 与历史透传 | 已实现，不含内置答题 prompt |
| 统一 client / router / adapter | 已实现；router 为 client 内部流程 |
| Chat Completions / Responses | 直接 HTTP 已实现流式和非流式 |
| pi-ai 多供应商适配 | 本次独立项目增加可选 pi-ai 桥接，锁定 0.99.1 |
| 密钥不进入模型配置、日志或手机目录 | 已实现引用与脱敏目录 |
| Windows Credential Manager | 未实现；提供 CredentialResolver 接口、环境变量和内存实现 |
| 平台/模型管理 | SDK CRUD 与 CLI 已实现；图形管理界面未实现 |
| 模型测试 | CLI 文本/合成图片调用已实现；未持久化测试历史 |
| 手机动态列表与同步 | 提供 catalogRevision + 脱敏目录；未实现手机 UI/WebSocket transport |
| 原 QSettings / .env 配置迁移 | 不属于独立库；以后由 AutoAIAnswer 集成层实现 |
| 原截图、手势、悬浮字幕功能 | 未修改原项目，也未迁移进该库 |
| 显式回退、能力校验、快照和取消 | 已实现 |
| 旧预设的特殊 402 回退 | 未导入旧业务策略；独立库仅显式配置一次回退 |
| 原项目 Mac 功能不变 | 没有修改原项目；该 SDK 本身可跨平台使用 |
| Windows 单文件 EXE | 本次交付是源码库，不是桌面程序；不生成 EXE |
| 本地开发，不推送 GitHub | 已遵守 |

## 有意调整

- 原文档面向 Python 桌面程序，建议不引入 Node sidecar。本次用户改为独立实现 pi-agent 风格的调用层，因此独立库采用 TypeScript/Node.js；这不表示已经决定在 AutoAIAnswer 中引入 Node。以后集成时可选择服务桥接或移植设计。
- 原 spec 的 requests 超时沿用连接/读取语义；本库用 AbortController 实现整次逻辑调用总期限，不把两个语义混称。
- 原 spec 的 schema_version 等消息字段尚未成为独立外部接口；本库采用 camelCase 类型，不要求未来手机消息直接照搬。
- 不自动添加厂商模型，不假定任意模型都支持图片。由操作者配置并显式测试。
- 能力聚焦 text/vision；未实现 tools/reasoning 等 Agent 运行机制。pi-ai SDK 的更广能力不等于本库已对外提供。

## 后续接回 AutoAIAnswer 的工作

1. 在隔离分支核实当时 GitHub 基线及现有本地改动。
2. 决定 Python 适配或本地服务边界，避免仅为 SDK 引入不受控后台进程。
3. 实现系统凭据、旧设置迁移、管理 UI、目录消息、手机同步确认。
4. 保留原 prompt、截图、对话和事件契约。
5. 执行原 spec 的完整 Windows 实机回归后再交付 EXE。

本仓库不会自动执行上述集成、读取旧项目密钥或修改 GitHub 内容。
