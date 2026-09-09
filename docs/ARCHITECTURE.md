# 架构与已经落实的边界

## 1. 手机界面与 Computer

Agbot 是基于固定版本 DroidVM 源码生成的**一个应用**。保留上游 Java/native VM 管理代码、配置、初始化和打包机制，加入 `app.agbot.android.AgbotActivity` 作为 launcher。
因为上游实际以 Java / Views 为主，首轮直接使用 Java 原生界面，避免为了此前构想的 Kotlin/Compose 全面替换稳定模块。

应用 ID 与内部 namespace 是两个概念：前者改为 `app.agbot.android`，后者保留 `cn.classfun.droidvm`，避免无证据地重命名 JNI 类和上游生成资源。
原上游 Splash 的启动图标被移除，仍能在同一 APK 中显式打开它。独立的 Android 私有目录和 root 授权是必需的；不会继承另一个 DroidVM 安装的数据/授权。

`prepare_android.py` 以 `git show HEAD:<path>` 为基线生成修改，严格校验 HEAD。overlay 重跑只覆盖有状态哈希证明“上次由脚本生成且未被改动”的文件。
每个输出文件采用临时文件 + fsync + rename。**这不是跨所有文件的事务**：中途磁盘错误应保存已有变化并诊断，不能自动删除目录恢复。

## 2. Linux 网关

Node.js ESM，网关无 npm 第三方依赖。没有 Rust 假实现或未测试的二进制占位文件。
Node 服务负责 HTTP(S)、会话、协议适配、审批、工具、Codex 进程管理。Guest 中的 Bash/Python/Git/Node 是真实工具，不在 Android 上模拟执行。

生产 `main.mjs` 仅接受 Linux 非 root 用户。Guest 安装脚本的 root 仅用于安装系统依赖和配置服务，服务本身降到独立 `agbot` 用户。
控制服务和任务进程目前同 UID；这意味着任意已批准 Shell 不受工作区路径限制，是后续凭据隔离设计的明确缺口。

## 3. 两条执行路径

### Responses / Chat Completions / Anthropic

```text
用户提交 → 校验 protocol/model/workspace
    → 锁定会话及工作区 → 写入任务/事件
    → HTTPS 请求所选云模型 → SSE/JSON 解析
    → 完整校验工具调用 → 获取一次性审批 → Guest 工具
    → 写入执行结果 → 按该协议回传给模型
    → 无后续工具 / 达到轮次与时间上限 / 停止
```

文件工具采用相对工作区路径，禁止 `..`、绝对路径、符号链接跳出。`write_file` 显示修改前后内容，批准前后校验旧文件哈希，防止批准的内容与落盘目标发生明显变化。
所有 Shell 和写文件动作要求确认。批准绑定会话、随机 ID 和一次操作；不持久化永久信任。
Shell 在 Guest 中 `/bin/bash --noprofile --norc` 执行，限制输出和时长，停止时终止进程组。不会继承网关环境中的模型 Key。

三种 wire format 不混为“换 URL”实现：Responses 有 function_call/function_call_output 和 reasoning replay；Chat Completions 有 tool_calls 与 tool 角色；Anthropic 有 content blocks、tool_use/tool_result 及 thinking/signature replay。
解析失败、截断流或重复工具 ID 不会执行部分工具或写入半截助手历史。

### Codex OAuth

```text
Agbot → codex app-server（官方固定版）→ ChatGPT 账户授权 / 模型
      ↔ thread/turn 通知、官方审批请求、turn/interrupt
```

Agbot 不注册假 OAuth client_id，不读取浏览器 Cookie，不将 OAuth token 伪装成通用 API Key。
官方 CLI 保管和刷新 OAuth 凭据。设备授权结果由账户接口确认，不能仅因打开浏览器就显示“已登录”。
未支持的 server-initiated request 默认返回错误；不自动批准权限升级、网络策略永久变更或会话级信任。
Codex 自己的工具系统和 Agbot 自定义工具不是同一套，不能保证两者审批粒度完全一致。

## 4. 可恢复性

SessionStore 使用本地私有 JSON 状态、递增事件游标和每文件原子写入。事件日志有上限，客户端游标过老会收到截断标记。
Android 前台轮询并增量渲染，不通过 WebView 运行外来 HTML。切回前台时从会话日志恢复显示。
任务在 Guest 继续运行不代表能够抵抗 Android 杀后台、VM 停机或断电；没有全时在线保证。

请求 ID 防止客户端重试重复启动任务。Android 加密保存 outbox 请求 ID，结果未确认时不能更换 Computer 或用新内容覆盖。
服务重启时将运行中的任务标记为 interrupted，取消旧审批，对未确认完成的工具补充“结果未知”。**不自动重放文件修改/命令**。
这不是分布式 exactly-once：命令执行和状态持久化之间崩溃，仍可能需要检查项目实际状态。

## 5. 网络与凭据

Android ↔ Guest 使用带 Bearer 的原生 HTTPS；非 loopback 不允许明文。
自签证书通过用户从可信 Guest 导入的 SHA-256 精确指纹验证，必须仍在有效期内；无指纹时保留系统 CA 和 hostname 验证。
桥接拒绝浏览器 Origin、未授权请求、任意重定向和过大 body；不开放通用网页 JS bridge。

API Key 和 Computer 配对令牌在 Android 使用 Keystore AES-GCM 加密保存；Codex 凭据位于 Guest 的官方 CLI 数据目录。
TLS 私钥在 Guest，历史和工作区也在 Guest；不能声称整个文件系统均由 Android Keystore 加密。

## 6. 尚未实现的核心

上游真实 daemon 是自有 framing 的 JSON/本地连接，不能凭构想写出 `POST /vm/start` 并宣称已接入。
当前只复用同一 APK 的高级管理界面。下一阶段必须读取具体镜像导入与生命周期类，完成可观测的自动化路径：

1. 首次 root/运行时准备与有界设备检测。
2. 固定、校验过的 ARM64 Linux 镜像创建或导入。
3. 安装包与服务注入，生成每实例证书及私密令牌。
4. Host ↔ Guest 实际网络发现、认证配对与连通性探测。
5. 把 start/stop/status/logs 变成主界面的真实 Computer 状态。
6. 在目标手机验证后，再启用默认一键路径。

“打开高级管理器”是开发版的明确边界，不应当作上述自动化已经完成。
