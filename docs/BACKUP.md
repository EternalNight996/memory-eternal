# 备份与容灾（BACKUP）

记忆核心的唯一真源是 `$MEMORY_VAULT_DIR/memory-eternal.db`（默认 `~/.dsh/memory-vault/memory-eternal.db`），
`*.md` 只是镜像。库坏了 = 记忆全丢，所以备份这条链要能**自己证明可用**，而不是「文件在那儿」。

本文记录：现有机制、本次巡检结论、`scripts/backup-drill.mjs` 的用法、计划任务、恢复 SOP。

---

## 1. 备份机制（改造后）

| 层 | 位置 | 频率 | 谁触发 | 内容 |
|---|---|---|---|---|
| 插件内置 | `<vault>/backups/memory-eternal-YYYY-MM-DD_HHMM.db` | 按 `backupIntervalHours`（默认 24h；每 10 分钟检查「到点没有」，启动后 90s 补跑一次） | DSH 进程内 `index.js` 的 `runBackupTick` | `VACUUM INTO` 紧凑副本，**备份后自校验**，同一天只留最新一份，保留 `backupKeepDays`（默认 30 天） |
| 巡检脚本 | 同上（无则补一份） | 每小时兜底（今天没备成功就补） | Windows 计划任务 `DSH-MemoryEternal-Backup` | 在线热备（`node:sqlite` backup API）+ 完整性校验 |
| 第二副本 | `F:\Backups\memory-eternal\{daily,weekly,monthly}` | 每次巡检/备份后 | 同上 | 每天一份 + 每周/每月归档（同盘硬链接，不重复占空间） |
| 还原演练 | 临时目录 | 每天 03:20（计划任务 `DSH-MemoryEternal-Drill`） | 同上 | 把最新备份复制成独立库，真跑 `integrity_check` + 写探针 + FTS + 向量 |

`F:\Backups\memory-eternal\manifest.json` 记录每次运行：源库/备份的文件大小、sha256、卡片数、校验结论、镜像路径、演练结果、失败原因（保留最近 200 次）。
日志在 `F:\Backups\memory-eternal\logs\backup-YYYY-MM.log`。

保留策略（可用参数改）：`--keep-daily 14 --keep-weekly 8 --keep-monthly 6`。
`<vault>/backups` 的保留口径与镜像一致：`backupKeepDays`（默认 30 天）+ 可选 `maxKeep` 份数上限（**默认 0 = 不限**）。
为什么 `maxKeep` 默认改成不限：同日去重已经保证「一天最多一份」，再压一个 7 份硬上限等于把 30 天保留期变成摆设（永远只剩 7 天）。

## 2. 为什么要有巡检脚本

内置定时器有三个致命前提，任何一个不成立就没有备份：

1. **DSH 进程必须活着**，且周期性 timer 得跑到（DSH 关着 = 这台机器只会靠计划任务那条路补）；
2. 失败只写一行 `console.error`，**没有告警**（改造前还会把 `lastBackupDate` 提前置位，失败一次就放弃一整天）；
3. 备份只落在 `<vault>/backups`，与主库**同一块盘同一目录**——磁盘坏、误删、锁灵索契都是「主库和全部备份一起没」。

`scripts/backup-drill.mjs` 补的就是这三块，且**零依赖、不依赖 DSH**（只用 Node 内置 `node:sqlite`）。

## 2.5 开关与配置（面板 / 配置文件都可改）

| 配置键 | 默认 | 说明 |
|---|---|---|
| `backupEnabled` | **true** | 自动备份总开关（关掉后宿主定时器与巡检脚本都不再自动备，手动「立即备份」仍可用） |
| `backupIntervalHours` | 24 | 定期备份周期（小时）；配合下面的时间窗使用 |
| `backupWindowStart` | **3** | **备份时间窗**：只在每天 `03:00–03:59` 之间备一次（可配 0–23）。窗口外即使已过周期也不动手 |
| `backupKeepDays` | **30** | 备份保留天数；**每次备份完立即清理过期**（按文件名日期算，当天算第 1 天） |
| `backupAutoRestore` | **true** | 库被判定为**结构性损坏**时，自动用「最新一份当场可打开且 quick_check 通过」的备份重建 |

### 为什么要有「时间窗」而不是「距上次 24h 就备」

