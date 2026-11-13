# memory-eternal-cloud

**Memory Eternal 云端服务端**（多租户 + 密钥 / MengBot 授权）—— 商用私有组件。

- 不随 `memory-eternal`（开源插件本体）发布；
- 授权客户按本包安装后，插件用 `MEMORY_CLOUD=1` 启动即启用多租户；
- 每个用户一个独立 SQLite（`cloud-vaults/<owner>/memory-eternal.db`），写者仍唯一。

## 它包含什么

| 文件 | 作用 |
|---|---|
| `lib/cloud-auth.js` | 密钥签发/校验/吊销、MengBot 授权换令牌、`owner → vault` 租户解析 |
| `lib/cloud-server.js` | 多租户路由层：`/cloud/*` 管理接口 + 按 Authorization 分库转发 |
| `docs/CLOUD.md` | 部署手册（systemd + Caddy HTTPS + 每租户备份/恢复） |
| `docs/PRIVATE.md` | 开源 / 商用边界说明 |
| `COMPAT.md` | 与 `memory-eternal` 的版本兼容区间 |

## 安装（授权用户）

```bash
# 1) 解包到插件的私有目录
tar -xzf memory-eternal-cloud-<version>.tgz -C /opt/memory-eternal/private/memory-eternal-cloud

# 2) 把模块放回插件会加载的位置（插件按 lib/ 相对路径动态 import）
cp /opt/memory-eternal/private/memory-eternal-cloud/lib/cloud-*.js /opt/memory-eternal/lib/

# 3) 以云端模式启动
MEMORY_CLOUD=1 node /opt/memory-eternal/lib/web.js --port 7999
```

首次启动会打印：

```
[memory-eternal] 云端多租户模式已启用（每人一个独立 SQLite；密钥鉴权 + MengBot 授权）
```

## 签发第一把密钥

```bash
curl -X POST http://127.0.0.1:7999/memory-eternal/api/cloud/keys \
  -H 'Content-Type: application/json' \
  -d '{"owner":"alice","note":"laptop"}'
# → {"ok":true,"token":"me_xxxx","key":{...}}   明文只此一次
```

之后所有业务请求带 `Authorization: Bearer me_xxxx`；客户端在插件顶栏「本地运行 ▾ → 连接云端」里填地址 + 密钥即可。

## 授权

见 `LICENSE-PRIVATE`。二次分发需书面授权；源码/二进制按授权等级提供。
