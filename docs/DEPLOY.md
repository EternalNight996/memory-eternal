# 私有化部署（Docker / 内网服务器 / systemd）

memory-eternal 是 **MIT 开源** 的本地优先记忆库。私有化部署的目标是：
**数据 100% 留在你自己的服务器**，不经过任何第三方云；适合内网、合规、以及「不想把记忆交给 SaaS」的团队。

> 当前形态：**单租户**（一个实例 = 一个记忆库）。应用本身没有账号体系，对外访问必须由反向代理做认证（见下文 Caddy 示例）。
> 多租户 / 组织权限 / 跨机同步仍在 roadmap，不在本部署方案内。

## 架构

```
浏览器 / 内网用户
   │  HTTPS + Basic Auth（Caddy / Nginx）
   ▼
memory-eternal 容器（node，127.0.0.1:7999 或容器内 0.0.0.0）
   │
   ▼
/data/memory-eternal.db  ← SQLite + WAL（卡片、审核队列、账本、审计日志）
/data/backups/           ← 每日/手动备份
```

MCP 仍是 **stdio 本地进程**：同机的 Claude Code / Codex / Cursor 用 `dsh-memory setup` 挂载；远程机器暂时不能直接走 MCP 连这个服务（后续 roadmap）。

## 快速开始（Docker Compose，推荐）

```bash
git clone https://github.com/EternalNight996/memory-eternal.git
cd memory-eternal

# 1) 构建并启动（默认只把 7999 绑在 127.0.0.1，安全）
docker compose -f deploy/docker-compose.yml up -d --build

# 2) 验证
curl http://127.0.0.1:7999/memory-eternal/api/overview
```

默认数据卷是 `memory-data`（Docker named volume）。想用宿主机目录，把 compose 里的
`memory-data:/data` 改成 `/srv/memory-eternal:/data`。

**首次使用**：浏览器打开 `http://127.0.0.1:7999`，先跑一次
`docker compose exec memory node bin/dsh-memory.mjs doctor --vault /data` 确认库健康。

## 对外访问：必须加认证

**不要**把 7999 直接暴露到 0.0.0.0/公网。仓库自带 Caddy（自动 HTTPS + Basic Auth）示例：

```bash
cp deploy/.env.example deploy/.env
# 生成密码哈希（bcrypt，注意单引号避免 $ 展开）
docker run --rm caddy:2-alpine caddy hash-password --plaintext 'your-password'
# 把哈希写进 deploy/.env 的 AUTH_HASH，并设置 DOMAIN / AUTH_USER

docker compose -f deploy/docker-compose.yml --profile proxy up -d --build
```

Caddy 会为 `DOMAIN` 自动申请证书，并把请求转发到内部 `memory:7999`。
用 Nginx 也可以，关键只有两点：**TLS + 身份认证**，且只反代 7999。

## 数据与备份

- 数据库：`/data/memory-eternal.db`（含 `-wal` / `-shm`）；
- 备份：`/data/backups/`，Web 服务提供手动备份接口：

```bash
curl -X POST http://127.0.0.1:7999/memory-eternal/api/backup
```

- 定时备份（宿主机 cron，每天 03:10）：
```cron
10 3 * * * curl -fsS -X POST http://127.0.0.1:7999/memory-eternal/api/backup >/dev/null
```
- **异地备份**：把 `/data/backups` 同步到对象存储/另一台机器（备份是**明文** SQLite，请自行加密存储）。
- 恢复：先 `docker compose stop memory`，把备份文件复制回 `/data/memory-eternal.db`（同时删除旧 `-wal`/`-shm`），再启动并跑 `doctor`。

## 裸机部署（Linux systemd）

```bash
sudo mkdir -p /opt/memory-eternal /var/lib/memory-eternal
# 把仓库放到 /opt/memory-eternal（git clone 或解压 release）
sudo useradd -r -s /usr/sbin/nologin memory
sudo chown -R memory /var/lib/memory-eternal
sudo cp deploy/memory-eternal.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now memory-eternal
curl http://127.0.0.1:7999/memory-eternal/api/overview
```

Node.js >= 22 即可，无需 `npm install`（独立 web / CLI / MCP 不依赖第三方运行时包）。

## Windows（计划任务）

```powershell
# 用系统 Node 常驻；工作目录指向仓库，vault 指向数据目录
schtasks /Create /TN memory-eternal /SC ONSTART /RU SYSTEM /RL HIGHEST ^
  /TR "\"C:\Program Files\nodejs\node.exe\" \"C:\memory-eternal\bin\dsh-memory.mjs\" serve --port 7999 --host 127.0.0.1 --vault C:\memory-eternal-data"
```

对外仍须用 IIS/Nginx/Caddy 做 TLS + 认证。

## 升级与回滚

```bash
git pull
docker compose -f deploy/docker-compose.yml up -d --build   # 数据卷保留
# 回滚：git checkout <旧 tag> 后重新 build；数据库结构向后兼容（>=0.10.0）
```

升级后跑一次健康检查与 `/memory-eternal/api/version-check`，确认「磁盘 / 运行中」版本一致。

## 安全清单

- [ ] 7999 只监听 127.0.0.1，或只开给反向代理；
- [ ] 反向代理启用 TLS + 强密码/Basic Auth（或内网 SSO）；
- [ ] 服务器磁盘加密；备份按敏感数据对待（备份是明文 SQLite）；
- [ ] 不在公网暴露 `/api`（没有鉴权）；
- [ ] 定期升级并检查 `dsh-memory doctor`；插件升级后重启服务；
- [ ] 不要在容器里存 API key；蒸馏走宿主/环境变量时注意凭据边界。

## 许可与商业支持

- 核心：**MIT**，可自由自托管、修改、商用；
- 私有化部署**免费**；如果你需要「部署实施 / 定制（组织权限、审计导出、SSO）/ SLA 支持」，可以开 issue 或联系作者谈商业支持——这不会限制开源版功能。

## 常见问题

**Q：能不能多台机器共用一个库？**
A：当前 MCP 是 stdio 本地进程，跨机同步未实现；同一台服务器上的 Web/CLI/MCP 可以共用一个 `/data`。

**Q：能放在 NAS / 群晖上吗？**
A：可以，只要有 Docker 或 Node 22；数据目录放到 NAS 共享卷即可，注意 SQLite 对网络文件系统的锁支持有限，优先本地磁盘。

**Q：要开公网给外部 Agent 用吗？**
A：当前不建议。API 没有鉴权，且 MCP 不支持远程 HTTP；等后续的鉴权/远程 MCP 方案。
