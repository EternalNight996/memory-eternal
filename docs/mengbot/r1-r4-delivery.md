# R1–R4 已全部实现（v0.45.0）

> 回应 `autokill-purge/docs/memory-eternal-requirements.md`
> 验收脚本：`acceptance-r1r4.mjs`（12 项，全绿）。实现落在 `lib/api.js` + `lib/db.js`。

---

## 一句话

**四个接口都上了，按你的清单逐条对得上。** 只改了你允许的那两处（加列、加索引），
`recall` 的排序、审批模型、现有 7566 张卡的正文与 status 一个字节没动。

---

## R2｜稳定主键 + 索引 ✅

`lib/db.js` 新增 `migrateAddCardKey(db)`，挂在 `getDb` 上，**幂等**（每次启动跑，已存在就跳过）：

```sql
ALTER TABLE cards      ADD COLUMN card_key TEXT;   -- 已有则跳过
ALTER TABLE quarantine ADD COLUMN card_key TEXT;
CREATE UNIQUE INDEX idx_cards_key      ON cards(card_key)      WHERE card_key IS NOT NULL;
CREATE UNIQUE INDEX idx_quarantine_key ON quarantine(card_key) WHERE card_key IS NOT NULL;
CREATE INDEX idx_cards_source      ON cards(source);
CREATE INDEX idx_quarantine_source ON quarantine(source);
```

**`schema_version` 写进已有的 `config` 表**（复用，不另建第二处版本号）：

```sql
INSERT INTO config(key, value) VALUES('schema_version', '2')
  ON CONFLICT(key) DO UPDATE SET value = '2', updated_at = datetime('now');
```

唯一索引是 **partial**（`WHERE card_key IS NOT NULL`）—— NULL 不参与唯一约束，
所以老卡可以全部留 NULL 而不冲突。

### 回填策略：老卡留 NULL（有意为之）

你得知道这个限制：**DB 里的 `body` 不含 frontmatter**（落库时已拆成 title/tags/body 各自一列）。
实测 7566 张卡里只有 2 张 body 以 `---` 开头，也就是说**老卡没有 key 可抽**。

所以：
- **新卡**（`/api/upsert` 写入的）都有 `card_key`；
- **老卡** 一律 `NULL`，按文档「回填失败的不阻塞启动」处理；
- **没有用「按 id 兜底当 key」** —— 那会把内部自增 id 暴露成外部契约，一旦重建库全错位。

如果你需要老卡的 key，得从 **markdown 文件**的 frontmatter 里读，那是一次 7500 文件的扫描，
可以单独做一次迁移脚本 —— 说一声我加。

---

## R1｜存在性查询 ✅

```
POST /api/lookup
{ "keys": ["purge.gear.plan_unpack", ...],
  "filter": { "source": "autokill-purge", "kind": "tool", "prefix": "purge." } }
```

返回：

```json
{ "ok": true,
  "results": [
    { "key": "purge.gear.plan_unpack", "state": "approved",
      "path": "03-Knowledge/…md", "kind": "tool", "source": "autokill-purge",
      "content_hash": "43a1d88ad02b7909", "updated_at": "2026-11-14T12:56:18.329Z" },
    { "key": "purge.flow.gear-install", "state": "missing" }
  ],
  "count": 2, "schema_version": 2 }
```

**四态**：`approved` / `pending` / `rejected` / `missing`

**几个实现细节，你可能会踩到**：

| 你的规则 | 我的处理 |
|---|---|
| `pending` 必须能查到 | ✅ 查 `cards` **和** `quarantine` 两张表 |
| 顺序与请求一致 | ✅ 按请求数组映射，重复 key 各自独立返回 |
| 200 keys ≤100ms | ✅ **实测 5ms**（索引命中，非全表扫描） |
| filter 收窄 | ✅ 命中但不满足 `source`/`kind`/`prefix` → 返回 `missing` |
| `deleted`/`archived` 怎么办 | 对外一律 `missing`（可重新提交） |
| quarantine 里的条目算什么 | 对外统一 `pending`（它在等人工处理） |

