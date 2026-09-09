# Agbot 首个已验证 Debug APK

记录日期：2026-09-09。这里记录的是实际产物，不是预计的输出路径。

## 下载与对应源码

- 仓库：`Rumor30/agbot`，`main`。
- [Android debug APK 构建 #5](https://github.com/Rumor30/agbot/actions/runs/34340673547)：编译/载荷验证和 Android 16 UI smoke 两个 job 均成功。
- 精确构建源码提交：`f9d95c9cff11cfef0d7cd8c87730285af8662cb1`。后续文档提交不改变这份 APK 对应的源码。
- APK artifact：`Agbot-debug-5`，ID `10099691480`；下载 ZIP 并解压得到 `Agbot-debug.apk`。
- 构建记录 artifact：`android-build-evidence-5`，ID `10099691986`。
- 安装/界面截图和日志 artifact：`android-ui-smoke-5`，ID `10099822360`。
- 本次 Actions 产物设置保留 30 天，预计 2026-10-09 到期；到期后应从固定提交重新构建，而非依赖过期地址。

## APK 身份

| 项目 | 实际值 |
| --- | --- |
| 应用名 | Agbot |
| 包名 | `app.agbot.android` |
| 启动入口 | `app.agbot.android.AgbotActivity` |
| versionName / versionCode | `0.1.0-dev.1` / `1` |
| 最小 SDK | 33（Android 13） |
| compile / target SDK | 37 / 37 |
| APK 字节数 | 126111120（约 126.1 MB / 120.3 MiB） |
| APK 签名 | Android Debug，APK Signature Scheme v2 验证通过 |

APK SHA-256（不是外层 artifact ZIP 的散列）：

```text
cf4f61c63a92161f23734355133329c275aeda508ae0f79226acb62838e29da5
```

签名证书 SHA-256：

```text
dc8cb24cab6bb627d6258ce4841b55e88d851b190c0f150edaae3fa3705101b3
```

Debug 签名不是正式发布签名；不同 CI 构建可能生成不同 Debug 密钥。不要为了绕过签名冲突而直接卸载、丢弃已有应用数据。

## 实际通过的验证

完整源码编译执行了 `:app:assembleDebug`，最终日志为 `BUILD SUCCESSFUL in 1m 44s`、`47 actionable tasks: 47 executed`。
没有省略 native 构建，也没有替换成占位运行时。上游 Gradle 的弃用警告仍存在，不宣称零警告。

`aapt` 确认包名、版本和启动入口；`apksigner` 验证签名；`zipalign -c 4` 通过。
`scripts/verify_apk.py` 对真实 APK 检查 ZIP CRC、重复条目、DEX 和编译后的 AgbotActivity、必需 ARM64 ELF 及其可执行段。
APK 内 `assets/agbot/agbot-guest.tgz` 与本次源码生成的 gzip 包完全一致；预构建 JSON/XZ 与固定上游 checkout 完全一致。
下载 artifact 后，又在独立容器核对 APK SHA-256、ZIP CRC 和 Guest gzip 包逐字节一致性。

**Android 16 / API 36 的 x86_64 Google APIs 模拟器实际安装成功，并通过冷启动和页面导航检查：聊天 → Computer → 设置 → 聊天。**
`adb install` 返回 `Success`，`am start -W` 返回 `Status: ok`，最后进程仍存在。截图与 UI XML 来自运行中的 App，不是设计稿。
模拟器测试的 APK SHA-256 与上面交付 APK 一致。

## 固定上游与运行时

DroidVM：`72391c44f3a08994f513cd61205496e6f7dfd5ae`，此次查询时仍为上游 master。
Prebuilts：`5cc4aa892c8cd25b77b386e787442ce6975cfa31`。
其余递归子模块的实际提交列在构建记录 artifact 的 `submodules.txt`。

工具链：JDK 21、command-line tools 20.0、实际 SDK 包 `platforms;android-37.0`、build-tools 36.0.0、CMake 3.22.1、上游 Gradle Wrapper 9.6.0 / AGP 9.2.1。

本 APK 包含 ARM64 与 x86_64 native 库，但完整预构建 VM runtime 是 ARM64。x86_64 模拟器界面通过不代表 x86_64 虚拟机功能已支持。

## 本轮修复轨迹

1. 构建 #1、#2 暴露 SDK 包名不匹配；读取实际列表后改为 `android-37.0`，没有降低目标 SDK。
2. 构建 #3 首次真实编译成功。拆包后发现 AAPT 将 `.tar.gz` 自动展开为 `.tar`，与 UI 读取路径不符，不作为最终推荐产物。
3. 内部改用 `.tgz`，加入真实 APK 校验；外部导出仍使用常见的 `agbot-guest.tar.gz` 文件名。
4. 修正校验器对合法 3816 字节 compatibility shim 的误判，以 ELF 可执行段边界替代任意文件大小阈值，并保留回归测试。
5. 构建 #5 的 APK 编译、签名、载荷校验、实际模拟器安装和界面导航全部通过。

## 未完成，不能被本次成功替代

**没有连接目标 warsaw 手机；没有验证 Android root 授权、Gunyah Guest 启动、Guest 安装、真实模型登录或一键 Computer 初始化。**

应用仍是开发版：高级 VM 管理入口已内置，但自动下载/创建 Linux、服务注入、网络发现和私密自动配对尚待实现。
Linux 网关以非 root 用户运行，Android 宿主机的本地虚拟化仍要求 root；模拟器只是 UI 测试，不是非 root 产品模式。
Codex 和三种 API 的协议实现已测试，但云端响应/登录仍采用模拟，不应写成真实账户可用。
