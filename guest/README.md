# Linux Guest：开发者验证安装

此流程运行在**手机内的独立 Debian/Ubuntu ARM64 虚拟机**里，不是 Android root / Termux。
现阶段只完成脚本，不代表已经在用户手机安装成功。不要把 Linux 安装和网络连通的未完成部分从验收中删掉。

## 安装前

Guest 必须可以启动到正常 Linux 用户空间，以 systemd 为 PID 1，具有 apt-get、可用 DNS 和 HTTPS 网络。
内存/磁盘尚未取得用户完整实测；4 vCPU、约 4 GiB RAM 只能作为候选配置，不能自动强制预留。
不要挂载整个 Android `/data`、私人相册、下载目录或其他项目；先使用专门的空白测试磁盘。

在 Agbot Computer 页导出 `agbot-guest.tar.gz`，把它复制进自己确认的 Linux Guest，解压并检查脚本。
或者在电脑生成相同源码包：

```bash
python scripts/package_guest.py --output artifacts/agbot-guest.tar.gz
```

仅在已启动的 Guest 中执行：

```bash
tar -xzf agbot-guest.tar.gz
cd agbot-guest
sudo bash guest/install.sh --guest-confirmed
```

脚本会安装系统依赖，下载并校验锁定的 Node 24.20.0 ARM64/x64 包，用 npm 安装固定的官方 `@openai/codex@0.153.4`（禁止生命周期脚本），创建非 root `agbot` 服务用户。
它不会登录模型账户，也不会索要任何 API Key。
对已有的非本项目 `/opt/agbot`、`/opt/agbot-runtime` 或 systemd unit 会拒绝覆盖。
已有版本的源码保留在 `/opt/agbot/releases/`；有运行中的任务时进行显式升级会停止服务，应先停任务并备份。

目录：

```text
/opt/agbot-runtime/            root 管理的公开运行时文件
/opt/agbot/releases/<hash>/    root 管理的网关代码
/opt/agbot/current             当前版本软链接
/etc/agbot/guest.key           Guest TLS 私钥，root:agbot 0640
/etc/agbot/guest.crt           Guest TLS 证书
/etc/agbot/gateway.env         仅含路径/监听配置，不放模型 Key
/var/lib/agbot/bridge.token    配对令牌，agbot 0600
/var/lib/agbot/pairing.json    带令牌的私密配对文件，agbot 0600
/var/lib/agbot/sessions/       会话状态和工具事件
/home/agbot/workspaces/        任务工作目录
/home/agbot/.codex/            官方 Codex 管理的登录/会话数据
```

## 连接 Android

服务默认 HTTPS 8765，使用每个 Guest 单独生成的证书。配对文件包含地址、令牌和证书 SHA-256。
在 Agbot 中“导入 Computer 配对文件”，核对它确实来自自己的 Guest，再确认。
**不要发送 pairing.json、bridge.token、guest.key 或 Codex auth.json 到聊天、GitHub 或公共网盘。** 删除用于中转的副本。

首次导出的 Guest 地址只是首个非 loopback IPv4，**并不保证 Android 能访问**；需要核对所选 DroidVM 网络模式、路由和防火墙。
不是默认有 `vsock`，也不是把 Guest 的 `127.0.0.1` 当成 Android 的 `127.0.0.1`。
可在安装时用 `AGBOT_ADVERTISED_HOST` 指定经验证可达的 Guest IPv4/主机名。

开发版尚未实现自动 Guest IP 发现、端口通道建立、安装包注入和自动配对。
不要为“连不上”把服务改成公网无认证或非 loopback 明文 HTTP；不要全局关闭 SELinux。

## 检查

```bash
systemctl status agbot --no-pager
journalctl -u agbot --since today --no-pager
uname -a
cat /etc/os-release
ip addr
ip route
```

分享日志前手动删除所有令牌、私钥、Cookie、模型 Key 和个人项目内容。
在 Android 点“检查 Guest 连接”。返回的健康信息证明网关可达，不证明所有工具或 Codex 登录完成。
登录 Codex 后用无敏感数据的临时工作区验证“写 hello.txt → 审批 → 返回文件内容 → 停止任务”。

## 验证失败时

脚本失败应保留错误并停止，不能用 `--dangerously-bypass-approvals-and-sandbox`、root 网关或假返回来掩盖。
Codex 在 Guest 内能否启用它的 Linux sandbox，还取决于用户命名空间、内核和服务限制；目前未在该设备验证。
TLS 证书轮换后需要重新配对。配置不是仅仅把旧指纹删除后无条件信任。
Node/Codex 下载、npm 的 ARM64 可执行包、systemd 单元和手机网络均有独立验收项。
