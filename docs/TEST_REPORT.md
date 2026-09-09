# 本地验证记录

执行日期：2026-09-09。

## 环境

Linux x86_64 开发容器；Node.js 22.16.0；Python 3.13.5；OpenJDK 21；本地 Git。
没有连接目标 Android 手机，没有 Android SDK / NDK / Gradle 构建结果。
Guest 目标 Node 24.20.0 和 Codex 0.153.4 没有在该环境安装或运行。

## 实际命令与结果

```text
npm run check
  JavaScript syntax checks passed.

npm test
  tests 53 / pass 53 / fail 0 / cancelled 0 / skipped 0

python -m unittest discover -s tests -v
  Ran 12 tests / OK

java scripts/JavaSyntaxCheck.java <three Android Java files>
  Parsed 3 Java files.
  Syntax only: NOT an Android compilation or APK build.

bash -n guest/install.sh scripts/build-android.sh
  exit 0

python scripts/publish_github.py
  exit 2, explicit creation flag missing, no remote changes made
```

合计 **65 项自动测试通过**，另有语法解析和脚本拒绝路径检查。
原始输出保存在 `docs/test-results/`。本次记录不包含未来 GitHub Actions 的结果。

## 有真实副作用的测试

临时工作目录中的读写、哈希与修改前校验、符号链接拒绝；受控 Bash 命令、输出限制、取消与进程组清理；真实本地 HTTP 监听和认证；临时用户目录状态写入、重启中断修复。
额外测试通过 uid 65534 启动真实生产网关，验证私有令牌生成、拒绝不安全文件权限/软链接、HTTP 401 和带令牌的 HTTP 200、非 root uid、SIGTERM 正常结束。
以上均在临时目录，不读取用户项目，不向云模型发任务。

## 明确采用模拟的测试

三种云端 API 的 SSE/JSON 响应为测试 fixture；模型推理结果非真实账户返回。
Codex 用本项目测试进程模拟官方发布 schema 的 JSON-RPC 交互。核对过 0.153.4 的上游字段，但**模拟不能证明 CLI/账户可用**。
Python 构建准备测试用合成小型 Git repository 验证修改/幂等/拒绝覆盖逻辑，不能代替完整 DroidVM source build。
JavaSyntaxCheck 只调用 javac 的 parse 阶段，不做 Android 类型归因和资源校验。

## 必须追加的验收证据

Gradle 完整构建日志和 APK hash；独立应用安装和启动截图/日志；Gunyah guest boot log；Host ↔ Guest TLS 连接；ARM64 官方 Codex 二进制版本与真实登录状态；三种实际 API 各一次审批任务；拒绝/停止、掉网、后台休眠、重启恢复结果。
没有这些证据，不应把本版标注为“端到端完成”或“可直接安装使用”。

## 交付副本回归

首次在权限为 0700 的外层目录还原 bundle 时，有 3 项非 root 生产入口测试因测试源码路径不可遍历而失败。
这是测试夹具对原工作目录可读性的隐式依赖，不是通过改运行用户来绕过 root 拒绝。
修复为：把仅含公开运行时源码的副本放入专门的临时目录，再以非 root 身份执行；不放宽还原目录权限。
修复后从新的 bundle 在同类私有目录再次还原并完整复测，结果另外记录在交付说明中。
