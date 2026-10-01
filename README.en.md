# 🧠 memory-eternal — A "second brain" for your AI

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

**Edit config**: Vault left rail "Memory Config" (or DSH Settings → Memory) → DSH memory config / cost control / auto-audit config / self-hosting — just hit "Save Config". `autoWebMode` / `watchdogAutoSpawn` changes require a DSH restart.

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
```

When not running on DSH, the `dsh-memory` command comes from `npm i -g`.

---

## ⚙️ Self-hosting (plain words)

Three concepts, don't mix them:

- **How the web server stays alive** (`autoWebMode`) → `init`=pull once at DSH start (default); `interval`=DSH in-process timer probes & auto-restarts (0 extra memory); `manual`=fully manual, only from `dsh-memory open`.
- **Watchdog process** (`watchdogAutoSpawn`, default on) → a **standalone** node process that can pull web up even after DSH exits (~+47 MB RAM). Only turn on for 7×24 keep-alive.
- **Auto-mount MCP** (`autoMcpSetup`, default off) → whether to auto-write MCP into Claude Code/Codex/Cursor config. Off = don't touch your machine config; run `dsh-memory setup` manually when needed.

**Change these**: Vault left rail "Memory Config" (or DSH Settings → Memory) → edit the table and save; `autoWebMode` / `watchdogAutoSpawn` need a DSH restart.

**MCP is a protocol, not a resident service**: the agent spawns it per session and exits when done — no "auto-start on boot" concept.

### Three deployment intensities

| Scenario | Config | Memory |
|---|---|---|
| Personal dev (default) | `autoWebMode=init` + `watchdogAutoSpawn=off` | web 47 MB |
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
| Watchdog `watchdogAutoSpawn` | on | a **standalone process** keeps web alive (+47 MB). Personal use can turn off |
| Auto-mount MCP `autoMcpSetup` | off | **lets Claude Code / Codex / Cursor use your memory**. On = auto-configures them; Off = never touches your config, run `dsh-memory setup` manually |

> 💰 **To save money**: turn `Distill cards` off, lower `Distill output cap`, raise `Recall min score`.

### 🎯 One-click presets

Top of the config page: **🟢 A Light / 💰 B Budget / ⭐ C Premium** — click to fill, then Save:

| Plan | Scenario | Keep-alive | Watchdog | Distill | Distill cap | Recall min | Memory | LLM cost |
|---|---|---|---|---|---|---|---|---|
| 🟢 **A Light** | Personal dev (default) | init | off | on | 900 | 2 | ~47 MB | normal |
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

---

## 📋 Changelog

> **Withdrawn versions**: **v0.9.16 – v0.9.22 are all withdrawn** (problem-period releases: git tags deleted, npm entries deprecated — use **v0.9.23**). **v0.9.14 is deprecated** (its client-rendering changes hurt the feel and were reverted; its server-side algorithm work shipped in **v0.9.15**, whose rendering is identical to v0.9.13). **v0.9.0 – v0.9.5 are all deprecated on npm, and the release tags for v0.9.1 / v0.9.2 / v0.9.3 / v0.9.4 have been removed from git** (v0.9.5 is merely superseded, so its tag stays) — v0.9.1/v0.9.2 ship the blank-memory-page defect, v0.9.0 false-alarms its capture warnings, v0.9.3 does not support DSH v0.1.7-rc.2 (the plugin stops mounting entirely: the settings service changed and the client-side `settingsScope` is gone), v0.9.4 crashes under the official desktop build (schemastery 3.18.4 volatile live references) with `cfg.vaultDir.trim is not a function`, and **v0.9.5's full-screen overlay covers the desktop shell's window controls (its top-right "×" sits on the window Close button — one click quits the whole shell)**. Use **v0.9.6+** (`npm i memory-eternal@latest`).
> **DSH compatibility**: `>=0.1.5-alpha.2 <0.3.0-0` (**widened in v0.10.1**: the old `<0.2.0` upper bound excludes DSH `0.2.0-rc.x` under plain semver — DSH's plugin guard uses `includePrerelease: true`, so installs still worked, but the declaration did not match reality. The range now covers the whole 0.1/0.2 line, and `<0.3.0-0` still blocks 0.3.0 and its prereleases. **Verified running on the official desktop build DSH 0.2.0-rc.2**: mounting, memory page, auto-capture, review centre and import/export all work). **v0.9.4 adds support for DSH v0.1.7-rc.2**, which replaced the settings service with a forms-only API and removed `@deepseek-ai/dsh-client-runtime` / `settingsScope`; **v0.9.5 adds support for schemastery ≥3.18.4 volatile live references** (the shape the official desktop profile uses, while the web profile still ships 3.18.1 — both work); **v0.9.6 keeps full-screen overlays clear of the desktop shell's window controls**. The 0.1.5 line still uses the legacy `settings.register` path; both paths are kept.

| Version | Date | Highlights |
|---|---|---|
| **v0.10.1** | 2026-10-02 | **Fixes "export works, import brings in 0 cards".** Root cause: "Export JSON" wrote a **bare array**, while `/import` only read `payload.cards` — a bare array was silently treated as an empty backup (`ok:true` / `imported:0` / `skipped:0`), so the UI only ever said "Import complete: 0". ① `/import` now accepts both a **bare array** (backups from v0.10.0 and earlier) and an **envelope object** `{format, formatVersion, exportedAt, count, cards}`; an unrecognized shape returns **400 with a readable reason**, an empty file returns a `warning`. ② Export now writes the envelope (older builds only read `payload.cards`, so the envelope stays compatible with them) and keeps each card's `status` / `store`. ③ The import dedup baseline is now a **pre-import snapshot** (new `dedupAgainst` option on `writeCard`) — otherwise near-identical cards inside one backup dedup against each other and swallow part of the batch (a backup is the source of truth). ④ The import response adds `total` / `skipped` / `quarantined` / `failed[]` (with a per-card reason), and the toast reads "Import complete: N / of M · pending review K · skipped D"; a run that imports nothing is shown as a failure. ⑤ New `tests/import-roundtrip.test.mjs` (6 checks). ⑥ **A broken install now speaks plainly (issue #14)**: a copy installed from the plugin marketplace can be missing its `web/` assets, and the sidebar then showed a raw `{"ok":false,"error":"ENOENT …"}` page. Now a missing `index.html` with `app.js` still present is covered by a **built-in shell** that boots the UI anyway (self-healing), while a missing `app.js` returns a JS snippet that paints the diagnosis into `#root` plus a page stating which file is gone, its absolute path, the package version and how to reinstall. Both cases land in the auto-capture log (`app.js` → `fail`, health turns red; `index.html` only → `warn`), and the host self-checks the same way at startup (shared predicates and wording in the new `lib/web-assets.js`, with 6 checks in `tests/web-assets.test.mjs`). ⑦ `appendCaptureLog` no longer fails silently when the `DSH_HOME` directory does not exist. ⑧ **DSH compatibility widened to `>=0.1.5-alpha.2 <0.3.0-0`**: the old `<0.2.0` upper bound excludes DSH `0.2.0-rc.x` under plain semver (DSH's guard uses `includePrerelease:true`, so installs still worked, but the declaration did not match reality) — the range now covers the whole 0.1/0.2 line while `<0.3.0-0` still blocks 0.3.0 and its prereleases; `dsh.compatibility` gains `"0.2.0-rc.2": "compatible"` (verified on the official desktop build 0.2.0-rc.2). Measured on a real **661-card bare-array backup (3.9 MB): 0 cards before the fix → 661 after** (654 into the main store + 7 into quarantine). `npm test` now runs **184 checks** |
| **v0.9.23** | 2026-09-30 | **No more save flicker.** After a successful save the client immediately re-fetches `/config`, but the host volatile echo lags, so inputs visibly reverted to the old values and then jumped back. The client now keeps a **local overlay** for fields that were saved but not yet echoed (`src/client/config-merge.js`, pure function + 4 checks), dropping each key once the host echoes it, and following the host value afterwards; resetting the form clears the overlay. `npm test` now runs **139 checks** |

<details>
<summary>📜 Previous releases (click to expand)</summary>

| Version | Date | Highlights |
|---|---|---|
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