按间隔备会在**白天任意时刻**触发：用户正在写卡时 backup 会读整库（`VACUUM INTO`），
磁盘和 CPU 突然被占一下，体感就是「面板卡一下」。凌晨三点库是静的，备份快、也不和交互抢 IO。
所以规则是：**距离上次满周期 + 落在 03:00–03:59 窗口内**，两个条件都满足才备。

- 从没备份过的新装用户：任意时刻都会补第一份（`never-backed-up-catchup`），不会等到明天凌晨；
- 窗口外到期的：`outside-window` 跳过，等第二天窗口；
- 一天最多一份：同日去重 + `not-due` 双重保证。

计划任务（见第 4 节）也放在窗口内：**03:05 备份**、**03:35 演练**；
演练用 `--ensure-today --drill`，当天已有备份时**复用那份做还原验证**，不会在窗口里再备第二份。

- 面板位置：「设置 → 记忆 → 🧯 容灾备份」分区（两个开关 + 周期 / 保留天数 + 上次备份 / 份数 / 下次时间 + 立即备份）。
  **运行状态页只显示，不改配置**——那里只有「刷新」与「立即备份」这类只读操作。
- 接口：`GET /memory-eternal/api/backup/status`、`POST /memory-eternal/api/backup/config`、`POST /memory-eternal/api/backup`。
- 自动还原**只认结构性损坏**（`malformed / not a database / corrupt / disk image`）。`database is locked`、权限不足、只读盘这类**临时/环境**问题一律不碰——那时自动还原只会把好数据换掉。
- 还原前现场一律改名 `*.corrupt-<时间戳>` 留证（**不删任何文件**），还原后写一条 `audit_log`（`new_status=db-restored`）。
- 接线三处：DSH 插件启动、常驻 web 启动、看门狗 tick（60 秒冷却 + 仅在探测到异常时才读盘）。

## 3. 用法

```bash
# 今天没备过就备一份（计划任务调的就是这条）
node scripts/backup-drill.mjs --ensure-today

# 无条件备份一次（覆盖同一天的旧份）
node scripts/backup-drill.mjs --force

# 备份 + 还原演练（把最新备份真的还原出来验证）
node scripts/backup-drill.mjs --drill

# 只校验：不新建任何东西，把现有备份全部过一遍完整性
node scripts/backup-drill.mjs --verify-only

# 换保留策略 / 换镜像盘
node scripts/backup-drill.mjs --drill --keep-daily 30 --keep-weekly 12 --mirror D:\Backups\memory-eternal
```

npm 快捷方式：`npm run backup` / `npm run backup:drill` / `npm run backup:verify`。
退出码 0 = 成功或按策略跳过；1 = 任何一步失败（计划任务可见 `LastTaskResult`）。

## 4. 计划任务

```powershell
# 已注册（当前用户、随系统启动、错过就补跑）
Get-ScheduledTask -TaskName 'DSH-MemoryEternal-*'
#   DSH-MemoryEternal-Backup  每小时 → --ensure-today（含镜像与保留裁剪）
#   DSH-MemoryEternal-Drill   每天 03:20 → --drill（备份 + 还原演练）

# 立刻跑一次并看结果
Start-ScheduledTask -TaskName 'DSH-MemoryEternal-Drill'
Get-ScheduledTaskInfo -TaskName 'DSH-MemoryEternal-Drill' | Select LastRunTime,LastTaskResult
```

计划任务用的是 `C:\Program Files\nodejs\node.exe` 的绝对路径；换 Node 版本时改 `Actions.Arguments`。

## 5. 恢复 SOP

**先确认库真的坏了**：`node bin/dsh-memory.mjs status`，或看面板「健康」里的数据库项。
SQLite 的 `database is locked` / `readonly database` 是锁与权限问题，**不是**数据损坏，别急着重演。

```bash
# A. 用 CLI 恢复（推荐，会先把现场改名留证，绝不删除）
node bin/dsh-memory.mjs doctor --restore latest                       # 不带 --yes 只演练，不改任何文件
node bin/dsh-memory.mjs doctor --restore latest --yes                 # 库已坏时直接恢复
#   库明明可写时会被拒绝（防手滑），确认要覆盖再加 --force
node bin/dsh-memory.mjs doctor --restore memory-eternal-2026-11-13_1021.db --yes   # 指定某一份

# B. 从第二副本恢复（vault 目录整个丢了的情况）
copy F:\Backups\memory-eternal\daily\memory-eternal-2026-11-13.db  C:\Users\Administrator\.dsh\memory-vault\memory-eternal.db

# C. 恢复后必做
node bin/dsh-memory.mjs status          # 端口在服务、版本对
node scripts/backup-drill.mjs --verify-only
```

