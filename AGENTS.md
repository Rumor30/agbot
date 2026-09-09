# Agbot 开发接手规则

需求无需重问：Agbot；目标 Rumor30/Agbot；云端模型；Codex OAuth + Responses + Chat Completions + Anthropic；单 APK 整合 DroidVM 源码；目标 warsaw Android 16 / Gunyah，不能依赖外部已安装 DroidVM。

先读 `docs/STATUS.md`、`docs/ARCHITECTURE.md`、`docs/SECURITY.md` 与 `docs/TEST_REPORT.md`。
不把源码、语法解析、模拟协议测试或 GitHub Actions 配置宣称为实际 APK、真实 OAuth、真机成功或已推送仓库。

## 必须保持

- 不给 Agent Android root Shell。生产 Guest 网关不能 root 运行。
- 不抓取浏览器 Cookie，不伪造 OAuth，不使用 Codex 非公开后端替代官方 app-server。
- 版本升级必须核对该版本生成 schema；当前是 Codex 0.153.4。
- DroidVM baseline 固定 SHA。不得重置、清理用户/接手者的改动。
- API Key/配对文件/签名私钥/模型权重/字体文件不进入源码包或 Git。
- 不覆盖其他 GitHub 仓库，不 force push，不默默改成公开仓库。
- 本地生成的未测试功能需要标记未验证，不能用成功占位返回绕过硬件条件。

## 验证命令

```bash
npm run check
npm test
python -m unittest discover -s tests -v
java scripts/JavaSyntaxCheck.java $(find android-overlay -name '*.java')
bash -n guest/install.sh scripts/build-android.sh
```

JavaSyntaxCheck 只 parse，不编译 Android API/资源，不生成 APK。
新增并发、停止、跨会话、凭据或路径相关行为必须配回归测试。
下一关键步骤是能够联网且有 Android 工具链的环境里真正执行 `python scripts/bootstrap.py --build`，修复实际 Gradle/JNI/Manifest/API 编译问题；随后再整合一键 Guest 初始化并在目标机验收。
