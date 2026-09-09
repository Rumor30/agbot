# Agbot 开发接手规则

需求无需重问：Agbot；目标 Rumor30/agbot；云端模型；Codex OAuth + Responses + Chat Completions + Anthropic；单 APK 整合 DroidVM 源码；目标 warsaw Android 16 / Gunyah，不能依赖外部已安装 DroidVM。

先读 `docs/STATUS.md`、`docs/APK_BUILD.md`、`docs/ARCHITECTURE.md`、`docs/SECURITY.md` 与 `docs/TEST_REPORT.md`。
真实 APK 构建及 Android 16 模拟器安装/基础界面已通过；不要重复声称只有 Java parse。
不把源码、模拟协议测试或模拟器 UI 通过宣称为真实 OAuth、Gunyah 真机成功或一键 Linux 初始化完成。

## 必须保持

- Android 宿主本地 VM 要求 root；不提供完整非 root 产品模式。不给 Agent Android root Shell。生产 Guest 网关不能 root 运行。
- 不抓浏览器 Cookie，不伪造 OAuth，不用非公开后端替代官方 app-server。
- 协议版本升级必须核对该版生成 schema；当前 Codex 0.153.4。
- DroidVM baseline 固定 SHA；不得重置、清理用户/接手者的修改。
- 凭据、签名私钥、模型权重或字体文件不进入新增源码包或 Git。
- 不操作其他仓库，不 force push，不默默改变可见性。
- 保留真实 DEX / ARM64 ELF / 固定运行时 / Guest 内容验收，不能用占位成功绕过。
- APK 内 Guest 资产使用 `.tgz`，避免 AAPT 自动解压并改名 `.gz`；外部导出仍可叫 `.tar.gz`。

## 验证命令

```bash
npm run check
npm test
python -m unittest discover -s tests -v
java scripts/JavaSyntaxCheck.java $(find android-overlay -name '*.java')
bash -n guest/install.sh scripts/build-android.sh
```

JavaSyntaxCheck 只 parse；真正 APK 来自 `.github/workflows/android.yml` 中的完整 Gradle 构建。
新增并发、停止、跨会话、凭据或路径行为必须配回归测试。

## 接续重点

固定构建提交与 SHA-256 在 APK_BUILD.md。下一阶段是自动 Guest 初始化和目标手机 root/Gunyah/Guest/真实模型联调，不是重写已经可构建的界面。
普通模拟器只用于安装及 UI 检查；x86_64 界面通过不代表完整 VM runtime 支持 x86_64。
当前 GitHub 仓库已存在且已推送；不再执行初始建仓脚本，不回到临时 Firestorage 导入流程。
