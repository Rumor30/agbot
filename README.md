# Agbot

**云端模型，手机本地 Linux Computer，触屏对话界面。**

`0.1.0-dev.1` 已在 GitHub Actions 完成真实 Android 编译，产出 Debug APK，并通过同一 APK 的 Android 16 模拟器安装与基础界面检查。
**这仍是开发版，不是已完成 Gunyah 真机验收、自动 Linux 初始化和真实模型联调的成品。**
准确构建提交、产物、校验值和截图日志位置见 [docs/APK_BUILD.md](docs/APK_BUILD.md)；完整状态见 [docs/STATUS.md](docs/STATUS.md)。

## 下载

打开仓库 Actions 的 [Android debug APK 构建 #5](https://github.com/Rumor30/agbot/actions/runs/34340673547)，下载 Artifacts 中的 **Agbot-debug-5**，解压得到 `Agbot-debug.apk`。
该文件为约 126.1 MB / 120.3 MiB 的真实 APK，不是源码包。应用 ID 为 `app.agbot.android`，版本 `0.1.0-dev.1`，最小 Android 13。
构建及 UI 验证证据分别位于 `android-build-evidence-5`、`android-ui-smoke-5`。产物设置保留 30 天。

## 产品方向与权限

模型在云端；Linux 虚拟机、工具执行和项目文件在手机本地。不需要本地大模型，不依赖手机上另装的 DroidVM APK。
首版接口为 **Codex OAuth、OpenAI Responses、OpenAI Chat Completions、Anthropic Messages**。

**Android 宿主机运行本地 VM 要求 root；Guest 首次安装需要 Guest root；长期网关使用非 root 的 `agbot` 用户。**
普通 Android 模拟器上的界面测试不是“非 root Android 可使用 Gunyah”的证明。
适配目标来自用户设备日志：`M332BF / warsaw / sun`、Android 16、ARM64、root、存在 `/dev/gunyah`。节点存在不等于 VM 已启动，不据此猜测 SoC 商业名称。

```text
Agbot Android 原生界面
        │ HTTPS + 私密配对令牌 + Guest 证书验证
        ▼
手机里的 Linux Guest（DroidVM）
        ├── Agbot Gateway / 会话 / 审批 / 工具
        ├── 官方 Codex app-server（Codex 模式）
        └── 项目文件 / Git / Bash / Python / Node
                         │ HTTPS
                         ▼
                     云端模型
```

## 当前实现与剩余工作

| 模块 | 当前状态 |
| --- | --- |
| Android | 原生聊天、会话、文件浏览、修改预览、审批、设置、配对导入和 Computer 页面；已编译，基础界面通过模拟器检查 |
| DroidVM | 固定源码及递归子模块实际构建，保留独立 Agbot 包内的高级 VM 管理入口，固定 ARM64 runtime 已打包 |
| 三种 HTTP 协议 | 请求、SSE/JSON 响应、工具调用、结果回传、错误处理已实现；采用模拟响应测试，未实连收费模型 |
| Codex OAuth | 官方 app-server 设备码、账户、模型、任务、审批和中断桥接；模拟进程协议测试通过，未真实登录 |
| Linux 网关 | 文件/Shell、一次性审批、停止、幂等提交、工作区锁、持久状态和重启中断处理 |
| Guest 安装 | 固定 Node/Codex、TLS、配对和 systemd 脚本已写；源码安装包正确内置 APK；未在 ARM64 Guest 实际安装 |
| 一键 Computer | **未完成**：镜像创建、服务注入、网络发现、自动配对仍是核心剩余工作 |
| 浏览器与接管 | 上游高级界面保留；专用 Playwright 工具、聊天内桌面接管和开发服务器预览尚未整合 |

## 构建与测试

需要 Linux、Node.js ≥22.16、Python 3.11+、Git、Bash。网关没有 npm 第三方依赖，不需要先 `npm install`。

```bash
npm run check
npm test
python -m unittest discover -s tests -v
bash -n guest/install.sh scripts/build-android.sh
```

这些测试在临时目录执行受控操作；云端响应和登录采用 fixture，不消耗真实账户额度。详细记录见 [TEST_REPORT.md](docs/TEST_REPORT.md)。

Android 构建另需 JDK 21、Android SDK 和可访问上游依赖的网络。当前真实 SDK 包名是 `platforms;android-37.0`，不是 `platforms;android-37`。

```bash
sdkmanager 'platforms;android-37.0' 'build-tools;36.0.0' 'cmake;3.22.1'
python scripts/bootstrap.py --build
```

也可使用 `scripts/build-android.sh` 或 `scripts/build-android.ps1`。
原始输出路径为 `upstream/DroidVM/app/build/outputs/apk/debug/app-debug.apk`；CI 校验后复制为 `dist/Agbot-debug.apk`。
编译/target SDK 37、最小 SDK 33；目标手机 API 36 不要求编译 SDK 相同。
脚本会获取固定 DroidVM checkout 和其子模块，保留 JNI namespace `cn.classfun.droidvm`，独立应用 ID 为 `app.agbot.android`。
脚本拒绝覆盖人工修改、不同版本的已有 checkout；不执行 reset、clean 或浮动子模块更新。

相关源码和构建脚本提交会自动构建 APK，也支持 Actions 的 Run workflow；单独文档或测试修改不必重建 APK。
Debug 签名不是正式发布签名，当前没有持久发布密钥方案，不保证不同 CI 构建签名一致。遇到签名冲突先保存数据，不要盲目卸载。
源码已经在 `Rumor30/agbot`，不需要重新建仓或执行初始发布脚本。

## 源码位置

`android-overlay/` 是原创 Android 界面与资源；`gateway/` 是 Linux 网关与测试；`guest/` 是安装/systemd/运行时锁；`upstream.lock.json` 锁定上游。
`scripts/bootstrap.py` 获取上游，`prepare_android.py` 应用源码修改，`package_guest.py` 生成确定性 Guest 包，`verify_apk.py` 校验真实 APK 载荷，`smoke_android.py` 执行模拟器安装和 UI 检查。
`upstream/DroidVM` 是构建时获取的 checkout，不包含在源码 ZIP 中。Gradle Wrapper 来自固定上游，没有伪造空 Wrapper 或 APK。

## Guest 与模型接入

目前的一次性 Guest 初始化仍是开发者验证步骤，不是最终用户应承担的安装体验；细节见 [guest/README.md](guest/README.md)。最终目标仍是自动化，不以另装外部 DroidVM 替代本项目整合。
API 模式在设置中填写协议、实际模型 ID、API Base URL 和 API Key，只接受 HTTPS 云端地址。
Codex 模式先配对 Guest，再通过官方设备授权页面登录，不需要 API Key。账户权限和真实联网尚待验证；不要把凭据发到聊天或 GitHub。

## 安全与来源

Agbot 网关不提供 Android root exec；宿主 root 仅用于内置 VM 管理。自定义 Agent 的 Shell/写文件要求一次性审批。
Codex 使用固定版本的 `untrusted` / `workspace-write`，不代表所有安全读取都弹框。不要为绕过错误改成无沙盒或 root。
**工作目录不是权限沙盒。** 同 UID 的已批准 Shell 仍可能读取 Guest 凭据；强 UID 隔离、安全审计、后台/休眠恢复和正式签名尚待完成。
项目文本与工具结果会发送给所选云模型，本地 Computer 不意味着数据永不离开手机。详见 [SECURITY.md](docs/SECURITY.md)。

新增代码使用 GPL-3.0-or-later，整合时保留 DroidVM 和第三方声明。没有搬运 GrokBot 泄露代码、专有 UI 或未知授权资源。
版本与一手来源见 [SOURCES.md](docs/SOURCES.md)。
