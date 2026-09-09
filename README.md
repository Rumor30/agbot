# Agbot

**云端模型，手机本地 Linux Computer，触屏对话界面。**

`0.1.0-dev.1` 是首轮开发源码，**不是已经完成真机验收的成品 APK**。
本次交付包含可运行和自动测试的 Linux 网关、原创 Android 原生界面、DroidVM 源码整合脚本，以及 Guest 安装与 GitHub Actions 配置。
**没有生成 APK，没有完成手机 VM 启动验证，没有实际登录 Codex，也没有上传到 GitHub。** 完整验证矩阵见 [docs/STATUS.md](docs/STATUS.md)。

## 已确定的产品要求

项目名 Agbot；目标仓库 `Rumor30/Agbot`；Android 应用 ID `app.agbot.android`。
手机本地运行 Linux 虚拟机和执行工具，模型运行在云端。不需要本地大模型，不依赖用户手机上单独安装的 DroidVM APK。
首版接口是 **Codex OAuth、OpenAI Responses、OpenAI Chat Completions、Anthropic Messages**。

用户提供的目标设备数据：`M332BF / warsaw / sun`，Android 16，ARM64，root，存在 `/dev/gunyah`。这些仅用于适配目标，不等于已经确认成功启动 Guest，也不据此猜测 SoC 商业名称。

## 当前实现

| 模块 | 当前状态 |
| --- | --- |
| 三种 HTTP 模型协议 | 请求编码、SSE 与 JSON 响应、工具调用、结果回传、错误处理已实现；使用测试响应验证，未实连收费模型 |
| Codex OAuth | 通过官方 `codex app-server` 的设备码登录、账户、模型列表、任务、审批和中断接口；已做进程协议模拟测试，未真实登录 |
| Agent | 会话和工作区、有限轮次任务循环、文件与 Shell 工具、一次性审批、停止、幂等提交、重启后的中断标记 |
| Android | 原生聊天、事件、会话、文件浏览、修改预览、审批、协议设置、设备码授权入口、加密配置及配对文件导入；尚未编译 |
| DroidVM | 锁定源码版本，构建时改成独立 Agbot 包并内置高级 VM 管理入口；没有伪造 VM 控制接口 |
| Guest | 有非 root 服务、固定版本 Node/Codex 安装、TLS 证书和配对生成脚本；安装过程未实际执行 |
| 一键初始化 Computer | **未完成**：镜像创建、服务注入、自动连通和自动配对仍是核心剩余工作 |
| Computer 桌面 / 浏览器 | 上游管理界面保留；专用浏览器工具、Playwright、聊天内桌面接管尚未整合 |

### 为什么不是把 Codex 终端显示到手机

```text
Agbot Android 原生界面
        │ HTTPS + 私密配对令牌 + Guest 证书验证
        ▼
手机里的 Linux Guest（DroidVM）
        ├── Agbot Gateway / 会话 / 审批 / 工具
        ├── 官方 Codex app-server（只在 Codex 模式下启动）
        └── 项目文件 / Git / Bash / Python / Node
                         │ HTTPS
                         ▼
                     云端模型
```

Codex 模式由官方 CLI 负责 OAuth 和自己的 Agent 循环，Agbot 提供移动 UI、桥接、会话和审批。
另外三种协议使用 Agbot 自己的 Agent 循环。两条路径没有混用认证凭据。

## 源码目录

```text
android-overlay/           原创 Android 界面、安全存储、Guest 客户端与资源
upstream/DroidVM            Git 子模块引用，固定提交，不包含在离线包内
upstream.lock.json          上游版本与协议版本锁
scripts/bootstrap.py       获取上游及其锁定子模块，准备整合工程
scripts/prepare_android.py 保留 JNI namespace，替换包 ID 和入口，拒绝覆盖人工修改
scripts/package_guest.py   可重复生成仅含源码的 Guest 包
scripts/publish_github.py  用户本地运行的私有仓库创建/发布脚本
gateway/src/               不依赖 npm 第三方库的 Node.js 网关
gateway/test/              网关自动测试及明确标注的模拟 Codex 进程
guest/                     Linux Guest 安装脚本、systemd unit 与运行时锁
docs/                      架构、安全、已知问题、验收与接手记录
.github/workflows/         自动源码测试；手动触发 Android 构建
```

## 先运行不需要手机、不消耗模型额度的测试

需要 Linux、Node.js ≥22.16、Python 3.10+、Git、Bash。当前实测环境为 Node 22.16.0、Python 3.13.5。
网关没有 npm 第三方依赖，**不需要先执行 npm install**。

