# 授权校验（License）

> 商用私有组件 `memory-eternal-cloud` 的离线授权：**签名 license + 到期降级**。
> 不联网、不回调签发方，适合离线的洞天内景部署。

## 1. 形态

JWS compact（ES256），三段式：

```
header.报文体.signature
```

```jsonc
// header
{ "alg": "ES256", "typ": "JWT" }

// 报文体
{
  "sub": "acme",                       // 客户标识（也用作日志/面板展示）
  "plan": "pro",                       // pro | team | enterprise
  "seats": 5,                          // 席位数（供后续配额使用）
  "features": ["cloud", "backup"],     // 能力开关
  "iat": 1794568832,
  "exp": 1797160832                    // 必须存在；没有 exp 视为无效（不允许永久 license 静默放行）
}
```

- **服务端只内嵌公钥**：`lib/license.js` 的 `DEFAULT_PUBLIC_KEY_PEM`（P-256）；
- **私钥在签发方手里**：`private/license-private.pem`（已 gitignore，绝不进仓库、不进 npm 包）；
- 验签用 `node:crypto` 的 `crypto.verify`，`dsaEncoding: 'ieee-p1363'`。

## 2. 签发

```bash
# 第一次：生成密钥对（私钥自己留好，公钥贴进 lib/license.js）
node scripts/license-issue.mjs --gen-keys --out private/license-private.pem

# 把公钥内嵌 (一次性)
node -e "const c=require('crypto'),f=require('fs');const p=c.createPrivateKey(f.readFileSync('private/license-private.pem'));f.writeFileSync('private/license-public.pem',c.createPublicKey(p).export({type:'spki',format:'pem'}))"

# 签发（默认 365 天）
node scripts/license-issue.mjs --key private/license-private.pem \
  --sub acme --plan pro --seats 5 --days 365 --features cloud,backup
# → 打印一整串 token，配到服务端环境变量
```

## 3. 配置

```bash
MEMORY_SERVER_LICENSE=eyJhbGciOiJFUzI1NiIs...
MEMORY_LICENSE_DEGRADE=warn        # warn（默认）| readonly | stop
```

| `MEMORY_LICENSE_DEGRADE` | license 有效 | license 缺失/过期/无效 |
|---|---|---|
| `warn`（默认） | 全部可用 | **照常服务**（日志 + `/cloud/config` 标记） |
| `readonly` | 全部可用 | 读/导出照常，**写接口 403**（`code: license_readonly`） |
| `stop` | 全部可用 | 除诊断类外全部 503（`code: license_stop`） |

> 为什么默认 `warn`：私有部署常在洞天内景，先能跑起来比先锁死重要；要收费时把策略改成 `readonly` 或 `stop` 即可。

## 4. 只读降级放行哪些

```
GET  /cloud/config  /cloud/whoami  /cloud/connect  /cloud/client/*
GET  /overview  /cards  /card  /stats  /tag-cloud  /type-cloud
GET  /audit/list  /audit/preview  /audit/kinds  /recycle/list
GET  /backup/status  /backup/config  /backup/export
GET  /diagnostics  /config  /setup-status
```

**非 GET/HEAD 一律拦住** —— 因为同一路径可能读写双语义（`/card` 的 GET 是详情、POST 是新建）。

到期后客户仍然能：看数据、**导出备份**（`/backup/export` 是 GET）、看诊断。这样不会把人质化。

## 5. 面板与诊断

`GET /cloud/config` 会带一份脱敏摘要（**不含 license 原文**）：

```jsonc
{
  "license": {
    "status": "valid",         // valid | expired | missing | invalid
    "ok": true,
    "degrade": "warn",
    "canWrite": true,
    "plan": "pro",
    "owner": "acme",
    "seats": 5,
    "features": ["cloud", "backup"],
    "expiresAt": "2026-12-13T11:20:39.000Z",
    "daysLeft": 29,
    "error": null
  }
}
```

启动时也会打一行：

```
[memory-eternal-cloud] license 有效 · plan=pro · 剩 29 天
[memory-eternal-cloud] license missing · 降级策略=warn · 未配置 MEMORY_SERVER_LICENSE
```

## 6. 测试覆盖（`tests/license.test.mjs`，11 条）

真签验过 / 篡改 报文体 失败 / 换公钥失败 / 过期判定 / 缺 exp 视为无效 / 未配 license 三策略行为 /
有效 license 三策略都放行 / 过期 + readonly 读写分离 / 过期 + stop / 摘要不含原文 / 坏格式给可读原因。

## 7. 密钥保管

| 文件 | 用途 | 是否提交 |
|---|---|---|
| `private/license-private.pem` | 签发私钥 | ❌（.gitignore） |
| `private/license-public.pem` | 公钥副本 | ❌（.gitignore） |
| `lib/license.js` 里的 `DEFAULT_PUBLIC_KEY_PEM` | 服务端验签公钥 | ✅（公钥本来就公开） |

私钥丢了 → 已发 license 仍然有效（到期前），但无法续签；只能重新生成一对、重新签发、换服务端公钥。
私钥泄露 → 任何人能签 license；**必须立即换签并对已部署实例换公钥**。
