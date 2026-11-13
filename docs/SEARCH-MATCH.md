# 搜索命中证据（SEARCH-MATCH）

检索是 **FTS5（词法）+ 向量（语义）混合**的，所以「搜出来但没有字面关键词」是设计内的正常情况：
语义召回会带出内容相关、但一个字都对不上的卡片。问题从来不是召回错了，而是**界面说不出为什么**——
用户搜「火绒」看到 3 条、一条都不高亮，只会以为搜索坏了。

这条链的交付物就是 `_match`：每条命中都带上「在哪命中、命中的词、上下文片段、相关分数」。

## 1. 契约

`GET /memory-eternal/api/cards?q=火绒&status=all` 每张卡多两个字段：

```json
{ "title": "…", "summary": "…", "score": 17.02,
  "_match": { "where": "title" | "tags" | "summary" | "body" | "semantic",
              "term": "火绒", "snippet": "…tid 2096341（火绒剑驱动逆向，6 楼）…", "index": 128 } }
```

- `where`：命中的字段。`semantic` 表示**没有任何字面命中**（纯语义相关）。
- `term`：实际命中的词（可能是查询里更长的那个词，见下面「长词优先」）。
- `snippet`：命中词前后各 46 字的上下文（折叠空白、超长加省略号）；`semantic` 时为空。
- `index`：命中在字段里的字符位置（`semantic` 时为 -1）。
- `score`：融合后的相关分数（BM25 翻正 + 向量排名奖励 + 反馈反哺 ±2 + 可选 rerank）。

实现：[lib/vault.js](lib/vault.js) 的 `evidenceOf()`，在 `search()` 的三个分支（FTS / 向量 / 全表兜底）分别计算。

## 2. 三个必须知道的实现细节（都是踩过的坑）

1. **证据必须用 `row.body`，不能用 `card.body`**：`rowToCard()` 刻意不带正文（列表省内存/流量），
   拿 `card.body` 去算永远算不到正文命中 —— 第一版就是这么把**两条真正的词法命中误标成「语义相关」**的。
2. **正文很长时先截断再找**：`slice(0, 20000)`，避免大卡片拖慢搜索。
3. **长词优先**：候选词按长度倒序尝试，搜「内核驱动参悟」时命中词是整串，不会被「参悟」这种短词抢走；
   探测顺序是 `title → tags → summary → body`（越靠前越能解释「为什么它在结果里」）。

`summary` 本身就是 body 前 200 字的截断，所以关键词落在前 200 字内时会标成 `where=summary` —— 这仍属于正文档命中。

## 3. 界面侧怎么用

| 情况 | 展示 |
|---|---|
| `where != semantic` | 直接渲染 `_match.snippet` 并高亮 `_match.term`；同时标出命中位置（标题/标签/摘要/正文） |
| `where == semantic` | 显示「语义相关」徽标，**不要**给标题/摘要硬造高亮（没有字面命中，硬加 mark 会误导） |
| 两种都没有 | 说明索引还没建好或查询被清洗为空，按空结果表明 |

## 4. 测试

```bash
node tests/search-match.test.mjs   # 5 项：标题/正文档/标签命中、长词优先、semantic 契约形状
node tests/search-index.test.mjs   # 11 项：分词、FTS 构建、BM25 排序
node tests/api.test.mjs            # 14 项：/cards 搜索分支的返回结构
```

实测（真库，搜「火绒」3 条）：

```
where=body    term='火绒'  kernel-driver-re                              …火绒剑驱…（从 API 反推 IOCTL）…
where=body    term='火绒'  52pojie 原文提炼：WinUpack 脱壳实战 + BLE 通信分析    …tid 2096341 火绒剑驱…
where=summary term='火绒'  52pojie 提炼：内核驱动逆向 + IoT 固件挖掘            …tid 2096341（火绒剑驱动…
```

修复前这 3 条里有 2 条被标成 `semantic`（界面于是既不高亮也不给片段），根因就是第 2 节第 1 条。
