## ☁️ v0.47.0 — 云端记忆成为主打：换库不重启、上传可续传、连不上自动回本地

### 安装 / 升级

```bash
npm i -g memory-eternal@0.47.0
# 或桌面版 / web profile（profile 是 pnpm workspace，别用 npm install）
cd ~/.dsh/profiles/desktop && pnpm update memory-eternal
```

> 升级后**重启一次 DSH**：宿主侧（`index.js` / `lib/web.js` / `lib/api.js`）有改动，只换磁盘文件不生效。
> 面板页面脚本也换了（`lib/client.js` 版本号写成 0.47.0），刷新面板即可看到「页面脚本已更新」。

### 本次改动

- ① **云端记忆成为主推能力**（不再是"实验性小字"）
  - 登录方式二选一：**MengBot 账号**（扫码 / 邮箱 OTP）或**访问密钥**（`me_…`，可在任意实例签发）；
  - **一人一库**：服务端按 owner 分目录，每个用户一个独立 SQLite（`cloud-vaults/{owner}/memory-eternal.db`），物理隔离、互不可见；
  - **本地库 ↔ 云端库热切换**（`POST /vaults/switch`）：先验证目标库能打开再改指向，前端整棵面板重挂载 —— 知识卡 / 星图 / 待审 / 回收站 / 统计一次性换源，**不刷新页面**；**云端实例内的租户多库切换同样是热的**（当前库记在 `cloud-vaults/{owner}/.active`，0600；重启后仍在切过去的库，坏标记自动回落默认库，隔离边界恒为租户根不会跟着收窄）；
  - **整库上传 / 下载**：分片传输 + **断点续传**（重开面板显示「已传 d / t，继续 / 取消」）+ 单分片失败重试 3 次（1s/2s 退避）+ 重复内容自动跳过（本地保留）；
  - **离线优先**：云端不可达自动熔断、回退本地库（首屏最多等 3 秒），已登录但服务端挂了也不会把用户卡在空白页；
  - **密钥管理三处入口（不再只能 curl）**：
    * **CLI** —— `dsh-memory cloud keys issue --owner alice`：本地台账模式**不需要管理令牌**（能在这台机跑命令就是管理员），签发/吊销对运行中的服务**立即生效、不用重启**；`info` / `token` / `keys ls` / `keys revoke` / `whoami` 全套，另有 `--url` + `--admin-token` 远程模式；
    * **面板** —— 设置 → 🧪 实验性 → 云端连接 → 「🔑 服务端密钥管理」：填管理令牌 → 读取列表 / 新建（**明文只显示一次**，可复制）/ 吊销；
    * **自动生成管理令牌** —— 首次以 `MEMORY_CLOUD=1` 启动时自动生成并写入 `$DSH_HOME/cloud-admin-token`（0600），启动日志打印一次；`MEMORY_CLOUD_ADMIN_TOKEN` 优先、其次该文件；`/cloud/config` 只回 `adminTokenSource`，不回令牌。