```bash
npm run check
npm test
python -m unittest discover -s tests -v
bash -n guest/install.sh scripts/build-android.sh
```

测试会在临时目录执行受控文件与 Bash 操作，模型/登录采用固定模拟响应，不连接真实模型账户。
生产入口始终拒绝 root；测试启动的非 root 实际进程不运行 Codex，也不操作手机。

## 构建独立 Android APK

需要可访问 GitHub/Google Maven 的网络、Git、Python、JDK 21、Android SDK（平台 37），以及上游 Gradle 下载的 NDK/native 依赖。
目标手机 Android 16 / SDK 36 不要求编译 SDK 与它相同；应用最小版本沿用上游 SDK 33。

```bash
# Linux / macOS，或 Windows 的 Python 终端
python scripts/bootstrap.py --build
```

也可以用 `scripts/build-android.sh` 或 Windows 的 `scripts/build-android.ps1`。
成功时 APK 路径为：

```text
upstream/DroidVM/app/build/outputs/apk/debug/app-debug.apk
```

**这个路径是预期构建输出，不是本次已经存在的文件。** 构建没有通过时不得将其记为已产出。
上游 Gradle Wrapper 在锁定的 DroidVM 源码里；顶层没有伪造 Wrapper 或空 APK。
主 namespace 保留 `cn.classfun.droidvm`，应用 ID 改为 `app.agbot.android`，以免破坏 JNI/资源解析。
默认不会覆盖手机里原来的 DroidVM 安装，也不会读取其私有数据。

脚本拒绝切换已有的不同上游提交，也拒绝覆盖人工修改。不使用 `git reset --hard`、`git clean` 或 `submodule update --remote`。
在 `upstream/DroidVM` 里直接修改的源码应先保存为补丁；不要用重跑准备脚本抹掉它们。

## 发布到 GitHub

当前对话所用 GitHub 连接能读写已有仓库，但没有创建仓库动作；目标仓库读取返回 404。
本次没有谎报已创建 `Rumor30/Agbot`，没有把代码放进用户别的项目。

已准备本地发布入口。先在自己的电脑完成 `gh auth login`，账号必须是 `Rumor30`，然后在项目目录执行：

```bash
python scripts/publish_github.py --create-private-repository
```

它默认创建 **私有** `Rumor30/Agbot`，使用名为 `github` 的 remote，不覆盖已有 `origin`；拒绝覆盖已有仓库、未提交修改和明显的凭据/二进制文件。不要把 GitHub Token 发到聊天。
Android 构建工作流只在 Actions 页面手动触发；**提供了配置不等于已经运行 CI**。

## Guest 初始化与模型接入

目前是开发者验证步骤，不是最终用户应承担的安装体验。
先在 **Agbot 自己内置的** DroidVM 管理界面创建并启动 Linux Guest；不要另装外部 DroidVM 来替代本项目整合。
细节见 [guest/README.md](guest/README.md)。最终版本仍需把这一段做成自动化。

API 模式在 Android 设置里填写协议、服务商实际模型 ID、API Base URL 和 API Key。支持 API 根路径及完整接口路径；只接受 HTTPS 云模型地址。
Codex 模式不需要 API Key：先配对 Guest，再使用“使用 ChatGPT 账户登录 Codex”，到官方页面输入设备码。账户权限、设备授权开关和真实联网情况需要后续验证。

## 安全边界

网关不接收 Android root 命令；root 只留给内置 VM 管理。自定义 Agent 的每次 `shell` / `write_file` 都要求一次性确认。
Codex 采用其固定版本的 `untrusted` + `workspace-write` 策略，**不等同于所有动作都弹框**；安全读取等行为可能直接执行。

**批准任意 Shell 命令相当于批准该 Linux 用户的能力。工作目录不是安全沙盒。** 同 UID 的 Shell 可能读取 Guest 内的 Codex 凭据和配对令牌。
当前没有做“管理凭据进程与工具进程不同 UID”的强隔离，不能给不可信任务宣称绝对安全。
项目文本与工具结果会发送给所选云服务商；本地 Computer 不意味着内容永不离开手机。
详细边界见 [docs/SECURITY.md](docs/SECURITY.md)。

## 许可证与来源

Agbot 新增代码使用 GPL-3.0-or-later。整合时保留 DroidVM 的许可证、版权、第三方说明和 `ADDITIONAL-PERMISSIONS`。
没有搬运 GrokBot 的泄露代码、专有 UI 或未知授权资源；只实现类似的使用方式。
固定版本与一手源码依据列于 [docs/SOURCES.md](docs/SOURCES.md)。
