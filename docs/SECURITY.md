# 安全与隐私

## 能够明确保证的代码行为

生产网关拒绝 uid 0；不提供 Android root exec API。桥接令牌必须是本用户拥有的私有普通文件，拒绝 symlink、组/全局可读写。
Host-to-Guest 非 loopback 监听要求 TLS；请求要求 Bearer 令牌，拒绝网页 Origin，不允许 CORS 放行。
Android 使用每 Guest 证书指纹或系统 CA 验证，无信任所有证书模式。API 模型只接受 HTTPS 地址，并不跟随跨源重定向。
配置写入采用 Android Keystore AES-GCM；旧配置解密失败会停止，不会静默清除后继续覆盖。

自定义工具 `shell` / `write_file` 都需要一次性审批；拒绝和超时不会执行。确认和工具结果带审计事件。
模型连接不自动重试可能重复产生计费/工具副作用的任务。用户停止会中断请求、待审批及已登记进程组。
GitHub 上传脚本不读取或要求输入 Token，不覆盖别的仓库，不使用 force push。

## 不能保证、不能误称的事情

**工作目录不是 Shell 沙盒。** 相同 Unix UID 能读这个用户可读的其他路径。模型获准执行恶意 Shell 后，可能访问该 Guest 的 Codex 登录材料、会话文件和配对令牌。
文件工具的路径检查不是对抗同 UID 并发恶意程序的完整 TOCTOU 防御。当前要求单任务工作区锁，不阻止其他人工程序修改它。
最重要的待办是将管理凭据与执行工具放到不同 UID/安全域，并建立最小能力通道；不能声称仅凭 `cwd`、`NoNewPrivileges` 或 VM 就做到密钥隔离。

Codex 使用 `untrusted` / `workspace-write`，并不代表每条安全命令和每个工作区内部变更都弹出 Agbot 审批。审批由固定版官方执行策略决定，未支持的新请求拒绝处理。
不要为修复 sandbox 错误改用 `danger-full-access`、`--dangerously-bypass-approvals-and-sandbox` 或 root。

有 Gunyah VM 不等于系统绝对安全：root VM 管理器、共享目录、Guest/Host 驱动、上游代码及未来发现的漏洞均在信任边界内。
默认不要共享完整手机文件系统；先在空白测试 VM 使用无敏感资料的工作区。

## 何种内容会离开手机

用户提示词、模型历史、相关文件片段、工具输出会按任务需要发送给选定的云端模型。自定义 endpoint 的运营者可能记录这些内容和 API Key。
本地 Computer 只是运行和存储位置，不是“完全离线”或“数据不出设备”的保证。
没有加入遥测或广告 SDK。用户显式导出的日志/配对文件仍可能含敏感信息，应在分享前审查。

## 凭据存放与轮换

Android：加密设置内有 API Key、桥接令牌、证书指纹与重试 outbox。应用备份关闭；改变设备/丢失 Keystore 后不保证能恢复这些设置。
Guest：官方 Codex 数据在 `/home/agbot/.codex`；桥接令牌在 `/var/lib/agbot/bridge.token`；TLS 私钥在 `/etc/agbot/guest.key`。
会话状态是权限受限的本地文件，不是应用自行加密的数据库。

不要上传 `.env`、`auth.json`、`pairing.json`、`bridge.token`、TLS 私钥或应用签名 keystore。
模板里不放真实凭据。测试中的 `TEST_ONLY_*` / `TEST_KEY_DO_NOT_USE` 均是假值，不能用于服务登录。
发现凭据泄露时应在相应云账户撤销授权/密钥，停止 Guest 服务，旋转配对令牌并重新配对。仅删除 Git 文件不能撤回已经提交的密钥。

## 未完成的加固

进程间凭据强隔离；Guest 网络 egress 限制；认证速率限制；磁盘配额与日志批量持久化；APK 依赖供应链扫描；签名密钥生命周期；真机后台/休眠/断电恢复；安全审计与恶意任务测试。
当前版本限开发测试，不应在含高价值私密数据的主工作环境直接授予广泛 Shell 权限。
