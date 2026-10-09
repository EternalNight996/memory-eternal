# 🧠 memory-eternal — A "second brain" for your AI

[![HOL Guard](https://img.shields.io/endpoint?url=https%3A%2F%2Fhol.org%2Fapi%2Fregistry%2Fbadges%2Fplugin%3Fslug%3Deternalnight996%252Fmemory-eternal%26metric%3Dtrust)](https://hol.org/registry/plugins/eternalnight996%2Fmemory-eternal)

<!-- Language / 语言：this is the **English mirror**; the default README is Chinese (README.md).
     The two are **separate files** with 1:1 heading levels — when you change one, change the other
     (a new section must be added on both sides). npm / the DSH marketplace show README.md (Chinese) by default. -->

<p align="center"><a href="README.md">简体中文（默认）</a> · <b>English</b></p>

<p align="center">
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-plugin-3B82F6" alt="DSH plugin" />
  <img src="https://img.shields.io/npm/v/memory-eternal" alt="npm version" />
  <img src="https://img.shields.io/github/stars/EternalNight996/memory-eternal?style=flat" alt="GitHub stars" />
  <img src="https://img.shields.io/github/license/EternalNight996/memory-eternal" alt="license" />
  <a href="https://dsh.market/"><img src="https://raw.githubusercontent.com/2BingLing/dsh-market/master/assets/readme/badge-listed.svg" alt="DSH Market listed" /></a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/EternalNight996/memory-eternal/main/assets/screen/memory-eternal.gif" width="880" alt="Auto-capture + visual library + knowledge graph (demo)" />
</p>

> **Auto-captures knowledge after every conversation and survives across sessions; recall fetches only the relevant chunks — saves tokens, less noise.**
> Fully self-built, zero third-party memory framework, no DSH source changes, one vault shared by every Agent, SQLite persistent storage, zero external dependencies.

<p align="center"><strong>⭐ Star it if you like it!</strong> <br/><sub>DSH one-liner: <code>dsh plugin --profile web add memory-eternal</code></sub></p>

<p align="center">
  <img src="https://raw.githubusercontent.com/EternalNight996/memory-eternal/main/assets/screen/memory-popup.png" width="32%" alt="Memory popup: knowledge cards / search / knowledge graph" />
  <img src="https://raw.githubusercontent.com/EternalNight996/memory-eternal/main/assets/screen/memory-settings.png" width="32%" alt="DSH Settings → Memory: all options" />
  <img src="https://raw.githubusercontent.com/EternalNight996/memory-eternal/main/assets/screen/memory-sidebar.png" width="32%" alt="Sidebar quick entry" />
</p>

---

## 🚀 Get Started in 5 Minutes

### 🟦 DeepSeek Harness (DSH) — focus

**Install** (official desktop app via the plugin marketplace, `dsh web` via one CLI line):

```bash
# 1) Official DeepSeek Harness desktop app (recommended): Settings -> Plugins -> search memory-eternal
#    Equivalent CLI (that shell's profile is named "desktop"):
dsh plugin --profile desktop add memory-eternal

# 2) dsh web (browser):
dsh plugin --profile web add memory-eternal

# or update directly in the profile (pnpm workspace). Use pnpm — `npm install` throws EUNSUPPORTEDPROTOCOL
cd ~/.dsh/profiles/web && pnpm add memory-eternal@latest

# right after a release, @latest can be held back by pnpm's minimum-release-age gate or a cached
# packument (it silently stays on the old version): pin the version instead — pnpm adds it to the
# workspace's minimumReleaseAgeExclude automatically
cd ~/.dsh/profiles/web && pnpm add memory-eternal@0.9.6

# verify the version, then restart the host
node -e "console.log(require('memory-eternal/package.json').version)"
```

#### 🖥️ Desktop support policy (read this first)

- **The official DeepSeek Harness desktop build is the priority — and the only guaranteed target** (the official Electron release; its profile is named `desktop`). The v0.9.4 → v0.9.6 fixes all target it: the 0.1.7 settings-service rewrite, `schemastery 3.18.4` volatile live references, and window-titlebar avoidance (`data-windows-titlebar`, so a full-screen overlay can no longer cover minimize/maximize/close).
- **The author's own `dsh-desktop` (`dsh-desktop-shell` / `dsh-ui-*` / `dsh-plugin-marketplace`) is discontinued** and is no longer a support target — the official desktop build covers the same ground, and maintaining two shells only splits compatibility. Note that its profile still pins `dsh-desktop-shell@0.3.0`, which has been unpublished from npm and makes `pnpm install` fail outright; migrating to the official desktop build and dropping those dependencies is recommended.
- Compatibility matrix (both verified): the official `desktop` profile (schemastery **3.18.4**) and the `web` profile behind `dsh web` (schemastery **3.18.1**) share the same code path.

After **restarting the host**, three things are live immediately:

| Effect | Where |
|---|---|
| Auto-capture of knowledge cards | Happens every turn, no action needed |
| `memory_recall` tool | Agent calls it automatically when it needs history |
| Visual UI | Sidebar bottom `Memory` button / Settings → Memory |

**Entry**: The sidebar-footer `Memory` button opens the vault (its left rail includes Cards / Graph / Usage / **Audit Center** / Recycle Bin / **Memory Config**); "DSH Settings → Memory" is the pure config page.

**UI language**: The whole UI is bilingual (English / 中文) and follows **DSH Settings → Language** in real time — Cards, Graph, Audit Center, card templates, config panel all included; the standalone web page follows the browser language.

**Edit config**: Vault left rail "Memory Config" (or DSH Settings → Memory) → DSH memory config / cost control / auto-audit config / self-hosting — just hit "Save Config". `autoWebMode` / `watchdogAutoSpawn` changes require a DSH restart — and note an **already running watchdog is never stopped by a config change**: use `dsh-memory stop` / `dsh-memory restart` (see Self-hosting).

### 🟨 Claude Code

```bash
npm i -g memory-eternal     # installs CLI + MCP (auto-writes ~/.claude.json + SessionEnd hook)
```

Ready after install: say "recall 数据库选型" in a session → auto-retrieves memory; on session end / before context compaction → auto-captures.

### 🟧 Codex CLI / Cursor

```bash
npm i -g memory-eternal     # auto-writes Codex config.toml / Cursor mcp.json
```

Restart the tool → MCP is in the list; just use: `用 memory_recall 查一下项目历史决策`.

### 🟩 Browser (no Agent needed)

```bash
dsh-memory open    # starts web + opens browser (default http://127.0.0.1:7999)
```

Stats / search / card grid (add-edit-merge-import-export) / knowledge graph — all here. Same UI as the DSH embed; data stays in sync.

> **zcode (Zhipu)**: no native MCP; bridge via [zcode-open-bridge](https://github.com/tizerluo/zcode-open-bridge) or use the CLI directly.

---

## 📖 Command Reference

```bash
dsh-memory recall "database selection"   # retrieve
dsh-memory capture "important note..."   # manual capture (- reads stdin)
dsh-memory sweep ~/.claude/projects      # mine existing sessions
dsh-memory setup [--dry-run]             # re-run / preview auto-mount (idempotent)
dsh-memory mcp                           # MCP stdio (mount to any MCP client)
dsh-memory serve [--port 7999]           # run web in foreground
dsh-memory open                          # ensure web alive + open browser
dsh-memory watchdog [--port 7799]        # watchdog keep-alive (standalone process)
dsh-memory status [--json]               # resident watchdog: pid / port / version / alive
                                         # plus the version **actually served on the port**
dsh-memory stop [--port 7799]            # stop the resident watchdog (+ the web it spawned)
                                         # then re-checks who still holds the port and warns
dsh-memory restart [--port 7799]         # stop + respawn (apply a new version)
                                         # also reaps port owners the lock never registered, then verifies the served version
dsh-memory audit list [--status pending|rejected|approved|deleted|all] [--limit N] [--json]
                                         # list cards; the total is never rewritten by --limit (which caps output only)
                                         # all = audit queue (pending + rejected), excluding approved / deleted
dsh-memory audit approve <card path...>              # human bulk approve
dsh-memory audit reject <card path...> --reason "..." # human bulk reject
```

When not running on DSH, the `dsh-memory` command comes from `npm i -g`.

---

## ⚙️ Self-hosting (plain words)

Three concepts, don't mix them:

- **How the web server stays alive** (`autoWebMode`) → `init`=pull once at DSH start (default); `interval`=DSH in-process timer probes & auto-restarts (0 extra memory); `manual`=fully manual, only from `dsh-memory open`.
- **Watchdog process** (`watchdogAutoSpawn`, default on) → a **standalone** node process that can pull web up even after DSH exits (~+47 MB RAM). Only turn on for 7×24 keep-alive.
- **Version-drift self-heal** (`autoRestartOnDrift`, default on) → the resident web **outlives DSH**: an upgrade only swaps files on disk, so the process on the port keeps running the code it loaded at startup (that is where "still on the old version after starting dsh" comes from). With this on, DSH asks **the port** which version it really serves and, on a mismatch, restarts the resident instance on the new code. Turn it off to only get a warning — the **Restart resident instance** button in Plugin info stays available.
- **Auto-mount MCP** (`autoMcpSetup`, default off) → whether to auto-write MCP into Claude Code/Codex/Cursor config. Off = don't touch your machine config; run `dsh-memory setup` manually when needed.

**Change these**: Vault left rail "Memory Config" (or DSH Settings → Memory) → edit the table and save; `autoWebMode` / `watchdogAutoSpawn` need a DSH restart.

> ⚠️ **A config change never auto-replaces the instance on the same port (#19)**: the watchdog is a **standalone process we deliberately never kill** (several sessions share one). So turning `watchdogAutoSpawn` off does **not** stop the running one, and changing `webCheckIntervalMs` / `webMaxRestart` has no effect on it.
> Stop or upgrade it explicitly with `dsh-memory stop [--port N]` / `dsh-memory restart [--port N]` (`stop` also stops the **web it spawned**, so no orphan keeps holding the port); `dsh-memory status` shows the resident pid, port, start time, whether its **version lags the installed package**, and separately the version **actually served on the port** (the lock's version is only the watchdog's self-report).
>
> ⚠️ **After upgrading, trust the served version (#23)**: `restart` no longer trusts the lock's `webPid` alone — it reaps whoever holds the port (including web processes the lock never registered; non-memory-eternal processes are only reported, never killed), and after spawning it verifies that the **served version equals the installed version**, exiting non-zero instead of printing "started" and walking away.
>
> ✅ **"Upgraded but still on the old version" now has two ways out (#19/#23)**: ① `autoRestartOnDrift` (default on) replaces a stale resident instance **automatically** when DSH activates; ② UI → Plugin info shows a **🔄 Restart resident instance** button whenever it detects drift (the server side is the same implementation as `dsh-memory restart --port N`: reap the old instance → take the lock → pull up the new web → verify the served version). Note the "running" chip means **the process serving this page** — the resident web on the standalone page, the host inside DSH Settings; the panel also lists the **resident instance** version, so you can tell at a glance which one to restart.

**MCP is a protocol, not a resident service**: the agent spawns it per session and exits when done — no "auto-start on boot" concept.

### Three deployment intensities

| Scenario | Config | Memory |
|---|---|---|
| Personal dev (recommended) | `autoWebMode=init` + **manually** turn `watchdogAutoSpawn` off (its default is **on**) | web 47 MB |
| Resident 7×24 | `watchdogAutoSpawn=on` | web + watchdog 47+47 MB |
| True boot auto-start (no DSH) | Windows Task Scheduler runs `dsh-memory watchdog --port 7799 --interval 5000 --max-restart 10` | same |

---

## ⚙️ Memory Config (plain words)

> All settings live in the **vault left rail "Memory Config"** (or DSH Settings → Memory) — edit and hit "Save". Here's the full page (plugin info / Agent MCP mount status / auto-audit config):

<p align="center">
  <img src="https://raw.githubusercontent.com/EternalNight996/memory-eternal/main/assets/screen/memory-config.png" width="880" alt="Memory config page" />
</p>

### 1. Most used

| Setting | Default | In plain words |
|---|---|---|
| Auto capture | on | auto-store useful content as cards after each turn |
| Auto recall | on | AI auto-queries memory when it needs history |
| Vault dir | `~/.dsh/memory-vault` | where memory lives, plain Markdown & git-able |

#### Multiple vaults (per-project isolation)

Two extra fields in `memory-eternal-config.json`:

```json
{
  "vaultProfiles": [{ "name": "work", "path": "D:/vaults/work" }],
  "activeVault": "work"
}
```

Resolution order: `MEMORY_VAULT_DIR` env → the `path` of the `vaultProfiles` entry whose `name` matches `activeVault` → `vaultDir` → default `~/.dsh/memory-vault`.

**Since v0.9.8 the CLI / MCP / hooks / standalone web / sweep share the host's exact order** — previously only the host honoured `activeVault`, so switching vaults left the terminal and hooks writing to the default vault and split your memory in two.

> Note: the settings page still has no form for `vaultProfiles` / `activeVault` (edit the config file by hand), and per-workspace auto-selection is not implemented yet.

### 2. Save money (important)

| Setting | Default | In plain words |
|---|---|---|
| **Distill cards** | on | **compress** a conversation into a sharp card (calls AI, costs money). **Off = store raw text, zero cost** |
| **Dedup feeds AI** | on | judge if new content is a duplicate (calls AI). **Off = simple dedup**, saves one AI call |
| Distill output cap | 900 | max chars per compress, bigger = sharper but pricier |
| Recall min score | 2 | how "close" a match must be to return; bigger = sharper but leaks more (cheaper) |
| Min capture chars | 200 | too-short chats aren't stored (avoids small-talk waste) |
| Daily quota | 60 | max cards per day, prevents AI burning money |

### 3. How the service runs

| Setting | Default | In plain words |
|---|---|---|
| Keep-alive `autoWebMode` | init | `init`=open web once at DSH start; `interval`=periodically check & restart if dead; `manual`=fully manual |
| Watchdog `watchdogAutoSpawn` | on | a **standalone process** keeps web alive (+47 MB). Personal use can turn off — but an existing instance is **not** stopped automatically, run `dsh-memory stop` (#19) |
| Drift self-heal `autoRestartOnDrift` | on | when DSH activates and the version **served on the port ≠ the version on disk** (resident web still on old code after an upgrade), restart the resident instance on the new code. Off = warn only; the **🔄 Restart resident instance** button still works (#19/#23) |
| Auto-mount MCP `autoMcpSetup` | off | **lets Claude Code / Codex / Cursor use your memory**. On = auto-configures them; Off = never touches your config, run `dsh-memory setup` manually |
| Credential hint `secretHint` | empty | put your own one-liner here (e.g. "when you need an API key/token, look up the secret directory in memory first"); it is **injected into every session's systemPrompt**. Memory only stores the **directory** (names / locations / how to use) — secret **values** never enter the vault (see "Where secrets live" below) |

> 🔑 **Where secrets live (how to use `secretHint`)**: keep the **values** in local credential stores
> (env vars / permission-tightened files); keep only a **directory card** in memory (which keys exist,
> where they live, what they are for, rotation status) and use `secretHint` so the agent remembers to
> look it up every session. Why values must not be stored: a card's `summary` is just the first 200
> chars of its body, and **recall sends the first 130 chars by default** (`recallSummaryLen`) — a value
> in the vault would travel into the model context on every recall, plus into `/export`, backups and
> multi-machine sync. `dsh-memory setup` registers a `PreToolUse` guard in Claude Code that **denies**
> direct reads of `.credentials.yaml` / `.env` / `*-token` and points at the directory card instead.

> 💰 **To save money**: turn `Distill cards` off, lower `Distill output cap`, raise `Recall min score`.

### 🎯 One-click presets

Top of the config page: **🟢 A Light / 💰 B Budget / ⭐ C Premium** — click to fill, then Save:

| Plan | Scenario | Keep-alive | Watchdog | Distill | Distill cap | Recall min | Memory | LLM cost |
|---|---|---|---|---|---|---|---|---|
| 🟢 **A Light** | Personal dev (recommended) | init | off | on | 2000 | 2 | ~47 MB | normal |
| 💰 **B Budget** | Tight budget / many Agents | init | off | **off** | 500 | 3 | ~47 MB | **~0** |
| ⭐ **C Premium** | Long projects / teams | interval | **on** | on | 1200 | 1 | ~94 MB | high |

---

## 🔔 Capture Log & Failure Alerts

Auto-capture is a silent background pipeline: when it broke, the only symptom used to be "no new cards" with no visible cause. Since v0.9.0 it speaks up.

- **Capture log**: Settings → Memory → Usage / Today shows the last 100 run entries: `🚀 boot` / `👂 session attached (which event API + event count)` / `✅ card created` / `➕ update appended` / `⏭ skipped (reason)` / `❌ failed (reason)`.
- **Active alerts**: any failure turns the strip red at the top of the memory library *and* injects "auto-capture failed + reason" into the agent context, so the agent tells you in its first sentence — no need to dig through logs.
- **Stall watchdog**: if turns start but no turn-stopping event arrives for 15 minutes (e.g. DSH renamed the event), a 10-minute sweep reports it.
- **Self-adapting event API**: the session event API is detected automatically (`ownEvents()` → `snapshotEvents()` → `events`), so a DSH upgrade that changes the API can no longer silently break capture.

---

## 🛡️ Audit Center & Recycle Bin

> **Agents cannot approve on your behalf (since v0.9.1).** Whenever audit is active, the plugin injects a red line into the agent context: new cards stay `pending`, and calling the `approve`/`reject` endpoints (or any equivalent bypass) is forbidden. The decision is always yours.

New cards go to the **Audit Center** (`pending`) by default and enter the main vault only after you approve them; rejected ones move to "Rejected", where you can restore or delete to the recycle bin. Cards matching an exemption (audit mode = skip all / exempt agents / exempt kinds) go straight in; recycle-bin cards are recoverable within 30 days, then auto-purged.

<p align="center">
  <img src="https://raw.githubusercontent.com/EternalNight996/memory-eternal/main/assets/screen/audit-center.png" width="880" alt="Audit Center" />
</p>

- **Pending / Rejected** tabs, filtered by type / date / agent; select all and approve / reject / delete-to-recycle in one click.
- Rules in "Memory Config → Auto-audit config": `audit mode` (audit all / skip all) + `exempt agents` + `exempt kinds` + `recycle retention days`.

### 🥇 Why the audit system is more reliable (vs other memory products)

Most memory products (mem0 / Zep / agentmemory…) auto-ingest **everything** the moment a conversation ends, good or bad — noise, wrong facts, and sensitive content all go in and get recalled later, **polluting context and amplifying hallucinations**.

memory-eternal uses **human-in-the-loop auditing** — only trusted content enters the main vault:

| Dimension | Other memory products | memory-eternal audit system |
|---|---|---|
| Ingest | Auto-ingest all, no gate | New cards first enter the **Audit Center (`pending`)**, approved before entering the vault |
| Quality | No filtering of noise/errors | Only cards you've confirmed → more accurate recall, less noise |
| Traceability | No source/audit trail | Every card carries `submittedBy` author + `pending/approved/rejected` state |
| No-friction | — | Exempt agents / exempt kinds hit → trusted cards go straight in, zero wait |
| Safety | Delete = gone forever | Recycle-bin soft delete, recoverable within 30 days |

---

## 🧬 Why Fully Self-built

Most memory solutions lean on third-party frameworks / spin up an MCP service / lock memory in a private store. This plugin builds the skeleton itself — **zero third-party runtime deps**, logic readable line by line:

| Module | Self-built | Replaces |
|---|---|---|
| Dedup | lexical Jaccard bigram (0.62) + semantic dedup | duplicate-card prevention |
| Retrieval | CJK-aware: Chinese whole-word + char bigram | no full-text search engine needed |
| Graph | force-directed + `[[wikilink]]`/shared-tag edges | see knowledge links at a glance |
| Storage | plain `.md` with frontmatter | not locked in, readable, git-able, any tool can read |

> Same direction as popular projects (summarize→store→recall), but positioned differently: **local, self-built, zero-dep, readable & controllable**. If you already use mem0/Zep etc., just layer this as a "local persistent memory base".

---

## 🛠 Development / Test

```bash
npm i
npm test        # unit tests: vault dedup/retrieval/graph + capture pipeline + API shapes
npm run build   # builds lib/client.js (DSH embed) + web/app.js (standalone web bundle)
```

> 📄 **The README ships as two separate files**: `README.md` (Simplified Chinese, the **default** —
> this is what npm and the plugin marketplace render) and `README.en.md` (English). Heading levels are
> 1:1 between them, so **a change in one must be mirrored in the other** (add new sections on both sides).

---

## 🐞 Reporting a bug

The left rail has a **🐞 Report a bug** entry: describe the problem, then either

- **Open prefilled issue on GitHub** — title, body, diagnostics and the `bug` label are filled in; one more click on **Submit** files it;
- **Copy AI prompt** — paste it into your AI chat and it will run `gh` to de-duplicate, file the issue and report the URL back.

> **Why not one-click submission?** GitHub forbids anonymous issue creation, a token inside the plugin would be extracted by decompiling, and OAuth / a relay needs hosted infrastructure — hence "pre-fill + one click".
> Diagnostics are **auto-redacted** (home directory → `~`; `sk-` / `ghp_` / `github_pat_` / `api_key:` → `***`), but do skim them before posting publicly.

If you cannot reach the UI, paste the prompt below into your AI chat and replace the last placeholder with your problem:

```text
I hit a problem while using memory-eternal (a DeepSeek Harness memory plugin). Please file it on GitHub for me.

Repo: https://github.com/EternalNight996/memory-eternal

Workflow:

1. Run `gh issue list --repo EternalNight996/memory-eternal --state open --limit 50` first: if a matching issue exists, add a comment with `gh issue comment <n> --body-file <file>` instead of opening a duplicate.
2. Otherwise create it with `gh issue create --repo EternalNight996/memory-eternal --title "[Bug] <one-line summary>" --body-file <file>`, using sections: Symptoms / Steps to reproduce / Expected / Actual / Environment (plugin, DSH, OS, Node) / Diagnostics.
3. If `gh` is not authenticated or unavailable, do NOT try to submit: output a GitHub new-issue link with the title and body pre-filled instead, and I will click submit myself.
4. Report the resulting issue URL back to me.

Keep my description verbatim - do not rewrite or summarise it. Put the diagnostics under the Diagnostics section as-is.

My description:
<write your problem here>

Diagnostics:
<paste the diagnostics copied from the in-app Report-a-bug dialog>
```

### Self-diagnostics (paste these when reporting — triage gets much faster)

```bash
dsh plugin list                      # plugin version
node -v                              # Node version
curl http://127.0.0.1:7999/memory-eternal/api/web-info    # is the standalone web alive?
```

---

## 📋 Changelog

> **Withdrawn versions**: **v0.9.16 – v0.9.22 are all withdrawn** (problem-period releases: git tags deleted, npm entries deprecated — use **v0.9.23**). **v0.9.14 is deprecated** (its client-rendering changes hurt the feel and were reverted; its server-side algorithm work shipped in **v0.9.15**, whose rendering is identical to v0.9.13). **v0.9.0 – v0.9.5 are all deprecated on npm, and the release tags for v0.9.1 / v0.9.2 / v0.9.3 / v0.9.4 have been removed from git** (v0.9.5 is merely superseded, so its tag stays) — v0.9.1/v0.9.2 ship the blank-memory-page defect, v0.9.0 false-alarms its capture warnings, v0.9.3 does not support DSH v0.1.7-rc.2 (the plugin stops mounting entirely: the settings service changed and the client-side `settingsScope` is gone), v0.9.4 crashes under the official desktop build (schemastery 3.18.4 volatile live references) with `cfg.vaultDir.trim is not a function`, and **v0.9.5's full-screen overlay covers the desktop shell's window controls (its top-right "×" sits on the window Close button — one click quits the whole shell)**. Use **v0.9.6+** (`npm i memory-eternal@latest`).
> **DSH compatibility**: `>=0.1.5-alpha.2 <0.3.0-0` (**widened in v0.10.1**: the old `<0.2.0` upper bound excludes DSH `0.2.0-rc.x` under plain semver — DSH's plugin guard uses `includePrerelease: true`, so installs still worked, but the declaration did not match reality. The range now covers the whole 0.1/0.2 line, and `<0.3.0-0` still blocks 0.3.0 and its prereleases. **Verified running on the official desktop build DSH 0.2.0-rc.2**: mounting, memory page, auto-capture, review centre and import/export all work). **v0.9.4 adds support for DSH v0.1.7-rc.2**, which replaced the settings service with a forms-only API and removed `@deepseek-ai/dsh-client-runtime` / `settingsScope`; **v0.9.5 adds support for schemastery ≥3.18.4 volatile live references** (the shape the official desktop profile uses, while the web profile still ships 3.18.1 — both work); **v0.9.6 keeps full-screen overlays clear of the desktop shell's window controls**. The 0.1.5 line still uses the legacy `settings.register` path; both paths are kept.

| Version | Date | Highlights |
|---|---|---|
| **v0.10.12** | 2026-10-09 | **Two quiet things that either burn money or leave a hole every day.** ① **Default distiller output cap: 2000 → 4000 (the hard ceiling)**: the logs kept showing "hit the maxTokens=2000 cap → retry the same candidate at 4000", and each occurrence **wasted one LLM call** (hit the cap, then re-run the same candidate at 4000). `maxTokens` is only a ceiling and billing follows what is actually generated, so the default now sits at the hard ceiling: those turns finish in one call; `maxTokenLadder` stays for users who **explicitly** lower `captureMaxTokens`. ② **A cross-site write gate on the plugin API**: `/memory-eternal/api/*` is unauthenticated, so any local web page could POST `/config`, `/audit/approve`, `/write`… New `crossOriginError()` — state-changing requests (non-GET/HEAD/OPTIONS) must be **same-origin with the Host of the request itself**: browsers always send `Origin` on cross-site requests (a mismatch returns 403 `CROSS_ORIGIN_BLOCKED`), while same-origin pages (DSH settings/memory page, the standalone page) and LAN access stay unaffected, curl / CLI / MCP calls without `Origin` keep working, and desktop-shell schemes like `app://` are allowed so nothing breaks. Both the intercepted host routes (`/config` POST, `/restart-self`, `/mcp/action`…) and the shared api entry carry the gate. Adds `tests/csrf-origin.test.mjs` (4 checks: decision matrix incl. LAN / no Origin / null / app://, a cross-site POST getting 403 without reaching business logic, both entry points present, and the default cap equal to the hard ceiling with no ladder retry). `npm test` now runs **297 checks** |
| **v0.10.11** | 2026-10-09 | **One more layer of tolerance in distiller-output parsing: unescaped quotes inside string values (`Expected ',' or '}' after property value`)**. The scene: `UNPARSEABLE_OUTPUT` dominates the `fail` log (103 of the last 600 entries); the freshest one carries the full picture — `JSON.parse 原始报错：Expected ',' or '}' after property value in JSON at position 1913`, with an excerpt whose body reads `运行 "npm test" 时…`: the model wrote a quote into the string as content, so the parser took it for the string terminator. That is a **different** class from the bare control characters fixed in #24 (a control character is illegal inside a string, a quote merely needs escaping). Fix: new `repairUnescapedQuotes()` — a `"` only ends the string when the next non-space character is `:`, `,`, `}`, `]` or end-of-text, otherwise it is escaped as content; it participates **only as the last candidate** and the result must still pass the card health check (usable title + body ≥20 chars) — better to fail than to write a bad card. Guarded by `tests/capture-json-repair.test.mjs` (4 checks: identity on valid JSON, the live unescaped-quote case, control chars + quotes combined, truncation still failing honestly). `npm test` now runs **293 checks** |

<details>
<summary>Older release notes (v0.10.10 and earlier · 37 releases, click to expand)</summary>

| Version | Date | Highlights |
|---|---|---|
| **v0.10.10** | 2026-10-09 | **The review centre can finally show card bodies, and you can approve/reject in place (issue #27)**. The scene (thinrflbtlm): the review centre listed only "title / kind / source / severity / reason" and **never the body**; and since v0.10.0 pending cards live physically quarantined, while the library lists approved cards only — so "no review without manual confirmation" made auditing pointless. ① Every row gains a ▸/▾ toggle (clicking the title works too) that **expands the frontmatter + body in place**, rendered with the **same Markdown pipeline as the card reader** (`renderMd` + `splitFrontmatter`), not raw text; ② the body is fetched **on demand** (`GET /card?path=…&status=pending|rejected`; the server still only allows paths that really sit in the queue, unknown paths keep returning 403 `CARD_NOT_APPROVED`), so the list endpoint never ships a whole store of bodies; ③ the expanded block carries **✓ approve / ✕ reject** directly (the recycle-bin tab uses ✓ restore / 🗑 delete), while bulk selection and the toolbar stay as they were; ④ approving/rejecting collapses and refreshes automatically, with both language dictionaries updated. Adds `tests/issue-fixes-6.test.mjs` (2 checks: a pending body is readable and leaves the queue once approved, plus source guards for on-demand fetching and the deny code). `npm test` now runs **289 checks** |
| **v0.10.9** | 2026-10-09 | **Root fix for the upgrade-window port drift that turned the memory page into "connection refused" (issue #29)**. The scene: a detached instance left by the old package sat on 7999 without reporting a version → the host `ensureWebServer()` could not recognise it, drifted to 8000 and wrote that into `web-info`; the plugin's self-heal then reaped the instance on 8000 as a stray → `web-info` dangled on a dead port (the page loaded once, then "connection refused 127.0.0.1" after a refresh). ① **The library page now uses a host same-origin shell**: the host gains `/memory-eternal/ui/app` (same index.html as the config page `/ui/config`, where `<script src="app.js">` resolves to `/ui/app.js`), so the iframe address is **decoupled from whichever port the resident instance listens on** (an older host still falls back to `web-info`). ② **`/web-info` converges live**: before answering, it probes "configured port → recorded port", uses whichever is serving, and reports `alive:false` when neither is (no more advertising a dead address); it is also rewritten right after a successful self-heal restart and whenever the interval keeper sees the instance alive. ③ **No more blind port drift**: new `looksLikeOurWeb()` (lenient detection of "ours but not reporting a version": any `ok:true` from /overview, /web-info or /budget) gives self-heal a 6s takeover window before drifting, and logs it when it does drift. ④ **Backoff retry in the health check**: `inspectResident()` no longer concludes "old instance that does not report its version" from a single missed probe (that verdict triggers a needless replacement on every start), it retries with backoff first. Adds `tests/issue-fixes-5.test.mjs` (4 checks). `npm test` now runs **287 checks** |
| **v0.10.8** | 2026-10-08 | **Saving on the standalone web page now takes effect on click: the pending apply moves from a plugin callback into a host HTTP request (design A, measurement-driven)**. The scene: a standalone-page save ended in a `dropped` patch after five retries, always with `HMR transactions cannot be nested` (0.10.7 only stopped it from masquerading as an auto-capture anomaly and filtered upgrade-window keys — the sync itself was not fixed). **Measured on the same host with the same `settings.update`**: called from a plugin **callback** (`setInterval` / `fs.watch`) → guard error and **nothing was committed at all** (a patch with only host-known keys and a genuinely different value failed the same way); called from a plugin **HTTP request handler** → **it really committed** (`recallSummaryLen` 130→132→130, `revision` 4→6). So the fix is not another API but another **calling context**: ① the host gains `POST /memory-eternal/api/drain-pending`, applying the pending patch inside a **request handler** (two gates: loopback origin plus a per-process token from the heartbeat file, so no other local page can write); ② the host publishes its web server's **listening port + token** in the heartbeat (`webServer.port` is a public getter), and a standalone save now **wakes the host** and reports the real result (new `savedApplied` toast); ③ a failed wake-up (old host without the route → 404, port mismatch, timeout) is **not** an error — it falls back to the 0.10.5 waiting path and the "change it under DSH Settings" hint. Adds `tests/host-drain.test.mjs` (6 checks: loopback, the three gates, the end-to-end wake-up, failure reporting, 404 fallback, source guards) plus `tests/e2e-host-drain.mjs` (2 checks: a **real spawned process** end-to-end "standalone save → wake the host → host applies → reports applied", and the fallback to "queued" when the heartbeat comes from an old host with no port/token). `npm test` now runs **283 checks** |
| **v0.10.7** | 2026-10-08 | **"Still the old version after starting dsh" fixed at the root: version-drift self-heal + one-click resident restart (the positive answer to #19 / #23).** The scene: an npm upgrade only swaps files on disk, and the **resident web (port 7999 by default) outlives the DSH host** — the process on the port keeps running the code it loaded at startup, while activation policy was "there is already a live watchdog on this port → `delegated` (no spawn, no replacement)", so **no number of DSH restarts ever replaces it** (measured here: the host started at 10:19 on the new build and the same-origin settings panel showed 0.10.6, while the web on 7999 had started at 08:15 on 0.10.0 — `/config` and `/version-check` each reported a different version). ① **Startup self-heal (`autoRestartOnDrift`, default on)**: activation first runs `inspectResident()` — the version is always asked from **the port** (the lock's `pkgVersion` is only the watchdog's self-report, and an old instance wrote an empty string, so drift was invisible) — then `decideResidentAction()` decides: match → `delegate` (keeping #19's honest wording), drift → `restart`, own version unreadable → touch nothing, just replaced → debounce (a config change re-runs the effect). **"Updating the running program" is therefore defined as "restart that resident process on the new code", never as hot-swapping modules in memory**: ESM module cache plus closure state (settings / vault routing / SSE hub / `fs.watch` / the already-bound port) leaves no safe way to hot-swap, and a cache-busting re-import only produces a second module graph (double instances, double listeners, double writes). ② **One implementation for replacement**: new `restartResident()` spawns a detached `watchdog.js --replace` helper (reap the old watchdog / old web → **wait for the port to really free up** → take the lock → pull up the new web), then verifies "the version served on the port equals the local version" (#23 suggestion 2); if the port never frees up it **aborts the takeover** instead of falling back to `port+1` (fallback instances are exactly where orphan webs are born). `dsh-memory restart`, host startup self-heal and the panel button now share it. The helper is detached with `stdio:ignore` (nobody reads its stderr), so the takeover outcome **must** go into the capture log — otherwise "restarted but not in effect" becomes yet another untraceable silent failure. ③ **One-click fix in the panel**: new `POST /memory-eternal/api/restart-self` under three hard rules — this process may well **be** the stale web being replaced, so the response is sent **before** the replacement is scheduled; if the resident instance is already current it answers `alreadyCurrent` (the common case when clicking from the DSH panel — a healthy instance is never needlessly taken down); and only one replacement may run at a time. ④ **Panel semantics disambiguated**: "running" became "**running (process serving this page)**" (the resident web on the standalone page, the host inside DSH Settings — the very reason the two panels' numbers disagreed), plus a new "**resident instance vX**" chip so it is obvious which one to restart; the drift banner offers the button plus the equivalent command, and when the resident instance is already new but this page is not, it says plainly "restart the desktop app / DSH" instead of offering a button that would do nothing. ⑤ **`updateAvailable` now compares versions**: `latest !== onDisk` used to **advise downgrading** when running an unpublished local build (disk 0.10.7 / npm 0.10.6); it now uses `compareVersions` (with prerelease semantics, `rc.2 < rc.10`). ⑥ Also removed a duplicate `saving` key from the client dictionary (esbuild warned on every build). New `tests/watchdog-restart.test.mjs` (17 checks: decision matrix / inspection asking the port / replacement verification / non-lethal takeover cleanup / route responding before replacing + concurrency gate / version comparison). ⑦ **The README now ships as two separate files**: `README.md` is the **default** Simplified Chinese one (what npm and the DSH marketplace render) and `README.en.md` is the English mirror; both gained a language switch plus a "change one, change the other" note at the top, and the English self-diagnostics subsection that was missing; new `tests/readme-i18n.test.mjs` locks **1:1 structure** (heading-level sequence + code-block count + cross links + default-language markers) so future edits cannot land on one side only. ⑧ **`secretHint` credential hint + credential-read guard**: one line of your own convention gets injected into every session's systemPrompt so the agent looks up the **secret directory card** in memory first when it needs an API key / token (memory stores the directory only — names / locations / how to use — while **values stay in local credential stores**); `dsh-memory setup` now also registers the Claude Code `PreToolUse` guard (denies reads of `.credentials.yaml` / `.env` / `*-token` and points at the loader) and refreshes hook paths that still point at an older install. ⑨ **Three more live-site findings fixed before release**: ① the panel's **restart resident instance** button also showed when the *process serving this page* was the old one — clicking it must 404 (the old host has no such route) and the user only saw "unknown interface"; it now appears only when the resident instance on the port is behind the files on disk, and a 404/405 gets explicit "restart the desktop build / DSH, or run dsh-memory restart" guidance. ② When the standalone page (new) submits the whole form to an old host, the host drops the keys it does not know (e.g. `secretHint`) by whitelist → the read-back check can never match → five retries then `dropped`, with the user only seeing "HMR transactions cannot be nested"; the pending patch is now **filtered against the host schema** before it is applied (unknown keys take effect once the host upgrades), and "config sync failed" is kept strictly apart from "auto-capture anomaly" (`config-warn` / `config-fail`, no longer painting the capture health red). ③ `autoRestartOnDrift` now renders as **on** when the host snapshot has no such key (measured: 0.10.6 host + 0.10.7 panel → checkbox empty while the host actually treats it as on). Adds `tests/issue-fixes-4.test.mjs`. `npm test` now runs **274 checks** |
| **v0.10.6** | 2026-10-07 | **Orphan webs are now reclaimed + a failed shared-config sync is no longer silent.** ① **Orphan webs**: the web child is spawned detached, so when a watchdog is hard-killed (on Windows `process.kill(pid,'SIGTERM')` terminates unconditionally) its exit handler never runs; if that web had **fallen back to port+1…** because the target port was taken, the lock entry naming it disappears together with the watchdog — leaving an unowned web parked on 8001/8002 (two were found on this machine, one of them 20 hours old, and `status` only probes the configured port so it could never see them). Now `startWatchdog` on startup, and `stop`/`restart` (the `checkPort` path), sweep the **fallback window** `[port+1, port+9]` and reap them; three gates must all pass (the port is inside the window / the command line **really is this plugin's web** / the pid is not any watchdog's `pid` or `webPid` in the lock), so **someone else's `node web.js` is never killed**. In addition `spawnWeb` no longer spawns a duplicate when the target port already holds our own web (the main source of fallback instances) — liveness is left to the tick probe. ② **`syncConfigFile()` no longer swallows errors**: it writes the read source shared by the standalone page / hooks / MCP, so a failed write shows up as "config changed but they can't see it" — the old code was `catch { /* silent */ }` (observed once: the shared file's mtime stayed at pre-activation while the host's own value had changed). Failures now reach stderr and the capture log as a `warn` (same reason reported once, no spam); because `logCapture` is defined later inside `apply()`, the log line is deliberately deferred by one tick to avoid the `const` TDZ. New `tests/watchdog-orphans.test.mjs` (7 checks); `npm test` now runs **245 checks** |
| **v0.10.5** | 2026-10-07 | **Config saves from the standalone web page: no more empty promise, and no DSH install required.** ① **A host-independent write path (#21)**: if nothing consumes the pending file within 800 ms **and** no live DSH host is present (the heartbeat file `memory-eternal-config.host.json` is stale, or its pid is dead), the standalone side now **atomically merges** the change straight into the shared config, clears the pending file and answers `pendingOutcome: applied-direct` — so Codex / Claude Code / Cursor users, and anyone running only `dsh-memory serve`, get their save applied immediately (previously that path just wrote a "pending" file for a host that **does not exist**, while the UI promised "takes effect on next start" forever). When a host *is* alive the standalone side **never** writes directly: the shared file is the host's derived mirror, and a direct write would be overwritten by the next `syncConfigFile()` (a dedicated reverse test guards that boundary). ② **Failures now give directions, not just an error (#21)**: host-guard errors are recognised — `HMR transactions cannot be nested` (Cordis HMR hosts) and `root.events.emit is unavailable from a plugin activation` (dsh-tui and friends) are two phrasings of one defect family — and "this host does not let a plugin write config from its own callback context" plus where to change it instead (**DSH Settings → Memory**, or the profile patch layer) now lands in the give-up error, the diagnostics and the standalone page's hint; `POST /config` also returns `hostGuard` / `hint`. ③ **The UI no longer always says "Saved" (#21)**: the client consumes `pendingOutcome` — `queued` / `failed` use the non-success style and say "not confirmed applied yet", `applied-direct` states "no DSH host here, written straight into the shared config", and only a real apply shows "Saved". ④ Also fixed a cleanup race that could keep a host or test process **alive forever**: the heartbeat timer and the pending-file watcher are created after an async `import()`, so a dispose that happened before it resolved left them uncleaned (the heartbeat interval is additionally `unref()`ed) — this is exactly what hung `tests/settings-compat.test.mjs` when it ran `apply()` against a fake ctx. New `tests/issue-fixes-3.test.mjs` (9 checks); `npm test` now runs **238 checks** |
| **v0.10.4** | 2026-10-07 | **Four "looks fine, silently wrong" issues fixed at once (#21 / #22 / #23 / #24).** ① **A save misreported by a host guard is no longer treated as failed (#21)**: the capability guard in hosts such as dsh-tui throws `root.events.emit is unavailable from a plugin activation` from the `describe()` call **inside** `settings.update`, even though the write has already been committed — the old code only asked "did it throw", so an **already-applied** change was retried 5 times, marked `dropped` and logged as a failure. New `applyPatchVerified` **reads the config back** after a throw (predicate `patchApplied`, shallow compare) and logs one line while treating it as success; drain and the standalone web share that path, and the standalone web's `POST /config` no longer claims "all good" unconditionally: it waits up to 800 ms for the pending file to be consumed and returns `pendingOutcome: applied / failed / queued` with matching wording (`waitPendingOutcome`). ② **`/cards` status no longer silently misaligns (#22)**: `status=deleted` now really lists the **recycle bin** (the numbers match `/recycle/list`), and an unrecognized value returns `unknownStatus: true` plus `appliedStatus` / `requestedStatus` echoes (the fallback to approved stays for old callers, but it is no longer silent). ③ **After an upgrade, trust the version actually served on the port (#23)**: `/overview` gains the `version` loaded by the **serving process**; `dsh-memory status` reports the **port's actual served version** and says "upgrade not in effect" when it differs (the lock file's version is only the watchdog's self-report; when the port holds a **pre-0.10.4** web nothing can be probed because its `/overview` has no `version` field yet, and the tool then says exactly that — "this plugin's web, but it does not report a version, i.e. an old build" — instead of wrongly claiming no service is responding); `stop` re-checks the port occupant afterwards and warns if it is still taken; `restart` no longer trusts only the webPid recorded in the lock — it falls back to the **port occupant** to reap an old web the lock never registered (only after confirming from the command line that it really is **this plugin's** web — the `memory-eternal` package name, or the absolute path of this plugin's own `lib/web.js`; someone else's `node web.js` is merely warned about, since killing an unrelated process that happens to hold that port is worse than not killing at all), aborts if the port never frees up, and self-checks "port-served version = local version" after startup, exiting non-zero on a mismatch (no more "started" and then silence). ④ **Distillation no longer misreads bare control characters inside strings as unparseable (#24)**: when the model writes a markdown body with real U+000A newlines (braces balanced, `looksTruncatedJson` false), the old code always failed `JSON.parse` and dropped the whole card into a raw-text fallback. New `repairJsonControlChars` escapes bare control characters **only inside strings** (`\n` `\r` `\t` `\b` `\f`, otherwise `\u00XX`; newlines outside strings are legal JSON whitespace and stay untouched), and candidates are tried as "as-is → sliced `{ … }` → each one's repaired form"; parse failures no longer swallow the raw `JSON.parse` error, and the excerpt now keeps **both head and tail** (`describeOutputExcerpt`; the old `slice(0,160)` made output cut mid-`"body":` look like a broken stream); the max-tokens retry went from "double once" to `maxTokenLadder` **doubling all the way to the schema ceiling** (1200 → 2400 → 4000, no longer stopping at 2400). New `tests/issue-fixes-2.test.mjs` (21 checks); `npm test` now runs **229 checks** |
| **v0.10.3** | 2026-10-06 | **Fixed the counting semantics of `audit list` (#20).** ① The total is now **decoupled from `--limit`**: the reported count is the **matching total** (via `countCards`) while `--limit` caps output only, and truncation is stated explicitly (`显示前 M 张 … 还有 X 张未显示`). ② **No more silent truncation by default** (omit `--limit`, or `--limit 0`, to list everything). ③ `--json` now exposes `total` / `returned` / `count` (a backward-compatible alias of total; in 0.10.2 it wrongly equalled returned) / `limit` (null = all) / `hasMore`. ④ The meaning of `--status all` is documented in the usage text and README: the audit queue (pending + rejected), **excluding** dequeued approved and recycle-bin deleted; `approved` remains queryable explicitly. ⑤ **Same defect fixed in the MCP `memory_audit_list` tool**: it also silently capped at 20 and reported the truncated length as the pending count; it now reports the matching total plus how many are hidden, cap 100 → 500. |
| **v0.10.2** | 2026-10-06 | **Five long-standing issues fixed at once (#15 / #16 / #17 / #18 / #19).** ① **Per-project vaults finally work in the host (#15-1)**: the host matched `vaultProfiles[].match.workspace` against the process cwd (the directory dsh was launched from) — it now uses the **session's own workspace** from `session.header.cwd` (both capture and `memory_recall`), while CLI/MCP/hooks keep their existing cwd behaviour. ② **Distillation stops burning doomed candidates (#15-2)**: providers declaring `supportsReasoningEffort:false` no longer receive a `reasoningEffort` field (unknown = supported), and they move behind supporting candidates instead of being dropped. ③ **Truncated output is no longer misreported as a parse failure (#18)**: a dedicated `MAX_TOKENS` code (with the actual cap in the message), one automatic retry with a doubled cap, failure reporting that **always keeps the first candidate's error as the primary cause** plus a per-code summary of the rest, default `captureMaxTokens` 900 → **2000**, and a `distill-failed` tag on fallback raw cards. ④ **Standalone-web config saves are no longer lost silently (#16)**: drain errors are no longer swallowed (stderr + capture log, throttled), and the shared `memory-eternal-config.json` is now written **atomically (tmp + rename)** — the old non-atomic write could be read mid-truncation by the standalone web / MCP, fail JSON.parse and silently fall back to defaults, the pending file is **kept** with `dropped:true` + `lastError` after retries are exhausted, and the state shows up in `/diagnostics` and `/config`. ⑤ **Audit CLI (#17)**: `dsh-memory audit list/approve/reject` (multiple paths, `--json` for jq) reuses the same `setCardStatus` guard and `audit_log`; MCP gains only a **read-only** `memory_audit_list`. ⑥ **Watchdog lifecycle (#19)**: new `dsh-memory status/stop/restart`, `pkgVersion` recorded in the lock (status warns when the resident instance is outdated), truthful `spawned` vs `delegated to existing pid` host logs, a clear notice when `watchdogAutoSpawn` is off but an instance is still running, `dsh-memory stop` also stops the **web server the watchdog spawned** (on Windows `process.kill(pid,'SIGTERM')` terminates unconditionally, so the watchdog's own exit handler never runs — the old behaviour left an orphan web holding the port; the web pid is recorded in the lock and confirmed against the process command line before killing, avoiding pid-reuse mistakes), plus README fixes for the contradictory default and the "restart turns it off" promise. |
| **v0.10.1** | 2026-10-02 | **Fixes "export works, import brings in 0 cards".** Root cause: "Export JSON" wrote a **bare array**, while `/import` only read `payload.cards` — a bare array was silently treated as an empty backup (`ok:true` / `imported:0` / `skipped:0`), so the UI only ever said "Import complete: 0". ① `/import` now accepts both a **bare array** (backups from v0.10.0 and earlier) and an **envelope object** `{format, formatVersion, exportedAt, count, cards}`; an unrecognized shape returns **400 with a readable reason**, an empty file returns a `warning`. ② Export now writes the envelope (older builds only read `payload.cards`, so the envelope stays compatible with them) and keeps each card's `status` / `store`. ③ The import dedup baseline is now a **pre-import snapshot** (new `dedupAgainst` option on `writeCard`) — otherwise near-identical cards inside one backup dedup against each other and swallow part of the batch (a backup is the source of truth). ④ The import response adds `total` / `skipped` / `quarantined` / `failed[]` (with a per-card reason), and the toast reads "Import complete: N / of M · pending review K · skipped D"; a run that imports nothing is shown as a failure. ⑤ New `tests/import-roundtrip.test.mjs` (6 checks). ⑥ **A broken install now speaks plainly (issue #14)**: a copy installed from the plugin marketplace can be missing its `web/` assets, and the sidebar then showed a raw `{"ok":false,"error":"ENOENT …"}` page. Now a missing `index.html` with `app.js` still present is covered by a **built-in shell** that boots the UI anyway (self-healing), while a missing `app.js` returns a JS snippet that paints the diagnosis into `#root` plus a page stating which file is gone, its absolute path, the package version and how to reinstall. Both cases land in the auto-capture log (`app.js` → `fail`, health turns red; `index.html` only → `warn`), and the host self-checks the same way at startup (shared predicates and wording in the new `lib/web-assets.js`, with 6 checks in `tests/web-assets.test.mjs`). ⑦ `appendCaptureLog` no longer fails silently when the `DSH_HOME` directory does not exist. ⑧ **DSH compatibility widened to `>=0.1.5-alpha.2 <0.3.0-0`**: the old `<0.2.0` upper bound excludes DSH `0.2.0-rc.x` under plain semver (DSH's guard uses `includePrerelease:true`, so installs still worked, but the declaration did not match reality) — the range now covers the whole 0.1/0.2 line while `<0.3.0-0` still blocks 0.3.0 and its prereleases; `dsh.compatibility` gains `"0.2.0-rc.2": "compatible"` (verified on the official desktop build 0.2.0-rc.2). ⑨ **Fixed three third-party plugin manifests that were invalid JSON**: the closing quote of `description` in `.claude-plugin` / `.codex-plugin` / `.cursor-plugin` had been swallowed by a double-encoding accident (last touched in v0.9.23); DSH never reads those files, so nothing surfaced, but installing through Claude Code / Codex / Cursor **always failed to parse**. They are now valid UTF-8 JSON with `version` bumped to 0.10.1, plus a new **shipped-files health guard** `tests/manifests.test.mjs` (3 checks: every shipped JSON parses / the three manifests' `name`+`version` match package.json / no encoding-accident mojibake in shipped text). Measured on a real **661-card bare-array backup (3.9 MB): 0 cards before the fix → 661 after** (654 into the main store + 7 into quarantine). `npm test` now runs **187 checks** |
| **v0.10.0** | 2026-09-30 | **Two stores: unreviewed content is physically quarantined.** ① `cards` (the main store) holds `approved` only, while a new `quarantine` store (with `quarantined_at` / `quarantine_reason`) holds `pending` / `rejected` / `deleted`; ② read paths (recall, search, graph, dedup, export) no longer need a status condition — querying the main store is safe by construction — which closes the three review-bypass holes audited in v0.9 (the dedup pool writing new knowledge into pending cards, `readCard` reading unreviewed bodies, `/card` skipping the status check); ③ review transitions became **cross-store moves** (inside a transaction, ids issued by the new `card_sequence` allocator, `card_updates` rebound with the card); ④ existing non-approved cards are **migrated automatically** on first start (nothing deleted, idempotent); ⑤ a new `checkMainStoreInvariant()` health check plus `tests/two-store.test.mjs`; ⑥ an intake noise gate that strips DSH runtime injections (environment snapshots, team broadcasts, teammate transcripts, tool manuals) so fragment cards and mushy titles never get in; ⑦ fixed the native crash of `settings-compat` on Windows (`fs.watch` on the parent directory → watch the file instead) |
| **v0.9.23** | 2026-09-30 | **No more save flicker.** After a successful save the client immediately re-fetches `/config`, but the host volatile echo lags, so inputs visibly reverted to the old values and then jumped back. The client now keeps a **local overlay** for fields that were saved but not yet echoed (`src/client/config-merge.js`, pure function + 4 checks), dropping each key once the host echoes it, and following the host value afterwards; resetting the form clears the overlay. `npm test` now runs **139 checks** |
| **v0.9.22** | 2026-09-30 | **Near-instant config sync (SSE push + file watching).** ① A new SSE hub (`lib/sse.js`): both hosts (DSH-embedded and standalone web) expose `/memory-eternal/api/events`, so a config change is pushed to every open page and the client reloads automatically — **without overwriting what you are currently typing** (dirty flag). ② Standalone save → DSH apply now triggers via `fs.watch` in **milliseconds** instead of a 5-second poll (the poll remains as a fallback). ③ The standalone page watches the shared config file, so a DSH-side save shows up there immediately. Adds `tests/sse.test.mjs` (5 checks); `npm test` now runs **135 checks** |
| **v0.9.21** | 2026-09-30 | **A successful save is no longer shown as a failure + config layout fix.** ① Success always uses the success style (the "written, host has not echoed yet" case used to pop up in the red failure style, which read as "save failed"), reworded to "saved to the config file; restart DSH to make it effective"; ② config field grid widened from 150/160px to **200/220px** with larger gaps and wrapping long labels, checkbox and text top-aligned — fields no longer crowd each other. |
| **v0.9.20** | 2026-09-30 | Standalone web page gains **range validation**: `/config` mirrors the Config schema min/max (`recycleRetentionDays` 1–3650, `webPort` 1–65535), returning **400** with "needs 1–3650, now 0" for out-of-range values. The most common save-failure path (cleared/out-of-range number) is now blocked with a field-level reason at all three layers: client, standalone page and host. |
| **v0.9.19** | 2026-09-30 | **"Save failed" now says why (root cause: clearing a number box yields 0, the schema rejects it, and the host answered with an empty 500).** Reproduced against the live host: out-of-range value / cleared number box / wrong type → **HTTP 500 with an empty body** → the client `r.json()` throws → only the generic "Save failed" is shown. Fixes: ① clearing a number input **no longer silently becomes 0** (an empty string coerced to a number is 0, while `recycleRetentionDays` requires `min(1)`); ② pre-save **per-field range validation** that names the field ("recycleRetentionDays must be a number between 1 and 3650, now 0"); ③ defensive response parsing: on a non-JSON or empty body the panel shows the HTTP status and the raw snippet instead of "Save failed"; ④ the host POST is wrapped so it **never returns an empty body**, and returns 400 plus the field names for empty numeric values; ⑤ the standalone `/config` validates types and ranges so invalid pending values cannot be written; ⑥ `drainPendingConfig` counts failures and gives up (deleting the file) after 5 tries instead of retrying forever. `npm test` now runs **130 checks** |
| **v0.9.18** | 2026-09-30 | **The standalone web page can finally save config — and a read-only page no longer feels dead.** Root cause (the other half of issue #12): the standalone web server has **no DSH settings service**, so its `/config` always returned `writable:false`; the client `save()` starts with `if (readonly) return` and the button was `disabled` — clicking Save did **nothing at all**, independent of the plugin version. Fixes: ① new shared-file protocol in `lib/config-sync.js`: the standalone page writes `memory-eternal-config.pending.json` atomically, and the **DSH host applies it on activation and every 5 seconds** via `settings.update(patch, undefined)` (skipping the optimistic-concurrency check), deleting the file on success and retrying on failure; if DSH is not running the change waits in the file for the next start. ② The standalone `/config` now reports `writable:true, viaPending:true` and the page shows a blue note explaining the sync. ③ **The button is no longer disabled when read-only** — clicking always explains why (`🔒 Read-only` + "desktop app → Settings → Memory"), so "no reaction" can no longer happen. Adds `tests/config-sync.test.mjs` (4 checks). `npm test` now runs **125 checks** |
| **v0.9.17** | 2026-09-30 | **"I updated it but the UI is still old" — fixed for good.** ① The build now injects the plugin version into the client bundle and the settings page shows a "**Page script vX**" chip; ② when the page-script version differs from the on-disk version it says so loudly: "⚠ This page is still running an older script (page v{page} / disk v{disk}): **press Ctrl+F5**"; the running-vs-disk hint now also leads with "refresh first, restart the desktop app / DSH only if the host half is old". Root cause of issue #12 ("saving shows no feedback"): the page was still executing the JS loaded before the update — the host sends `Cache-Control: no-store`, but **an already-open page never reloads its scripts**, so without a refresh you keep seeing the old UI. The standalone web service on `:7999` (an old process started 9/29) was restarted and now reports `loaded=onDisk=latest` |
| **v0.9.16** | 2026-09-30 | **Fixed config saves silently not persisting (issue #12) + full config coverage.** ① **Save path**: the host `dsh-settings.write()` requires the revision held by the panel to match `describe()` **exactly**; once stale it throws `SettingsConflictError` and the save fails — the plugin now re-reads the latest revision and **retries once** (marked ♻ in the message). ② **Late volatile echo**: after a successful write the patch is overlaid on the local view (reopening the panel shows the new value immediately) and the overlay is dropped once the host snapshot catches up; the host POST now **re-reads after writing** and returns `pending` with an honest note ("written; restart DSH to apply from the config file") when the echo has not landed. ③ **Immediate save feedback** (requested earlier): ⏳ Saving / ✅ Saved / ⚠ error now appears right next to the Save button, including whether a retry or an echo was involved, and the button label no longer wrongly says "Exporting…". ④ **Full config coverage**: seven fields that previously could only be edited by hand are now in the panel — the **master switch `enabled`**, single-vault `vaultDir`, distillation route `captureProvider` / `captureModel`, cooldown `captureCooldownMs`, semantic recall `recallEmbedding` and `sessionBudgetChars`; the host `/config` gained 6 keys and the standalone web `/config` gained 9. ⑤ New **permanent guard tests**: `tests/config-coverage.test.mjs` asserts every Config field is covered by the host API, the standalone web API and the settings panel (missing one turns the suite red), and `tests/settings-save.test.mjs` (5 checks) pins revision retry, overlay fallback and "never swallow errors". `npm test` now runs **121 checks** |
| **v0.9.15** | 2026-09-29 | **Server-side graph speed-ups only — rendering is identical to v0.9.13.** ① **On-disk graph cache** keyed by fingerprint at `<vault>/memory-eternal-graph-cache.json` (atomic write, invalidated by fingerprint, skipped above 8MB, failures only cost a rebuild): measured cold start **422ms → 11ms** at 596 cards; ② **hashed bigrams + counting-sorted rare-gram index**: `bigramHashSet()` packs each bigram into a 32-bit integer (`Set<number>`; **capture de-duplication still uses the string version, so semantics are unchanged**), and the rare-gram index is built with a counting sort (202 → **54ms**); ③ **MinHash + LSH** candidate generation (48-dim signatures, 24 bands, unioned with the rare-gram index and then **verified exactly**): Jaccard calls 15,148 → 6,797 and the similarity stage 210 → 130ms. Full cold build **600 → 422ms**, edges unchanged from v0.9.13 (tag 2777 / similar 4). **Zero client changes** — no sprites, no static layer, no skeleton degradation (the v0.9.14 client work was reverted and deprecated because it hurt the feel). Adds `lib/minhash.js` + `tests/minhash.test.mjs` (4 checks); `npm test` runs **108 checks** |
| **v0.9.13** | 2026-09-28 | **Seven fixes from user feedback.** ① **Version tracking**: Plugin info now shows **running (loaded by host) / on disk / npm latest** side by side, with an amber warning when disk is newer ("X is installed on disk but the running process still has Y — restart to apply") plus a "Check for updates" button (server-side npm lookup, 10-minute cache, 4s timeout). ② **Copy failure**: the memory dialog runs inside an iframe without clipboard-write permission, so `navigator.clipboard.writeText` is always rejected — it now tries the Clipboard API, falls back to `document.execCommand('copy')`, and finally shows the text in a read-only box with a Select-all button; the iframe also gets `allow="clipboard-write; clipboard-read"`. ③ **Silent save**: the result now appears right next to the Save button (⏳ Saving… / ✅ Saved / ⚠ error) and the button label changed from the wrong "Exporting…" to "Saving…". ④ **Recycle bin**: restore / purge / empty-all now report success and failure, and the empty state explains itself and disables the buttons. ⑤ **Button feedback everywhere**: the audit centre's approve / reject / delete used to swallow everything in `catch {}`; it now counts successes/failures and reports them (and warns when nothing is selected). ⑥ **Graph zoom jank**: new `src/client/graph-lod.js` — **viewport culling** (off-screen nodes/edges are skipped) + a **label budget** (≤120 nodes draw all; ≤300 draw 160; ≤600 draw 90; more draw 60, prioritising focus, hover, search hits and highest degree) + **text-width caching** + **shadows off for large graphs**. ⑦ Adds `tests/graph-lod.test.mjs` (5 checks); `npm test` now runs **108 checks** |
| **v0.9.12** | 2026-09-28 | **New "Report a bug" entry (🐞 in the left rail)**: the dialog takes your description and then either ① **opens a pre-filled GitHub issue** (title, body, diagnostics and the `bug` label already filled — one more click on Submit files it), or ② **copies a ready-made AI prompt** (paste it into your chat and the AI runs `gh issue list` to de-duplicate, files the issue and reports the URL back). **Why not one-click submission?** GitHub forbids anonymous issue creation, a token shipped inside the plugin would be extracted by decompiling, and OAuth/relay needs hosted infrastructure — hence "pre-fill + one click". Diagnostics come from the new `/memory-eternal/api/diagnostics` endpoint and are **auto-redacted** (home directory → `~`; `sk-` / `ghp_` / `github_pat_` / `api_key:` → `***`; truncated to 2400 chars), and the issue URL is truncated by **binary search** so it can never exceed the length limit (`URLSearchParams` inflates CJK by roughly 9x). Adds `lib/feedback.js` (pure functions) and `tests/feedback.test.mjs` (4 checks: redaction, diagnostic fields and length cap, pre-filled URL encoding/truncation, bilingual prompt); `npm test` now runs **103 checks** |
| **v0.9.11** | 2026-09-28 | **Fixed `watchdog --reap` killing itself**: when you run `node lib/watchdog.js --reap` directly, the caller's own command line also contains `watchdog.js` on the same port and is not in the lock — so the reaper SIGTERMed **itself**, showing up as "no output at all + exit code 1" (going through `dsh-memory watchdog --reap` was unaffected because its command line lacks `watchdog.js`, which is why it only showed up on the direct path). The protected set now always includes `keepPid`, the current pid and the parent pid, and any other process whose command line carries `--reap` is skipped; output now uses `fs.writeSync(2, …)` so `process.exit` cannot truncate it. Regression test added for "self and parent must never be killed" (using a real idle child process as the target instead of a fake pid). `npm test` runs **98 checks** |
| **v0.9.10** | 2026-09-28 | **Multi-vault + watchdog wrap-up, plus graph frame-time work.** ① **Multi-vault (#10)**: `vaultProfiles` / `activeVault` finally have a settings-page form (add/remove vaults, set directories, pick the active one, and see the effective directory / source / workspace); vault resolution moved into `lib/vault-resolve.js` and is **shared by the host and CLI / MCP / hooks / standalone web / sweep**, with new `vaultProfiles[].match.workspace` **auto-selection by project directory** (longest prefix wins, opt-in, still single-vault by default); `memory_recall` gained a `scope` argument (vault name / path prefix / `all` for cross-vault aggregation) and cross-vault results are labelled with their source vault. ② **Watchdog (#11)**: the lock is now **per-port** (several ports/vaults no longer overwrite each other) and `dsh-memory watchdog --reap` collects orphans left by earlier versions (only same-port processes that are not in the lock; the live registered instance and user-started watchdogs are left alone). ③ **Graph frame time**: edges are bucketed by colour + alpha + width and stroked with a single **Path2D** per bucket (2.7k edges: 2.7k draw calls → a handful), and node radial gradients are **cached per colour\|radius and reused via translate** (593/frame → essentially none after the first frame). ④ New `tests/vault-resolve.test.mjs` (7 checks), watchdog tests grown to 7; `npm test` now runs **98 checks** |
| **v0.9.9** | 2026-09-28 | **Fixed the sidebar "Memory" entry being pushed out of view (issue #2)**: the slot host comes in two shapes — the shell's own horizontal row (`.footerActions`) and a `div[data-slot="sidebar.footer.action"]` that other plugins (`dsh-diff-approval`, `dsh-footer-order`, …) turn into `flex-direction: column`. The old CSS applied `flex-wrap: wrap` plus `.me-footer { flex: 1 1 100% }` to both: inside a column container `wrap` means "new column" and `basis: 100%` means **100% height**, so the button was pushed into an overflow column and clipped to a sliver. `flex-wrap` is now scoped to the horizontal `.footerActions` only and `.me-footer` uses the direction-agnostic `flex: 0 0 auto`, guarded by a new SSR assertion. Also: bilingual READMEs gained a "Community & Support" section (group QR + WeChat pay/reward codes), plus `SPONSOR.md` and `.github/FUNDING.yml` |
| **v0.9.8** | 2026-09-28 | **Backlog burn-down release.** ① **Capture reliability** (issues #3 / #4): distillation no longer hardcodes `providers[0]` — new `captureProvider` / `captureModel` config plus ordered fallback across providers; adapter errors carried by the stream's terminal `finish` block (missing credential, rate limit, …) are now **visible failures** (code/message in the capture log, red health state, raw-card fallback annotated with the cause) instead of a vague "distillation produced nothing"; the stall detector moved from cumulative-counter deltas to a **sliding window** (alerts only when turns keep starting with zero finishes inside 20 min), fixing both false alarms and misses. ② **Independent-process vault consistency** (dsh-memory-eternal#5): CLI / MCP / hooks / standalone web / sweep now share the host's resolution order (`MEMORY_VAULT_DIR` → `activeVault` → `vaultDir` → default), so switching vaults no longer splits your memory in two. ③ **Watchdog singleton lock** (dsh-memory-eternal#6): a new process exits when a live watchdog already owns the port, and stale pid records are cleaned, ending the orphan pile-up on every restart. ④ **Graph performance**: tag edges became "Top-K by shared tags" (measured **24,193 → 2,763** edges at 593 cards), similarity switched to a **rare-bigram inverted index** (cold **948 → ~520ms**, warm 2-4ms), payload **3,531KB → 579KB**, and the client dim pass now uses an **adjacency set** (**52ms → <1ms** per frame). ⑤ Five new test files (routing/finish, stall window, vault resolution, watchdog lock, graph perf baseline); `npm test` now covers **85 checks** |
| **v0.9.7** | 2026-09-28 | **Cards open fully expanded (and can be collapsed) + new body typography**: the reader no longer folds to 300px by default — it **opens showing the whole card**, with a one-click collapse for long ones (and an "Expand ⌄" hint when folded). Frontmatter is lifted out of the body into **colored chips** (kind / audit status / tags / dates / source; kind reuses the graph palette) instead of leaking raw YAML. Body rendering is rewritten (`src/client/markdown.js`, shared by the host and the standalone web page): headings get an **emoji + color group by meaning** (conclusion ✅green / risk ⚠️amber / root cause 🔍blue / plan 🛠️purple / example 💡pink), consecutive `- ` lines become a real `<ul>`, `1.` becomes an `<ol>` with numbered circles, `- [x]` becomes a checkbox, `>` becomes an emoji callout, `---` becomes a divider, short `key: value` lines get an aligned style, and `**bold**` gets a highlighter underline; fenced code is protected so `#` / `-` inside it are no longer re-typeset. **Adds 7 typography unit tests** (XSS escaping, link-protocol allowlist, prose colons must not be misread as key/value). Also carries the PR #8 port: Electron-host subprocess node resolution (`lib/node-bin.js`, fixing "standalone web server never starts → sidebar popup white screen") and API routes registered after `webServer` is ready (fixing "settings page stuck loading") |
| **v0.9.6** | 2026-09-28 | **Fixed the full-screen overlay covering the desktop shell's window controls (clicking Close quit the whole shell)**: the desktop shell draws minimize / maximize / close at the top of the page and, per the DSH convention, marks `<html>` with `data-windows-titlebar` and publishes `--dsh-windows-titlebar-height` (both confirmed present inside the official desktop build's `app.asar`); the memory overlay used `inset:0` plus an inline `100vh`, covering that whole strip, and our own top-right "×" landed exactly on the shell's window Close — one click quit the entire desktop shell. The full-screen state now uses the `.me-modal-full` class (no inline `100vh`, which CSS cannot override), and under `[data-windows-titlebar]` the `.me-overlay-top` / `.me-overlay` / `.me-modal-full` surfaces are pushed down by `--dsh-windows-titlebar-height` with height `calc(100vh - that)`. Browsers without the attribute get a 0px offset, so behaviour is unchanged there. The export-graph full-screen preview also moved from `100vh` to `100%` so it cannot overflow the shortened overlay. Adds 1 render regression asserting all three avoidance rules ship in the bundle |
| **v0.9.5** | 2026-09-28 | **Fixed the plugin failing to mount under the official desktop build (schemastery 3.18.4)**: the desktop profile resolves **schemastery 3.18.4**, which turns every `volatile` Config field into a cosmokit **live reference** (`{ get(): snapshot }` branded with `Symbol.for('cosmokit.volatile.write')`), while 0.9.4 treated those fields as plain values — `cfg.vaultDir.trim()` threw `TypeError: cfg.vaultDir.trim is not a function` and the plugin died inside `apply` (the exact desktop error). The plugin now **deep-unwraps** references per the cosmokit protocol (snapshot each reference, recurse through arrays/objects), so `settings.get()` only ever exposes plain values; each read unwraps afresh, so in-place volatile hot updates stay immediately visible, and `JSON.stringify` no longer writes `{}` into the shared config file. Adds 2 regressions (the real 3.18.4 reference shape + nested arrays/objects) and verifies `apply` under the **desktop build's real module-resolution layout** (schemastery 3.18.4 + real cosmokit) |
| **v0.9.4** | 2026-09-28 | **DSH v0.1.7-rc.2 support (fixes "the plugin goes dark after the upgrade")**: (1) **The settings service was replaced** — in 0.1.7 `ctx.settings` is a forms-only API (`describe/update/replace/mutate/configure`) with no `register()`; the old `ctx.settings.register(...)` call throws a `TypeError`, so the plugin never mounts (memory page gone, auto-capture dead). A cross-version shim keeps `register` for older hosts while new hosts read the **live config reference** the loader passes in, subscribe to `loader/volatile-update` for hot updates, and write back through `settings.update(entry id, patch, revision)` (revision conflicts map to HTTP 409); it also registers `configure({ auto:false })` so the host does not generate a duplicate form page. (2) **Volatile field marking moved after construction**: no more chained `.volatile()` — that method only exists in schemastery ≥3.18.4, while the plugin actually resolves **3.18.1** at the profile level, so the chain threw `volatile is not a function` at import time and killed the plugin. (3) **Dead client references removed**: `inject` no longer lists `settingsScope`, which disappeared together with `@deepseek-ai/dsh-client-runtime` (0.1.7 has no such service, so the client plugin waited forever and never activated — taking the memory page and the sidebar button with it); `dsh.client.inject` dropped its non-existent package names. (4) New **`tests/settings-compat.test.mjs`** (8 cases: 0.1.7-shaped mount / live-reference reads / volatile hot update / write-back and revision conflict / legacy `register` path / field volatile markers) wired into `npm test`. Verified by booting a **real DSH v0.1.7-rc.2**: the host plugin mounts (config written to `memory-eternal-config.json`) and the client bundle composes into the boot graph (`plugins/??memory-eternal/client.js`) |
| **v0.9.3** | 2026-09-12 | **Fixed the blank memory page ("no UI")**: v0.9.1 placed the infinite-scroll `useEffect` **before** the `loadCards` definition — React evaluates the dependency array during render, hitting a TDZ error (`Cannot access 'loadCards' before initialization`) that **crashed the whole memory page on first render**. It now comes after the definition. Added a **render smoke test** (`tests/ssr.test.mjs`: renders the built bundle through all four entry points — cards / settings / usage / graph — wired into `npm test`) so "green build, blank page" bugs cannot ship again |
| **v0.9.2** | 2026-09-12 | **Log visibility + false-alarm fix**: the capture log is now **persisted to disk** (`~/.dsh/memory-eternal-capture.jsonl`, last 500 entries) — the standalone web page no longer says "log only available inside the DSH host" but shows the records, and history survives a host restart (read back on boot); fixed **stall-detector false alarms flooding the panel** (mismatched turn counters are normal: sub-agent turns and cancelled turns emit no `turn-stopping`; it now requires "turns running **and** no capture activity for 15 minutes" to alert once, and the alarm clears as soon as activity resumes — no more one `fail` line every 10 minutes permanently turning health red); when distillation returns nothing / unparseable JSON the content is **saved as a raw card instead of being dropped** |
| **v0.9.1** | 2026-09-12 | **Performance & UX batch**: memory page loads lazily per view (opening Settings no longer drags in 250KB of cards + 890KB of graph; first paint needs ~0.5KB); graph generation **3232ms → 43ms** (bigram sets computed once + lossless mathematical-bound pruning + tag inverted index) plus a server-side cache with **fingerprint invalidation** (write/audit/delete rebuilds immediately, no stale reads); site-wide **brotli q5** (graph 877KB → **54KB**, 34% smaller than gzip; cards 246KB → 83KB → 20KB with br) and large responses compressed with both br and gzip keeping the smaller, so no response is ever worse than gzip; `/cards` gained **real pagination** (offset/limit/total + server-side title sort, globally ordered across pages) loading 100 cards first and fetching more on scroll; the "Agent cards" panel in Usage/Today filters by agent server-side (30 rows); **audit red line**: the plugin injects "never call approve/reject on the user's behalf" into the agent context; the watchdog now **reaps redundant instances on fallback ports** (a duplicate web process holding 76MB was reaped in testing) |
| **v0.9.0** | 2026-09-12 | **Fixed silent auto-capture death (6 days without a single card)**: after a DSH upgrade the session event API moved from `events` to `ownEvents()/snapshotEvents()`; the listener read nothing, returned silently and left no trace — now it tries `ownEvents()` → `snapshotEvents()` → `events` and logs a per-session attach entry. Daily quota now counts **real writes only** (previously every "not worth saving" verdict burned quota, exhausting the 24h budget after 40 attempts); `captureCooldownMs` actually applies; a single capture input is tail-capped at 20k chars. New **capture log** panel and **active failure alerts** (red strip + agent-context injection + turn-stopping stall sweep). Removed the automatic "Daily review" digest (timer / `/todayBrief` route / UI button). |
| **v0.8.0** | 2026-09-06 | **Full UI i18n**: follows the DSH system language live (zh/en) across cards, graph, audit center, config panel and new-card templates; SQLite EBUSY fix for the Windows test suite |
| **v0.3.1** | 2026-09-03 | Knowledge graph loads on demand (fetch on open, unregister on close) |
| **v0.3.0** | 2026-09-03 | **SQLite storage layer** (`node:sqlite`, zero deps) + DB-level audit guard `enforceAudit()` + `audit_log` table + automatic `.md` migration |

</details>
| v0.2.0 | 2026-09-03 | Recall with body text (`search()` returns the `excerpt` field) |
| v0.1.2 | 2026-09-03 | Audit guard hardening (`writeCard` defaults to `pending`, `mergeCards` goes through audit) |
| v0.1.1 | 2026-09-03 | Recall body fix (`excerpt` field + body logic) |
| v0.1.0 | 2026-08-31 | First release: auto capture + auto recall + graphical knowledge base + knowledge graph + audit center + recycle bin |

</details>

---

## 💬 Community & Support

**Questions, feature requests, or just want to talk about DSH plugin development — join the group chat:**

<img src="https://raw.githubusercontent.com/EternalNight996/memory-eternal/main/assets/support/group-qr.jpg" width="260" alt="DeepSeek Harness community group QR code" />

**If this plugin saved you some time, you can buy the author a coffee (either code works):**

| WeChat Pay | WeChat Reward |
|---|---|
| <img src="https://raw.githubusercontent.com/EternalNight996/memory-eternal/main/assets/support/wechat-pay.jpg" width="230" alt="WeChat Pay QR code" /> | <img src="https://raw.githubusercontent.com/EternalNight996/memory-eternal/main/assets/support/wechat-reward.jpg" width="230" alt="WeChat reward QR code" /> |

> Donations are entirely optional and change nothing about the plugin; it stays open source and free (MIT).
> Picking the first custom entry in the repo's **Sponsor** dropdown lands on [SPONSOR.md](SPONSOR.md), which shows the same codes.

---

## 📄 License

MIT

---

> **Make your AI truly remember: dialogue auto-captured, knowledge at your fingertips.** ⭐ Star it if you like, Let's make AI not forget.
>
> 中文 README: [README.md](README.md)
