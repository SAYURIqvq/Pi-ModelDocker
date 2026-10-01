# Changelog

## 2026-10-01 — 三平台测试示例

- 新增 DeepSeek、豆包（火山方舟）、OpenRouter 官方地址和模型预设。
- 新增 npm run smoke，支持 HTTP 非流式、HTTP 流式和 pi-ai 三种模式，密钥从本地 .env / 环境变量读取。
- 新增中文实测教程和 5 项本地测试；DeepSeek 三种模式真实调用通过。

## 0.1.2 — 2026-10-01

- 统一使用 Pi ModelDocker 名称，更新包名、CLI、SDK 类名、数据库环境变量与示例。
- 移除旧命名的兼容导出和环境变量入口；已有数据库仍可通过 --db 指定。
- 添加中文仓库简介与详细项目介绍，保留技术文档和 Mermaid 架构图。

## 0.1.1 — 2026-10-01

- Renamed the project to Pi ModelDocker, the package to pi-modeldocker-core, and the CLI to pi-modeldocker.
- Standardized SDK naming and documentation.
- Added architecture, request sequence and configuration relationship diagrams directly to README.
- Updated configuration examples and documentation consistently.

## 0.1.0 — 2026-10-01

Initial standalone implementation:

- Provider/model registries with SQLite transactions and optimistic revisions.
- Credential references with environment and in-memory resolution.
- Direct Chat Completions/Responses adapters with real non-streaming support.
- Optional pi-ai bridge for four protocols, pinned to 0.99.1.
- Unified results/events, image capability checks, snapshots, cancellation and explicit fallback.
- CLI, examples, architecture/configuration docs and 41 local automated tests.

No AutoAIAnswer integration or remote publishing performed.