**上限**：>200 个 key 返回 **413**，非法 key（不合你的正则）返回 **400**。

---

## R3｜写入回执 + 幂等 ✅

```
POST /api/upsert
{ "card": { "key": "purge.gear.plan_unpack", "kind": "tool",
            "title": "…", "body": "…", "source": "autokill-purge" } }
```

返回：

```json
{ "ok": true, "action": "created|updated", "key": "purge.test.one",
  "id": 7551, "state": "pending", "path": "07-Tools/测试卡.md",
  "content_hash": "43a1d88ad02b7909", "schema_version": 2 }
```

- **提交即可查**：`upsert` 返回后立刻 `lookup` → `pending` ✅（验收第 3 项）
- **幂等**：同 key 二次提交 → `action:"updated"`，不新建卡 ✅（验收第 4 项）
- **永远进 pending**：你们产出的内容未经人工确认，不自动进主库 —— 这是产品决定，不是限制

**实现要点**（避免「更新了但搜不到」）：更新时先把旧行的 `card_key` 置 NULL →
`deleteCard` 软删旧卡 → 重走一遍 `writeCard`（`dedup:false`）→ 再打上新 key。
这样搜索索引、向量同步、去重台账都走同一套副作用。

---

## R4｜健康与版本单一来源 ✅

```
GET /api/health
```

```json
{ "ok": true, "vault": "C:/…/memory-vault",
  "db": "C:/…/memory-vault/memory-eternal.db", "db_bytes": 126000000,
  "version": "0.45.0", "alive": true, "writable": true,
  "cards": 7550, "pending": 3, "quarantined": 0, "schema_version": 2 }
```

- **只有一个 `version`**（不再出现 0.15.0 / 0.40.1 / 0.45.0 三个值）
- `alive` 以「此刻能不能服务请求」为准 —— 你拿到 200 就说明活着
- `writable: false` 时读接口仍可用，只有写会 503
- 额外给了 `quarantined`（隔离区条数），你可以据此判断「提交了但被判垃圾」

---

## 验收结果（跑了一遍你的清单）

```
✔ 1 lookup 未登记 → missing
✔ 2 upsert → created + pending
✔ 3 立即 lookup → pending            path=07-Tools/测试卡.md
✔ 4 重复 upsert → updated
✔ 5 200 keys ≤100ms                  5ms
✔ 5b 顺序与请求一致
✔ 6 health 只有一个 version          v=0.45.0 alive=true writable=true
✔ 6b schema_version=2
✔ 7 重启后仍可查                     pending
✔ 8 filter 不匹配 → missing
✔ 9 非法 key 被拒(400)
✔ 10 >200 keys 被拒(413)

=== 12 通过 / 0 失败 ===
```

---

## 你那边可以改完了

```text
启动 → GET  /api/health                          （库在不在、版本、可写否）
     → POST /api/lookup {keys:[…], filter:{source:"autokill-purge"}}
     → 列表渲染四态：已入库 / 待审核 / 被驳回 / 缺失
缺失 → POST /api/upsert {card:{key:"purge.…", kind, title, body, source}}
     → 立即重查一次，确认 state=pending
```

接口就绪后，把你临时用的 `recall` + 内容匹配 key 那条分支删掉即可，不留双路径。

---

## 两个已知差异（先说清楚，免得你踩）

1. **`/api/upsert` 是 HTTP；CLI 的 `dsh-memory capture --key K` 还没接**。
   如果你更想走 CLI，告我一声，我在 `bin/dsh-memory.mjs` 加 `--key`。
2. **`capture` 没有 HTTP 路由**（沉淀是插件内部调用 `appendCaptureLog`）。
   外部写入统一走 `/api/upsert`，语义就是「登记一张待审卡」。
