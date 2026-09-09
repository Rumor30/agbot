# 当前交付状态：0.1.0-dev.1 / 首个 APK 里程碑

更新日期：2026-09-09。此文件取代首轮源码交付时“未上传 GitHub、未运行 CI、没有 APK”的旧状态。

## 一句话判断

**源码已推送 `Rumor30/agbot`；真实 Android 编译、签名与 APK 载荷校验已通过，Debug APK 已产出。自动创建 Linux、Guest 自动配对和目标手机 Gunyah / 真实模型的端到端链路尚未完成。**

准确构建提交、产物、校验值、模拟器结果见 [APK_BUILD.md](APK_BUILD.md)。源码合并成功或普通 Android 模拟器通过，不等于目标手机上的 VM 已启动。

## 已完成并有证据

- 锁定并实际获取 DroidVM `72391c44f3a08994f513cd61205496e6f7dfd5ae` 及其递归子模块，没有浮动更新底层。
- 修复 CI 的 SDK 包名；实际安装 `platforms;android-37.0`，保持上游 compile/target SDK 37，未为通过构建降低版本。
- 用完整上游工程实际执行 `:app:assembleDebug`，经过 Java/Kotlin、资源、DEX、ARM64/x86_64 native 和 APK 签名，不是语法解析或空壳占位 APK。
- 校验应用 ID `app.agbot.android`、启动入口 `app.agbot.android.AgbotActivity`、Debug v2 签名、ZIP 对齐与 CRC、编译后的入口类、ARM64 ELF 及固定版本预构建运行时。
- 拆包发现并修复 Guest `.gz` 资产被 AAPT 自动解压/改名的问题；APK 内改用 `.tgz`，逐字节对照当前源码生成的 Guest 包。
- 对同一份交付 APK 在 Android 16 / API 36 模拟器实际安装、冷启动并切换聊天、Computer、设置页面，保留截图、UI XML 和日志；不替代 Gunyah 真机验证。
- 原有网关与协议测试继续运行于 GitHub Actions 的 Node 22.16.0 / 24.20.0；取消测试改为等待真实协议事件，避免用固定 80 ms 假设进程启动时间。
- 新增 APK 结构校验、合法小型 ELF 与 Guest 旧资产安全迁移的回归测试。

## 功能边界

| 模块 | 当前可确认的状态 | 尚不能宣称 |
| --- | --- | --- |
| Android App | 原生聊天、会话、审批、文件、设置和 Computer 页面已编译入独立 APK | warsaw 真机适配全部通过 |
| 模型协议 | Responses / Chat Completions / Anthropic 请求、流、工具回传和错误处理已实现并模拟测试 | 三种真实服务商均联调成功 |
| Codex | 官方 app-server 设备码登录、账户、模型、任务、审批、中断桥接代码与模拟测试 | 已用真实账户登录或在 ARM64 Guest 跑通 |
| Linux 网关 | 文件、Shell、一次性审批、工作区锁、幂等提交、持久状态与重启中断测试通过 | 完整沙盒安全隔离、永久后台驻留 |
| Guest 安装 | 安装脚本和配对生成逻辑已写，源码安装包正确内置 APK | 已在 DroidVM ARM64 Guest 安装验证 |
| DroidVM | 完整源码构建、固定运行时打包、高级管理入口保留 | 自动创建/启动/配置 Computer 已完成 |
| 本地 VM | 目标日志确认 `/dev/gunyah` 存在 | 节点存在等于 Gunyah 启动成功 |

## Root 要求没有改变

Android 宿主机运行本地 VM **要求 root**。Agbot 不继承另一个 DroidVM 安装的授权和私有数据。
Linux Guest 的首次安装需要 Guest root；长期网关降权到独立 `agbot` 用户。Android root 与 Guest 用户权限是两层，不能混为一谈。
普通 Android 模拟器的 APK 安装/界面测试不是非 root 虚拟化模式；不新增 Android 非 root 的完整产品承诺。

## 下一阶段优先级

1. 保持已打通的 APK 构建，继续对产物而非仅对源码做验收。
2. 读取并改造实际 VM 创建/镜像导入/daemon 生命周期，实现固定镜像校验、磁盘、Guest 服务注入、网络发现、私密配对与真正的 Computer 状态。
3. 在目标 warsaw Android 16 设备验证独立 APK、root 授权、运行时解包、Gunyah 启动和 Guest 连接。失败保留日志，不改软件模拟假装成功。
4. 用真实 Codex 账户与三种真实 API endpoint 各验证一次任务、审批、拒绝和中断。凭据由用户本地填写，不发到聊天或 GitHub。
5. 分离模型凭据与任意工具进程 UID，再做后台、休眠、断网、进程死亡和恢复测试。
6. 完成浏览器、Playwright、桌面接管与持久开发服务器预览。

## 仍需保留的限制

默认任务上限 24 轮/20 分钟；Shell 默认 90 秒/128 KiB 输出；单文件工具 256 KiB；上下文约 768 KiB；事件保留最多 2000 条。不是模型服务商额度。
同 UID 的已批准 Shell 可能读取 Guest 凭据；工作目录不是权限沙盒。文本脱敏不等于强隔离。
断开手机界面不等于停止 Guest 任务；服务重启不会自动重放命令，仍需检查结果未知的文件修改。
尚未提供正式发布签名和稳定升级策略；Debug APK 不是安全审计后的正式版。
