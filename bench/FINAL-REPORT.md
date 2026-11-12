# memory-eternal 完整评测报告

> 生成时间：2026-11-12 · 版本 v0.32.0 · 本机 RTX 3060
> 口径：项目自测 + LongMemEval-S 公开数据集（session-retrieval），**非第三方审计，非 QA 分**。

## 1. LongMemEval-S（500 题全量）

数据：`xiaowu0162/longmemeval-cleaned` → `longmemeval_s_cleaned.json`（277MB，hf-mirror 下载），
每题 38–62 个会话，按 `answer_session_ids` 判 gold session 是否进 Top-K，单题独立临时库。

| 方案 | R@5 | R@10 | MRR | 耗时 |
|---|---|---|---|---|
| 纯词法（零依赖） | 95.4% | 98.0% | 0.884 | 3.5 min |
| + bge-m3 语义 | **97.2%** | **98.8%** | **0.916** | 28 min |

按题型（词法 → 语义 R@5）：

| 题型 | n | 词法 | 语义 | 语义 R@10 | 语义 MRR |
|---|---|---|---|---|---|
| single-session-assistant | 56 | 100% | **100%** | 100% | 1.000 |
| knowledge-update | 78 | 98.7% | 98.7% | 100% | 0.983 |
| single-session-user | 70 | 98.6% | **100%** | 100% | 0.939 |
| multi-session | 133 | 96.2% | **97.7%** | 98.5% | 0.938 |
| temporal-reasoning | 133 | 94.0% | **96.2%** | 98.5% | 0.885 |
| single-session-preference | 30 | 70.0% | **83.3%** | 93.3% | 0.571 |

## 2. 自建金标集（109 题，私有库 2943 卡）

| 方案 | R@5 | R@10 | Top1 | 改写 R@5 | 改写 R@10 | 延迟(mean) |
|---|---|---|---|---|---|---|
| 纯词法 | 96.3% | 99.1% | 86.2% | 40% | 40% | 8.7 ms |
| + bge-m3 | **99.1%** | **99.1%** | **89.9%** | **70%** | **90%** | ~110 ms |

分类（语义）：title 100/100、body 100/83.3、**noisy 95/95**、natural 100/79、held-out natural2 100/90。

> 2026-11-12 新增：语义模式下剥离噪声壳（请问/关键点/是怎么处理的/助手…）后再检索。
> 纯词法不剥离（靠壳词反而能捞到原文卡）；实测 noisy Top1 60→**95**、总体 Top1 83.5→**89.9**、R@5 98.2→**99.1**。

## 3. 负结果（同口径实测，已否决）

| 改动 | R@5 | Top1 | 改写 R@5 | 延迟 | 结论 |
|---|---|---|---|---|---|
| 纯 RRF 融合 | 92.7% | 70.6% | — | — | 向量噪声重排坏 |
| 置信门控融合 | 97.2% | 80.7% | 50% | 101 ms | noisy 被放大 |
| 多查询向量 | 98.2% | 82.6% | 50% | 106 ms | 无增益、延迟翻倍 |
| 段落级向量（12,496 块） | 98.2% | 82.6% | 50% | 191 ms | R@5 不涨、延迟 ×3 |
| 语料关联词（3 档） | 94.5–96.3% | 78–85.3% | 50% | 7–10 ms | 字面题被噪声拉低，默认关闭 |
| LLM 重排（0.5B/1.5B Top-20） | 98.2% | 83.5% | 70% | +0.7–0.9 s | 排序无变化，默认关闭 |

## 4. Preference 专项尝试（目标 83.3% → 90%，未达成）

| 方案 | 词法 R@5 | 语义 R@5 | R@10 | 结论 |
|---|---|---|---|---|
| 基线 | 70.0% | 83.3% | 93.3% | — |
| 偏好/推荐摘要卡（tag + 摘要行） | 70.0% | 83.3% | 93.3% | 无提升；全量词法 95.4%（+0.2） |
| HyDE（本地 1.5B 写假设片段再检索） | — | 70.0% | 90.0% | 反而变差，否决 |
| LLM 重排 Top-20（qwen2.5:1.5b） | — | 83.3% | 93.3% | 排序不变，否决 |

原因：剩余 5 题是“情绪/主题漂移”型（例：问“手机续航建议”，gold 会话是“整理充电宝/无线充电板”），
字面与 bge-m3 语义都跨得太远；需要更强模型或 LLM 级别的相关性判断，靠启发式改不动。

## 5. 端到端 QA（未完成，分数不可用）

- 流水线：`scripts/bench-longmemeval-qa.mjs`（检索 Top-5 → answer model → judge）；
- 8 题冒烟：**12.5%**（qwen2.5:1.5b 作答 + 判分）；
- 结论：本地 1.5B 既不会多会话推理，判分也不稳；**不作为分数引用**；
- 官方口径需要固定 answer model（GPT-4o 级）+ GPT-4o judge。

## 5. 评分表（10 维加权，权重：召回22/语义10/隐私14/治理14/成本10/安装8/延迟6/可靠6/维护5/基准5）

| 方案 | 召回 | 语义 | 基准 | 总分 |
|---|---|---|---|---|
| OMEGA | 9.5 | 9.0 | 6.5 | 8.47 |
| memory-eternal 内置 | 7.1 | 6.8 | 8.0 | **8.48** |
| memory-eternal Ollama | 7.9 | 8.4 | 8.0 | 8.37 |

> 基准分从 5.5 提到 8.0 的依据：LongMemEval-S 500 题全量、公开集、可复跑、语义 R@5 97.2%；
> 仍缺 QA 分，所以不再往上给。

## 6. 复跑命令

```bash
# 自建集
node scripts/bench-recall.mjs --vault <快照> --label lexical
node scripts/bench-recall.mjs --vault <快照> --golden bench/paraphrase.json --label para

# LongMemEval-S（需先下载 longmemeval_s_cleaned.json 到 bench/longmemeval/）
node scripts/bench-longmemeval.mjs --data bench/longmemeval/longmemeval_s_cleaned.json --label lme
node scripts/bench-longmemeval.mjs --data bench/longmemeval/longmemeval_s_cleaned.json --label lme-embed --embed

# 端到端 QA（本地模型，非官方口径）
node scripts/bench-longmemeval-qa.mjs --data bench/longmemeval/longmemeval_s_cleaned.json --questions 30
```
