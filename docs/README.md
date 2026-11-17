# 📚 文档索引 / Docs index

> 根目录只留「给外部看的四件」：README（中英）、PUBLISH、SECURITY、SPONSOR、llms-install。其余全部收进这里，按用途分目录。

## 🚀 上手 / 使用

| 文件 | 内容 |
|---|---|
| [GUIDE.zh-CN.md](GUIDE.zh-CN.md) | 完整手册（中文） |
| [GUIDE.md](GUIDE.md) | Full manual (English) |
| [INTEGRATIONS.md](INTEGRATIONS.md) | 第三方 Agent 接入：15 个宿主的真实配置位置与坑 |
| [CARD-TYPES.md](CARD-TYPES.md) | 卡片类型（知识类型 / 技能类型） |
| [GLOSSARY.md](GLOSSARY.md) | 术语对照 |
| [SEARCH-MATCH.md](SEARCH-MATCH.md) | 检索命中证据 |
| [UI-SKINS.md](UI-SKINS.md) | 界面皮肤与可读性基线 |
| [DESIGN.md](DESIGN.md) | 设计规范与体验基线 |

## 🏗 架构与实现

| 文件 | 内容 |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | 架构说明 |
| [EMBEDDINGS.md](EMBEDDINGS.md) | 可选语义召回（Embedding） |
| [BACKUP.md](BACKUP.md) | 备份与容灾 |
| [LEGACY_TAGS.md](LEGACY_TAGS.md) | 历史 tag 对照（已精简） |

## ☁️ 云端 / 私有化

| 文件 | 内容 | 备注 |
|---|---|---|
| [CLOUD.md](CLOUD.md) | 云端多租户（memory-eternal-cloud） | 不进开源包 |
| [PRIVATE.md](PRIVATE.md) | 私有 / 商用部分 | 不进开源包 |
| [DEPLOY.md](DEPLOY.md) | 私有化部署（Docker / systemd） | |
| [LICENSE.md](LICENSE.md) | 授权校验 | 不进开源包 |
| [MCP_DISTRIBUTION.md](MCP_DISTRIBUTION.md) | MCP 目录分发清单 | |

## 🗂 历史与往来

| 目录 | 内容 |
|---|---|
| [release-notes/](release-notes/) | 各版本发版说明（0.45 起逐一保留） |
| [mengbot/](mengbot/) | MengBot 对接往来：需求 / OIDC+Webhook / 商户 / 第 2–5 轮问答 / 设备码 / 定价方案 |
| [notes/](notes/) | 运营笔记（星标攻略等） |
| [CHANGELOG.md](CHANGELOG.md) | 全部版本变更（唯一权威） |

## 约定

- **唯一权威的版本记录是 [CHANGELOG.md](CHANGELOG.md)**；release-notes/ 只是每次发版的整篇说明，按版本号命名。
- 新增文档请落到对应目录，并在这里补一行；根目录不再新增散装 `*.md`。
- `docs/` 里只有 `INTEGRATIONS.md` 会随 npm 包发布；`CLOUD`/`PRIVATE`/`LICENSE`/`mengbot/` 均在发布白名单之外。