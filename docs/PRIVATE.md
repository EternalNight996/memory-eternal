# 私有 / 商用部分（memory-eternal-cloud）

> **项目名：`memory-eternal-cloud`**（私有包在 `private/memory-eternal-cloud/`）
> 打包：`npm run cloud:pack` → `dist/memory-eternal-cloud-<version>.tgz`

> `memory-eternal` 插件本体是开源的；**云端服务端（多租户 + 鉴权）是独立私有代码**，
> 后续按商业授权分发。这份文档说明边界在哪、开源包里怎么排除、私有部署怎么接。

## 1. 归属划分

| 部分 | 文件 | 归属 | 是否随开源包发布 |
|---|---|---|---|
| 插件本体（本地记忆、检索、审核、备份、UI） | `index.js` / `lib/*`（除下面两个）/ `src/client/*` / `web/*` / `bin/*` | 开源（见 `LICENSE`） | ✅ |
| **云端多租户服务端** | `lib/cloud-auth.js`（密钥 / MengBot 授权 / 租户解析） | **私有·商用** | ❌ |
| **云端多租户服务端** | `lib/cloud-server.js`（按租户路由 + `/cloud/*` 接口） | **私有·商用** | ❌ |
| 私有部署手册 | `docs/CLOUD.md` | 私有·商用 | ❌（仓库内保留，`files` 里已排除） |

## 2. 为什么这样切

- **授权模型不同**：插件本体 MIT/开源；云端是「按密钥/按账号授权」的商用组件，混在开源包里等于把收费部分送出去。
- **阵面不同**：云端组件是网络面（鉴权、租户隔离、令牌），不该跟着本地插件一起被复制走。
- **升级节奏不同**：云端要能单独发版（配额、计费、审计），和插件版本解耦。

## 3. 开源包里怎么排除

`package.json` 的 `files` 用**白名单**方式发布，且显式排除私有模块：

```jsonc
"files": [
  "index.js", "lib", "bin", "scripts", "web", "hooks", "skills",
  "!lib/cloud-auth.js",
  "!lib/cloud-server.js",
  "docs/INTEGRATIONS.md", "!docs/CLOUD.md",
  ...
]
```

发布前自检（`npm pack --dry-run` 的清单里不允许出现私有文件）：

```bash
npm pack --dry-run 2>&1 | grep -E 'cloud-(auth|server)\.js|docs/CLOUD\.md' && echo '❌ 私有文件泄漏' || echo '✅ 干净'
```

## 4. 运行时行为（开源包）

`lib/web.js` **不再静态 import** 云端模块（静态 import 会让缺文件的包启动即崩），
改成**首次请求时动态加载**：

```js
// MEMORY_CLOUD=1 且文件存在 → 正常启用多租户
// 文件缺失（开源包） → 打一行明确日志，本地模式照常工作
[memory-eternal] 云端模块未安装（商用私有组件）：Cannot find module './cloud-server.js'
                —— 当前只有本地模式可用
```

也就是说：**开源用户拿到的是「本地版」，云端能力需要商业授权后叠加私有模块**。

## 5. 私有部署怎么接（授权用户）

1. 从私有仓库拉取 `lib/cloud-auth.js`、`lib/cloud-server.js`（以及 `docs/CLOUD.md`）；
2. 放进插件的 `lib/` 下（版本需与插件 `package.json` 的 `engines`/版本兼容，见私有仓库的 `COMPAT.md`）；
3. `MEMORY_CLOUD=1` 启动 → 见 [CLOUD.md](CLOUD.md) 的部署清单（systemd + Caddy + 密钥/MengBot）。

私有模块只依赖插件公开的内部契约：
`lib/api.js` 的 `createApi()`、`lib/db.js` 的备份/探测、`lib/capture-run.js` 的 `configFilePath()`。
**不直接读写 SQLite**（除了通过 `createApi` 间接），所以插件内部重构只要这几个出口不变，私有模块不用跟着改。

## 6. 商用授权边界（建议写成正式条款前的备忘）

| 项 | 开源（插件本体） | 商用（云端服务端） |
|---|---|---|
| 本地单人使用 | 免费 | — |
| 云端多用户 / 多租户 | — | 按席位或按实例授权 |
| 二次分发 | 允许（保留版权与许可） | 需书面授权 |
| 私有模块源码 | 不公开 | 授权客户可见（或仅二进制） |
| 支持 | 社区 | 商业 SLA |

## 7. 待办（把边界钉死）

- [x] `package.json` 的 `files` 加 `!lib/cloud-*.js` / `!docs/CLOUD.md` / `!private` / `!dist`
- [x] 加发布守卫：[tests/private-boundary.test.mjs](../tests/private-boundary.test.mjs)（6 条：包名 / 版本 / 排除项 / 静态依赖 / 缺文件提示 / 依赖白名单）
- [x] 私有包 `private/memory-eternal-cloud/`（`COMPAT.md` 记录兼容区间；`npm run cloud:pack` → `dist/memory-eternal-cloud-<version>.tgz`）
- [x] 授权校验：`lib/license.js`（ES256 离线签名）+ `scripts/license-issue.mjs` 签发 + 三档降级（warn / readonly / stop）—— 见 [LICENSE.md](LICENSE.md)
