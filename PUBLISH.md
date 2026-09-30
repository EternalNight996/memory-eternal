# 发布到插件市场（npm + GitHub）指南

参考 [dsh-ui-three-body](https://github.com/EternalNight996/dsh-ui-three-body) 的发布范式与 [dsh-market](https://github.com/dsh-market/dsh-market) 的收录机制整理。本插件已按该范式配置好，按下面顺序走即可。

---

## 0. 先看懂：插件是怎么被「发现」的

DSH 插件市场（`dshmarket`）不是人工审核制，而是**自动同步**两类来源：

1. **npm 包**：`keywords` 里带 `dsh-plugin` 的包（市场优先用 npm tarball 安装，快）。
2. **GitHub 仓库**：打了 `dsh-plugin` topic 的仓库（提供 README、截图、star 数、五维评分素材）。

所以「上传到插件市场」= ① 推 GitHub 并打 `dsh-plugin` topic + ② 发 npm。两条都做，收录与安装体验最好。

---

## 1. 配置核对

本插件 `package.json` 已具备市场收录所需字段：

- `name: memory-eternal`（npm 包名，全小写唯一）
- `main: index.js`（host 半边入口）
- `exports` 含 `./client`（client 半边，`dsh.client` 靠它自动挂载）与 `./cordis.patch.yml`（bundle 补丁层）
- `files` 白名单：`index.js`, `lib`, `assets`, `docs`, `cordis.patch.yml`, `README.md`, `PUBLISH.md`, `LICENSE`
- `keywords` 含 **`dsh-plugin`**（市场收录关键）+ `deepseek-harness`、`dsh` 等
- `dsh.client`：platform web + 显式 inject 列表
- `dsh.bundle.patch`：指向 `cordis.patch.yml`（host 行自动挂载）
- `scripts.prepublishOnly`：发布前自动重构建 client

## 2. 本地先验证（发布前必做）

```bash
npm i
npm test                 # 29 个单测全绿
npm run build            # 生成 lib/client.js

# 装进当前 profile 试跑
npx @deepseek-ai/dsh plugin --profile web add F:/absolute/path/to/memory-eternal
# 或（DSH profile 是 pnpm workspace，装/更新插件用 pnpm，勿用 npm install，否则 link: 报 EUNSUPPORTEDPROTOCOL）
#   cd ~/.dsh/profiles/web && pnpm add memory-eternal@latest
# 重启 dsh web → 设置 → 记忆：看到知识库页面
# 聊几轮 → ~/.dsh/memory-vault/03-Knowledge/ 出现自动沉淀的知识卡
```

## 3. 上传 GitHub

```bash
cd memory-eternal
git init
git add .
git commit -m "feat: 记忆核心（Memory Core）DSH 插件 v0.1.0 —— 对话自动沉淀 + 图形化知识库"

# 在 GitHub 网页上先建空仓库 memory-eternal，然后：
git remote add origin https://github.com/<你的用户名>/memory-eternal.git
git branch -M main
git push -u origin main
```

**关键一步**：在 GitHub 仓库页 → ⚙️ Settings → Topics，添加 `dsh-plugin`（再加 `deepseek-harness`、`memory`、`knowledge-graph` 等）。这是市场自动收录 GitHub 源的识别标志。

> README 里的截图放 `assets/screen/` 并在 README 引用（市场会自动从 README 提取截图）；头部可放一张 `assets/memory-eternal.gif` 动态演示（本仓库已压缩至 ~3MB 并置于 README 头部）。

## 4. 上传 npm

```bash
npm login          # 首次：输入 npm 账号（去 npmjs.com 注册）
npm publish        # 触发 prepublishOnly 自动 build，然后发布
```

发布成功后：

- npm 地址：`https://www.npmjs.com/package/memory-eternal`
- 用户可一条命令安装：`npx @deepseek-ai/dsh plugin --profile web add memory-eternal`

常见坑：

- **包名被占**：`npm publish` 报 `403 Forbidden` 通常是名字冲突，改个名字。
- **未构建就发布**：`prepublishOnly` 已兜底重构建 client，别删这行。
- **`.npmignore`**：本项目用 `files` 白名单，比 `.npmignore` 更省心，别两个都写。

## 5. 进入插件市场（收录）

发布 npm + 打 GitHub topic 后，市场 registry 会周期性同步。若想主动加速/确认收录，可到 [dsh-market](https://github.com/2BingLing/dsh-market) 或 [dsh-plugin-marketplace](https://github.com/AwesomeHou/dsh-plugin-marketplace) 的收录入口提交。

五维评分靠 README 质量：**用途一句话 + 真实截图 + 安装命令 + 目录结构 + 待办**（本插件 README 已按此结构写好）。

## 6. 更新版本（正式版必须三端同步）

**规则（2026-09-30 起强制）：正式版 = npm 发布 + GitHub Release + Gitee Release，tag 三端同步。**
少任何一端都算未发布完成 —— 桌面版 profile 依赖 `github:EternalNight996/memory-eternal`、
`dsh web` profile 走 npm 版本号、Gitee 是镜像与 Release 归档；任一端漏掉就会出现
「npm 上有新版、桌面版还是旧的」这类不一致（v0.9.16–v0.9.23 就漏打了 tag，导致 `latest` 长期指向 0.9.15）。

用统一脚本走完全流程（推荐）：

```bash
# 1) 改版本号 + 在 README 更新日志里写这一版（脚本会从日志里抽发布说明）
#    也可以 npm version patch（会改 package.json 并打 tag）

# 2) 预演：检查工作区 / 测试 / 版本与 tag 一致性，仅打印将执行的动作
node scripts/release.mjs --dry-run

# 3) 正式发布：npm publish → git push(origin + gitee) → GitHub Release → Gitee Release
node scripts/release.mjs

# 常用变体
node scripts/release.mjs --skip-npm        # 只同步 git / GitHub / Gitee
node scripts/release.mjs --only-gitee      # 只补建漏掉的 Gitee Release
node scripts/release.mjs --notes-file=notes.md
```

**Gitee Release 需要 token**（脚本找不到 token 时会明确打印「未同步」，不会假装成功）：

```bash
# 方式一：环境变量（Windows 用 setx，新开终端生效）
setx GITEE_TOKEN "<你的私人令牌>"
export GITEE_TOKEN="<你的私人令牌>"          # bash

# 方式二：文件（更省事，一行 token）
#   %USERPROFILE%\.config\memory-eternal\gitee-token
```
令牌在 Gitee → 设置 → 私人令牌 生成，勾选 **projects**（仓库读写）权限。**不要提交进仓库。**

手工等价命令（不想用脚本时）：

```bash
npm publish --access public
git push origin main && git push origin vX.Y.Z
git push gitee  main && git push gitee  vX.Y.Z
gh release create vX.Y.Z --repo EternalNight996/memory-eternal --title "vX.Y.Z — …" --notes-file notes.md
# Gitee：POST https://gitee.com/api/v5/repos/EternalNight996/memory-eternal/releases
#        （tag_name / name / body / target_commitish=main / access_token）
```

> ⚠️ **桌面版走的是 GitHub 主分支**：`~/.dsh/profiles/desktop/package.json` 里
> `memory-eternal` 的依赖是 `github:EternalNight996/memory-eternal`，所以
> **只发 npm 不会更新桌面版用户**——必须 push 到 GitHub `main`。
> 发布后提醒用户：`cd ~/.dsh/profiles/desktop && pnpm update memory-eternal` 后重启宿主；
> `dsh web` 用户：`cd ~/.dsh/profiles/web && pnpm add memory-eternal@X.Y.Z`。

### 6.0 发布前自检清单

- [ ] `npm test` 全绿（脚本会再跑一次，`--skip-tests` 可跳过）
- [ ] 工作区干净（脚本默认拒绝带未提交改动发布）
- [ ] `package.json` 版本与 tag 一致（脚本会校验）
- [ ] README 更新日志写了这一版（否则用 `--notes-file`）
- [ ] 发布后确认 `dist-tags.latest` 指向新版本：`npm view memory-eternal dist-tags`

## 6.1 可选的 MCP 对外通道

`examples/mcp-memory/memory-eternal.cordis.yml` 是给 DSH 自己挂本插件 MCP 服务的示例 overlay
（配合官方 `@deepseek-ai/dsh-mcp-client`）。已装插件本体的用户不需要它；未装插件、
只想用记忆库的场景可用（用法与验证步骤写在文件注释里）。

---

## 一句话总览

```
本地验证（npm test 全绿）→ npm publish → git push origin+gitee（含 tag）
   → GitHub Release → Gitee Release → 市场自动收录 → 提醒用户更新 profile
一条命令跑完：node scripts/release.mjs（先 --dry-run 预演）
```
