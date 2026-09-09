# 一手来源与版本核验

核验日期：2026-09-09。日期是查询日期，不表示本次已编译或运行这些组件。

## DroidVM

- 固定基线：https://github.com/Droid-VM/DroidVM/commit/72391c44f3a08994f513cd61205496e6f7dfd5ae
- `app/build.gradle.kts`：https://github.com/Droid-VM/DroidVM/blob/72391c44f3a08994f513cd61205496e6f7dfd5ae/app/build.gradle.kts
- 构建依赖：https://github.com/Droid-VM/DroidVM/blob/72391c44f3a08994f513cd61205496e6f7dfd5ae/gradle/libs.versions.toml
- 上游 CI：https://github.com/Droid-VM/DroidVM/blob/72391c44f3a08994f513cd61205496e6f7dfd5ae/.github/workflows/build.yml
- 实际 daemon 客户端：https://github.com/Droid-VM/DroidVM/blob/72391c44f3a08994f513cd61205496e6f7dfd5ae/app/src/main/java/cn/classfun/droidvm/lib/daemon/DaemonClient.java
- 私有路径常量：https://github.com/Droid-VM/DroidVM/blob/72391c44f3a08994f513cd61205496e6f7dfd5ae/app/src/main/java/cn/classfun/droidvm/lib/Constants.java
- Manifest：https://github.com/Droid-VM/DroidVM/blob/72391c44f3a08994f513cd61205496e6f7dfd5ae/app/src/main/AndroidManifest.xml

实际读取到的编译平台是 37，AGP 9.2.1，主界面体系主要为 Java / Android Views；不能沿用早前未经源码确认的“SDK 36、全部 Compose、已有 vsock HTTP 控制接口”等假设。
根 Git tree 和 `.gitmodules` 中的嵌套组件引用由锁定的上游提交决定；本项目没有自行更新到各组件浮动 master。

## Codex

- 固定正式发布：https://github.com/openai/codex/releases/tag/rust-v0.153.4
- 官方 app-server 文档：https://developers.openai.com/codex/app-server
- 固定版本审批定义：https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server-protocol/schema/typescript/v2/AskForApproval.ts
- 固定版本 sandbox 定义：https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server-protocol/schema/typescript/v2/SandboxMode.ts
- 登录请求：https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server-protocol/schema/typescript/v2/LoginAccountParams.ts
- 登录响应：https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server-protocol/schema/typescript/v2/LoginAccountResponse.ts
- 命令审批响应：https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server-protocol/schema/typescript/v2/CommandExecutionApprovalDecision.ts

版本 0.153.4 的 schema 使用 `untrusted`、`workspace-write`。查询时在线文档部分示例出现 `unlessTrusted`、`workspaceWrite`，与该版本定义不一致；代码依照固定发布 schema，而非混用文档示例。
设备登录使用 `type: chatgptDeviceCode`，响应为 `loginId`、`verificationUrl`、`userCode`。仅核验字段和模拟协议不代表 OAuth 登录已成功。

## 通用模型协议

- OpenAI Responses：https://platform.openai.com/docs/api-reference/responses
- OpenAI Function calling：https://platform.openai.com/docs/guides/function-calling
- OpenAI Chat Completions：https://platform.openai.com/docs/api-reference/chat
- Anthropic Messages：https://platform.claude.com/docs/en/api/messages
- Anthropic Streaming：https://platform.claude.com/docs/en/build-with-claude/streaming
- Anthropic tool use：https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview

本项目没有锁定或硬编码“最强/最新模型名称”。模型 ID 从实际供应商配置或 Codex 的账户模型列表取得。

## 构建、运行时与发布

- Node 24.20.0 正式发布和校验值：https://nodejs.org/en/blog/release/v24.20.0
- Node 分发校验值：https://nodejs.org/dist/v24.20.0/SHASUMS256.txt
- Android AGP 9.2：https://developer.android.com/build/releases/agp-9-2-0-release-notes
- GitHub CLI 建仓命令：https://cli.github.com/manual/gh_repo_create

Node 24.20.0 是可复现的候选 Guest 固定版本，不表示查询日最新版本。对应 SHA-256 写入 `guest/runtime.lock.json`；实际执行验证仍只有测试机 Node 22.16.0。
