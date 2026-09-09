# 验证记录

更新日期：2026-09-09。首轮源码阶段的旧日志仍保留于 `docs/test-results/`；以下明确区分新增真实 APK 验证与模拟测试。

## 真实 Android 构建与产物

GitHub Actions 使用 Ubuntu 24.04、JDK 21、Android command-line tools 20.0、SDK 包 `platforms;android-37.0`、build-tools 36.0.0、CMake 3.22.1，以及锁定 DroidVM 的 Gradle Wrapper 9.6.0 和 AGP 9.2.1。
完整上游和递归子模块实际获取后，运行 `./gradlew --no-daemon --stacktrace --console=plain :app:assembleDebug`。
最终记录、提交、SHA-256、签名指纹和模拟器状态见 [APK_BUILD.md](APK_BUILD.md)。

已执行的产物检查：
- `aapt dump badging` 核对包 ID、版本、最小/目标 SDK 与 launcher；另存编译后的 Manifest。
- `apksigner verify --verbose --print-certs` 与 `zipalign -c 4`。
- Python ZIP CRC、重复文件名、DEX magic 和编译后的 `AgbotActivity` 描述符检查。
- 必需 ARM64 ELF 的机器类型、程序头及可执行 PT_LOAD 段边界检查。
- 内置 Guest gzip 源码包与同次 checkout 的生成结果逐字节比较。
- 内置预构建 runtime 与锁定上游 checkout 的 JSON、XZ 文件逐字节比较。
- 下载 GitHub 产物后再次独立核对 SHA-256、CRC 和 Guest 包内容。

普通 Android 模拟器安装与界面导航是另一项检查，不测试 Gunyah、root 授权、Guest 安装或云模型。

## 本地组件测试

本轮在 Linux x86_64 开发容器中实际执行：

```text
npm run check
  JavaScript syntax checks passed.
npm test
  53 tests, 53 pass, 0 fail, 0 skip
python -m unittest discover -s tests -v
  23 tests, OK
java scripts/JavaSyntaxCheck.java <three Android Java files>
  Parsed 3 Java files (syntax only)
bash -n guest/install.sh scripts/build-android.sh
  exit 0
```

合计本地 76 项自动测试通过。另对 Codex fixture 测试套件以 4 并发重复 24 次，0 次失败。
GitHub 的 Node 22.16.0 / 24.20.0 两组工作流均通过；普通非 root CI worker 会跳过仅用于验证 root 拒绝的测试，不应将其冒称为在 CI 已执行。

## 这轮发现并修复的问题

1. `platforms;android-37` 不存在；升级命令行工具并读取包列表后使用真正发布的 `platforms;android-37.0`，没有降低 compile/target SDK。
2. 首次已编译 APK 中 `.tar.gz` 资产被 AAPT 展开并去掉 `.gz`，与 UI 的读取路径不符。改成内部 `.tgz`，外部导出仍叫 `agbot-guest.tar.gz`，并加入真实 APK 内容校验与旧资产迁移测试。
3. Codex 取消测试不能假定 80 ms 内子进程已启动，改为等待 `turn/started`，再验证正确 thread/turn 收到 `turn/interrupt`。
4. APK 校验脚本最初误把小于 4096 字节的真实 Android 16 compatibility shim 当作占位文件。改为验证 ELF 可执行 LOAD 段与边界，保留 ARM64、文件完整性和上游字节一致性检查，并新增针对性回归。

## 模拟的范围

三种云端 API 的 SSE/JSON 响应采用 fixture；Codex 登录和 app-server 使用模拟子进程，不是实际账户。
Python 准备脚本测试采用合成 Git checkout；APK verifier 的单元测试采用明确标注的合成 ZIP/ELF，这些不能替代上面已经执行的真实 Android 构建与真实 APK 校验。
文件、Bash、HTTP、状态恢复等测试确实运行在临时目录，非 root 生产网关测试确实以普通 Linux UID 启动；它们不操作用户手机。

## 必须补充的真机与端到端验收

目标手机安装/日志、Agbot root 授权、Gunyah Guest boot log、Host ↔ Guest TLS、ARM64 官方 Codex 版本和真实登录、三种实际 API 各一次工具审批任务，以及拒绝/停止、掉网、后台休眠、重启恢复。
没有这些证据，不能将“已有 APK”写成“自动 Linux + 云端模型完整产品已完成”。