- ② **安全加固（发版前审计扫出来的一批）**
  - **多租户越权（最严重）**：`/vaults/export`、`/vaults/import-into`、`/vaults/transfer`、`/vaults/switch` 原来接受**任意绝对路径** —— 云端模式下任一登录租户能读写别人租户的库。现在统一 `guardPath`：**云端只认本租户库根**，本地保留「当前库 + 同级历史库」（老库上传照旧可用），越界一律 `403 path-not-allowed`；
  - **云端管理面**：未配 `MEMORY_CLOUD_ADMIN_TOKEN` 时 `/cloud/keys`、`/cloud/config` 只允许 `127.0.0.1`/`::1` 直连（原先把 `10.x` / `172.16-31` / `192.168.x` 都当"本机回环"→ 同网段任何人可自签密钥）；容器 / 反代部署请务必配 token，带 `x-forwarded-for` 的请求即使来自回环也不算本机；
  - **任意可执行文件执行**：`/embedding/install-ollama` 的 `{action:'run', path}` 不再执行请求里的路径，只认服务端 `MEMORY_OLLAMA_SETUP`，并校验「绝对路径 + 存在 + 安装器后缀 + 解释器黑名单」；
  - **DNS rebinding**：写请求补 Host 白名单（IP 字面量 / `localhost` / `MEMORY_PUBLIC_HOST` / `MEMORY_CLOUD_PUBLIC_URL` / `MEMORY_TRUSTED_HOSTS`）。用域名或反代访问后端时请配上面任一变量，否则写请求会 403；
  - **请求体上限**：`readBody` 统一一份（默认 2MB、`/backup/import` 与整库导入 256MB、分片导入 16MB，超限 413 + 断连），**14 处**自写读取全部收敛；
  - **临时文件**：`/backup/import` 改 `mkdtemp` 私有目录 + `flag:'wx'` + 0600 + `finally` 清理；
  - **密钥台账**：改串行写入 + `wx` 独占（并发下吊销不再被旧快照"复活"），`lastUsedAt` 60s 节流（面板"最近使用"最多滞后 1 分钟）；
  - **`tenantVault`** 拒绝 `.`/`..` 这类 owner；**热切库**不再对请求路径 `mkdir`；
  - **安全响应头**：全站 `nosniff` / `no-referrer` / CSP（`frame-ancestors` 放行 `dsh-app:` 以保住 DSH 内嵌面板，`connect-src` 放行 https 与本机端口以保住云端上传）；
  - 新增 4 个守卫测试（路径作用域 / 管理面 / Host / body 上限，共 36 例）。
- ③ **体积：包和产物都瘦了**
  - `build.mjs` 补 `process.env.NODE_ENV = 'production'`：`web/app.js` **2,725KB → 1,837KB**（−888KB）。之前打进的是 **react-dom 开发版**，面板还带着开发期警告；
  - 删掉 **12 张零引用截图**（含 2.8MB 的 `demo.gif`、5 张皮肤单图、`cards.png`、`cover-zh.png`、`icon-180.png`）+ `docs/screenshots/` 三张过期云面板图 + `site/assets/` 18 个生成物，素材 **−12.1MB**；
  - 15 张仍在用的截图**无损重压**（只缩到展示需要的宽度 + 重新压缩）：**−1.24MB**；
  - `files` 去掉开发期 `scripts/`；**补全私有组件排除清单** —— `subscription-sync.js` / `subscription-audit.js` 之前"半发货"，装包用户一开云端就 `ERR_MODULE_NOT_FOUND`，现在要么不出包、要么显式降级；
  - `devDependencies` 删掉零引用的 `playwright-core`（**−13.3MB**，所有截图脚本都是 `spawn` + CDP，没有一行 import 它）。
- ④ **README 重排**：云端放到首屏当主卖点（能力表 + 三步接入）；**同类对比表上移**并换成 2026-11-15 的 GitHub API 实测星标，新增 Dify / RAGFlow / AnythingLLM / Khoj / LlamaIndex 等**知识库类**对照，并明确标注：Mem0 的 94.4 是**托管平台口径的 QA**、`getzep/zep` 仓库不是产品本体、`letta-ai/letta` 主仓已归档；**两张架构图合一，只留一张放到底部**；截图从 9 张精简到 4 张（hero + 知识卡 + 星图 + 皮肤总览）。
- ⑤ **仓库卫生**：`.gitignore` 从**混合编码**（部分 UTF-8、部分 GBK，整文件不是合法 UTF-8）修成纯 UTF-8 并加 `*.log`；清掉 7 个 `.panel-*.log`、`p21.tgz`、`.tmp-run-jobs.json`、`preview/`（15.1MB）、`.panel/`（2.5MB）与过期 `dist/*.tgz`，本地 **−18.5MB**。

### 重点

- **换库不用重启**：本地库 / 云端库都能在运行中切换，知识卡与图谱一起换
- **传一半能接着传**：断点续传 + 可取消，进度看得见
- **云端挂了不影响本机**：熔断回退本地，记忆库一分不丢
- **包小了 12MB、产物小了 0.9MB**：安装更快，面板不带 React 开发版
- **0.46.0 未发布**，其内容（热切库 / 断点续传 / 沉淀自检 / 恢复出厂发号器修复）已并入本版
