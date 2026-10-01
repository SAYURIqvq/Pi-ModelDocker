# Pi ModelDocker 中文描述

## GitHub 仓库简介

Pi ModelDocker 是一个支持 pi-ai 适配的轻量级多平台模型调用框架，统一管理平台、模型与 API 密钥引用，提供文本与图片输入、流式输出和统一错误处理，让业务通过一套接口接入不同模型。

## 详细介绍

Pi ModelDocker 将平台地址、模型配置、协议适配和业务调用分开管理。业务只需选择稳定的 routeId 并提交消息，就能通过统一的 chat / stream 接口调用对应模型；新增兼容平台或切换模型时，可通过配置完成，无需在业务代码里重复编写请求逻辑。

项目采用 TypeScript，提供 SQLite 配置存储、API 密钥引用解析、模型能力检查、请求超时与取消，以及显式配置的余额不足回退。支持直接 HTTP 调用，也可通过可选的 pi-ai 适配层连接不同协议，并将结果、流式事件和错误转换为统一结构。

当前交付为独立 SDK 与命令行工具，包含配置示例、架构图、时序图及本地自动化测试，适合后续接入桌面应用、服务端或 Agent 项目。当前不包含图形界面、完整 Agent 工具执行循环或 Docker 容器部署功能。

## 命名约定

| 用途 | 名称 |
|---|---|
| 项目名称 | Pi ModelDocker |
| 仓库目录 | pi-modeldocker |
| npm 包 | pi-modeldocker-core |
| CLI 命令 | pi-modeldocker |
| SDK 主类 | PiModelDocker |
| 错误类 | PiModelDockerError |
| 数据库环境变量 | PI_MODELDOCKER_DB |
