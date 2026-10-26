# 🧠 memory-eternal — a second brain for your AI

[![GitHub stars](https://img.shields.io/github/stars/EternalNight996/memory-eternal?style=flat)](https://github.com/EternalNight996/memory-eternal/stargazers)
[![npm](https://img.shields.io/npm/v/memory-eternal)](https://www.npmjs.com/package/memory-eternal)
[![release](https://img.shields.io/badge/release-v0.18.2-FF7A45)](https://github.com/EternalNight996/memory-eternal/releases)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**English (default)** · [简体中文](README.zh-CN.md)

<p align="center">
  <a href="https://eternalnight996.github.io/memory-eternal/demo/"><img src="https://raw.githubusercontent.com/EternalNight996/memory-eternal/main/assets/screen/demo.gif" width="900" alt="memory-eternal 20-second tour: review queue, token ledger, knowledge graph" /></a>
</p>
<p align="center"><sub>▲ 20-second tour — review queue · token ledger · knowledge graph · <a href="https://eternalnight996.github.io/memory-eternal/demo/">live demo</a></sub></p>

> **Your AI forgets every session. Give it a memory it can trust.**
>
> Local-first, review-gated, measurable — one SQLite vault shared by DSH, Claude Code, Codex, Cursor and any MCP client.

- 🔍 **Review before it counts** — new cards wait in a review queue; approve or reject from the Web UI or terminal; every change is written to an immutable audit log.
- 🧾 **Token ledger** — see how much recall injected, how many distillation calls ran, and how often recall was actually useful.
- 🏠 **Local-first, no cloud** — SQLite + Markdown on your own disk. No third-party memory framework, no account, no outbound calls.
- ⭐ **Core memory** — promote approved cards to always-on memory; every session gets them automatically, and the review queue still decides what qualifies.
- 🧭 **Reader & layout** — clickable table of contents in the card reader, plus a compact / normal / large layout setting for the whole memory UI.

<p align="center"><strong>⭐ If it saves you from explaining the same context again, a star helps a lot.</strong><br/><sub>DSH one-liner: <code>dsh plugin --profile desktop add memory-eternal</code></sub></p>

## ⚡ Quick start

**DeepSeek Harness (desktop / web)**

```bash
dsh plugin --profile desktop add memory-eternal
# reopen DSH → sidebar "Memory"
```

**Claude Code, Codex or Cursor — same vault via MCP**

```bash
npm i -g memory-eternal
dsh-memory connect claude    # or: codex / cursor
```

**Any MCP client**

```bash
npx -y -p memory-eternal dsh-memory mcp
```

**Browser or terminal**

```bash
dsh-memory open              # http://127.0.0.1:7999
npx -y -p memory-eternal dsh-memory tui   # live queue in the terminal
```

## 🧾 Does it actually save tokens?

Most memory products <em>say</em> they save tokens. We think you should check. The plugin ships a built-in **memory ledger** (Runtime status → Memory ledger) that records:

| Recorded | What it means |
|---|---|
| recall: hits + injected characters | how much memory actually entered the context |
| capture: LLM calls + input/output characters | what distillation cost you |
| usefulness: useful / not-useful feedback | whether recalled memories actually helped |

The honest math:

```text
net benefit ≈ avoided context cost − (injected characters + distillation calls × price)
```

| Scenario | You pay | You avoid |
|---|---|---|
| Multi-session project with decisions and pitfalls | ~0.6–0.9k tokens per recall | re-explaining context (~1.5–3k) or re-reading files (3–6k) |
| One-off question, low hit rate | recall injection | usually nothing |

> Illustrative numbers, not a benchmark — measure your own with the ledger. If recall usefulness stays below ~60%, tune it down (fewer results, shorter summaries) or turn memory off.

## 🛡️ Review first, prove later

A memory system that silently ingests everything will eventually recall a wrong fact as truth. memory-eternal defaults to **review-before-commit**:

- new cards land in a **pending queue**; nothing enters the main vault until a human approves it;
- approve, reject or bulk-process from the Web UI, the terminal TUI, or the CLI;
- every status change is appended to an **immutable audit log** (who / what / when / why) — enforced at the SQLite layer, not by convention;
- agents can read and propose, but **cannot approve their own cards**;
- deleted cards go to a recycle bin (30 days by default).

## ⭐ Core memory

Not everything should be injected into every session. Core memory is the small, explicit set of rules and preferences that must always win:

- any approved card can be promoted from the reader or card list;
- auto-capture may **suggest** core only for explicit long-term preferences / hard constraints, and core candidates always stay pending for review;
- approved core cards are injected into the system prompt of every session — no `memory_recall` call needed;
- set a card limit and character budget in Settings → Memory → Core memory;
- in the knowledge graph, core nodes are orange diamonds with a ★;
- never store secrets or API keys in a core card; keep only a pointer to the credential directory.

## 🎛 Reader & layout

- click any heading in the reader's table of contents to smoothly scroll to that section;
- Settings → Memory → Layout size offers **compact / normal / large** for the whole UI; it only affects display.

## 🧩 One vault, every agent

| Entry | What you get |
|---|---|
| **DSH desktop / web** | embedded memory UI: review, graph, config, ledger |
| **Claude Code / Codex / Cursor** | MCP server, same local vault, <code>dsh-memory connect</code> |
| **Any MCP client** | <code>npx -y -p memory-eternal dsh-memory mcp</code> |
| **Terminal** | <code>dsh-memory tui</code> — live queue, select-all, batch approve/reject, long-form reader |
| **Browser** | <code>dsh-memory open</code> → http://127.0.0.1:7999 |

## 📸 Screenshots

<p align="center">
  <img src="https://raw.githubusercontent.com/EternalNight996/memory-eternal/main/assets/screen/graph-en.png" width="32%" alt="Knowledge graph: clusters by kind, tag edges" />
  <img src="https://raw.githubusercontent.com/EternalNight996/memory-eternal/main/assets/screen/audit-en.png" width="32%" alt="Review inbox: type bar, queue and verdict pane" />
  <img src="https://raw.githubusercontent.com/EternalNight996/memory-eternal/main/assets/screen/status-en.png" width="32%" alt="Runtime status: database, backups, capture, version" />
</p>
<p align="center"><sub>▲ Knowledge graph · review inbox · runtime status</sub></p>

<p align="center">
  <img src="https://raw.githubusercontent.com/EternalNight996/memory-eternal/main/assets/screen/tui-audit.png" width="49%" alt="Native terminal audit: select-all, batch approve/reject" />
  <img src="https://raw.githubusercontent.com/EternalNight996/memory-eternal/main/assets/screen/tui-reader.png" width="49%" alt="Native terminal long-form reader" />
</p>
<p align="center"><sub>▲ Terminal-native review and long-form reading — <code>dsh-memory tui</code></sub></p>

## 📚 Documentation & links

- [Full manual (English)](docs/GUIDE.md) · [完整手册（中文）](docs/GUIDE.zh-CN.md)
- [Private deployment (Docker / systemd)](docs/DEPLOY.md)
- [Changelog](docs/CHANGELOG.md) · [Architecture](docs/ARCHITECTURE.md)
- [Terminal plugin (dsh-tui)](dsh-tui-plugin/README.md) · [Orca launcher](orca-plugin/README.md) · [Cursor / VS Code extension](cursor-extension/README.md)
- [Report a bug](https://github.com/EternalNight996/memory-eternal/issues)

## 💬 Community

**Questions, ideas, or DSH plugin talk — join the groups:**

| QQ group | WeChat group |
|:---:|:---:|
| <img src="https://raw.githubusercontent.com/EternalNight996/memory-eternal/main/assets/support/group-qr.jpg" width="240" alt="QQ group QR" /> | <img src="https://raw.githubusercontent.com/EternalNight996/memory-eternal/main/assets/support/group-wechat.png" width="240" alt="WeChat group QR" /> |

**Buy the author a coffee (optional):**

| WeChat Pay | WeChat Reward |
|:---:|:---:|
| <img src="https://raw.githubusercontent.com/EternalNight996/memory-eternal/main/assets/support/wechat-pay.jpg" width="200" alt="WeChat Pay QR" /> | <img src="https://raw.githubusercontent.com/EternalNight996/memory-eternal/main/assets/support/wechat-reward.jpg" width="200" alt="WeChat Reward QR" /> |

> Sponsorship is optional; the plugin stays MIT and free. See [SPONSOR.md](SPONSOR.md).

## 📄 License

MIT — use it, self-host it, build on it.