恢复后 `<vault>/memory-eternal.db.corrupt-<时间戳>`（连同 `-wal`/`-shm`）是**现场留证**，核对完再人工删。

## 6. 巡检结论（2026-11-13 实测）

| 检查项 | 结论 |
|---|---|
| 主库 `PRAGMA integrity_check` / `quick_check` | ok / ok，3056 张卡，journal=wal |
| 改造前的 7 份历史备份 | 7/7 `integrity_check` = ok、`quick_check` = ok，卡片数单调递增（2384→2450→2748→2823→2880→2880→3043），无回退 |
| 备份 vs 主库差集 | 备份缺 13 张（当天新增），备份里没有主库已删的卡（差集干净） |
| 还原演练 | 最新备份复制成独立库后可打开、**可写**、FTS 命中 528、向量 2980 行全非零、空正文 0 张 → 通过 |
| 恢复代码路径 | `tests/db-restore.test.mjs` 4/4 通过 |
| **发现的问题（已修）** | ① 备份在同盘单点，无第二副本 ② 保留窗口 7 份但 11-12 重复备份两份 → 实际只覆盖 6 天 ③ 备份后不校验，坏备份会挤掉好备份 ④ 失败后 `lastBackupDate` 已置位，当天不再重试 ⑤ `VACUUM INTO` 撞同名文件直接失败（同分钟二次备份必炸） |

### 6.1 端到端灾难演练（可复现，`tests/disaster-recovery.test.mjs`）

不是「跑一遍单元测试」，而是把灾难现场造出来走完整链路：

```bash
node tests/disaster-recovery.test.mjs
```

实测结果（2026-11-13）：

| 步骤 | 期望 | 实测 |
|---|---|---|
| 建 4 张卡 → `backupDb` | 备份 ok、cards=4 | ✅ 4 |
| 备份后再写 2 张（RPO 窗口内的数据） | — | 当前 6 张 |
| 把主库文件写成 `NOT A SQLITE FILE` | 当场探测判为损坏 | ✅ `ok=false` |
| CLI 演练（`doctor --restore latest`，不带 `--yes`） | 只读：不改文件、不产生留证 | ✅ 文件字节不变、无 `.corrupt-*` |
| CLI 真还原（`--yes`） | 用备份重建，卡片回到 4 张 | ✅ 4 张、写探针 OK |
| 现场留证 | 坏库 + `-wal`/`-shm` 改名保留 | ✅ 3 个 `.corrupt-<ts>` 文件 |
| 还原后继续写 | 能写、计数 +1 | ✅ 5 张 |
| 隔离 vault 的还原 | 不被无关常驻看门狗阻断 | ✅（原实现按进程存活一刀切，已修：只对同一 vault 的看门狗生效） |

**这条链路的语义边界**：备份是「时点快照」，备份之后写入的数据按 RPO（备份间隔）丢失——这是全量备份的物理事实，不是 bug。要压 RPO 就调小 `backupIntervalHours`。

## 7. 已知边界（还没做，需要额外条件）

- **异地副本只到「同一台机器的另一块盘」**（F:）。整机损坏/被盗时仍会同时失去。要真容灾需要：另一台机器/NAS（`--mirror \\NAS\share\memory-eternal`）或云端对象存储。
- **DSH 宿主进程内的定时器要重启 DSH 才吃到修复**：`lib/db.js` / `index.js` 已改并同步到 `~/.dsh/profiles/{desktop,web}/node_modules/memory-eternal`，常驻 web 实例已重启生效；DSH 桌面端进程里那份仍是进程启动时的旧代码，需要完全退出并重开。
- 备份是**单文件全量**（38 MB 级）。按当前增长（约 1 MB/天）与 14+8+6 保留策略，约占 1–2 GB；硬链接让 weekly/monthly 不额外占空间。
- 没有「备份加密」：库里有你的项目记忆，`F:\Backups` 建议放在 BitLocker 加密盘或限制 ACL。
