# 可选语义召回（Embedding）

> 默认**关闭**，也不需要安装任何模型。开启后由用户自行承担「卡片文本发给 embedding 服务」的隐私与费用。

## 1. 在界面里开启（推荐）

「设置 → 记忆 → 语义召回（可选）」：

**第一步选部署方式：**

| 方式 | 说明 |
|---|---|
| 内置语义（无需 Ollama） | **零安装、零网络、零费用**；停用词清洗 + 同义短语扩展，实测 R@5 95.4%、改写题 30%、延迟约 4ms |
| 本地 Ollama 部署 | 模型跑在本机，零 API 费用、数据不出本机；需要安装 Ollama（R@5 98.2%、改写 50%） |
| 在线 API | OpenAI 兼容端点（硅基流动 / 智谱 / 阿里百炼 / OpenAI / 自定义），按量计费 |

### 内置语义（builtin）

选中后无需任何模型服务：关闭向量路，检索走「清洗 + 同义扩展」的纯词法语义兜底；配置里 `mode=builtin`、`enabled=false`，面板显示「内置语义已生效」。

### 本地 Ollama 流程

1. **本机条件**：面板显示 CPU / 内存 / 显卡（有 NVIDIA 时会自动读出型号与显存）；
2. **Ollama 环境**：未安装时点「安装 Ollama」——若设置了 `MEMORY_OLLAMA_SETUP=<安装器路径>` 会静默安装，否则给出官网下载地址；
3. **选择模型**：目录内置 5 个（bge-m3 / qwen3-embedding / granite-embedding / nomic-embed-text / all-minilm），每个显示大小、维度、内存与显存建议、适用场景；
4. **下载**：未安装的模型点「下载模型」，下方出现**进度条**（已下载/总量、状态文字）；
5. **立即部署**：已安装的模型按钮变为「立即部署」——写入配置并后台建缓存，显示覆盖率；
6. 默认端口 7997；若你的 Ollama 在别的端口，把地址改成对应值即可。

### 在线 API 流程

1. 选厂商（自动填地址与模型列表）或选「自定义」手填；
2. 填 API Key；
3. 「检测连接」→「保存」→「立即部署」（后台建缓存）。

### 面板按钮一览

| 按钮 | 作用 |
|---|---|
| 刷新状态 | 重新读取模型目录、已安装模型、机器条件与任务进度 |
| 安装 Ollama | 仅在未安装时出现；需要 `MEMORY_OLLAMA_SETUP` 指向安装器才能静默安装 |
| 下载模型 | 调 Ollama `/api/pull`，带进度条 |
| 立即部署 | 写配置 + 后台建向量缓存 |
| 检测连接 | 探测 `/models`（OpenAI 兼容）或 `/api/tags`（Ollama） |

## 2. 本地部署（Ollama，零费用、数据不出本机）

### 能联网的机器

```bash
# 1) 安装 Ollama（官网下载）
# 2) 让服务监听 7997（与插件默认地址一致）
setx OLLAMA_HOST 127.0.0.1:7997        # Windows；之后重开终端
ollama serve
# 3) 拉模型（也可以点界面「一键拉取模型」）
ollama pull bge-m3
```

### 洞天内景 / 无法直连 ollama.com 的机器（离线）

插件的**面板不负责联网**。离线机器请按下面任一种方式把安装包/模型带进来，再执行一键配置：

1. 在可联网机器下载 `OllamaSetup.exe`（https://ollama.com/download/OllamaSetup.exe）；
2. 模型二选一：
   - 把可联网机器上的 `%USERPROFILE%\.ollama\models` 整个目录拷过来；
   - 或下载一个 embedding GGUF（如 `bge-m3` 的 GGUF）拷过来；
3. 在目标机器运行脚本（已随包，`scripts/setup-local-embedding.ps1`）：

```powershell
# 只装程序（模型之后仍需联网 pull 时可不用这个模式）
powershell -ExecutionPolicy Bypass -File scripts\setup-local-embedding.ps1 -OllamaSetup D:\OllamaSetup.exe

# 离线：拷贝模型目录
powershell -ExecutionPolicy Bypass -File scripts\setup-local-embedding.ps1 -OllamaSetup D:\OllamaSetup.exe -ModelsFrom D:\ollama-models

# 离线：用 GGUF 创建模型（默认名 bge-m3）
powershell -ExecutionPolicy Bypass -File scripts\setup-local-embedding.ps1 -OllamaSetup D:\OllamaSetup.exe -Gguf D:\bge-m3.Q4_K_M.gguf
```

脚本会：装 Ollama → 写 `OLLAMA_HOST=127.0.0.1:7997` → 启动 `ollama serve` → 导入/拉取模型 → 用 `/v1/models` 与 `/v1/embeddings` 自检。

4. 回到界面点「检测连接 → 一键配置并建缓存」。

> 如果服务已经是别的端口（例如 Ollama 默认 11434、LM Studio 1234），把面板地址改成对应值即可，不一定要 7997。

## 3. 环境变量（可选，覆盖界面配置之外的自动化场景）

```bash
MEMORY_EMBED_BASE_URL=https://api.openai.com/v1
MEMORY_EMBED_MODEL=text-embedding-3-small
MEMORY_EMBED_KEY=sk-...
```

优先级：**界面保存且启用 > 环境变量**。都缺失时功能不启动。

## 4. 建缓存

- 界面一键建，或命令行：

```bash
node scripts/embed-backfill.mjs --vault <vault 目录> [--limit 5000] [--batch 16]
# 或 npm run embed:backfill -- --vault <vault 目录>
```

- 只读卡片、只写 `card_vec` 缓存表（按 `model` 区分）；不改正文/状态。
- 每批一个事务：失败不会留下半批数据。
- 换模型：旧向量保留但不参与召回，重跑本脚本重算。
- **召回路径绝不建索引**：没有缓存或覆盖率 <30% 时，语义路自动跳过（避免一次搜索挂几十秒）。

### 增量同步（写卡后自动补）

开启语义召回时，以下操作会**异步**补/清该卡的向量（失败静默，不阻塞主流程）：

| 操作 | 行为 |
|---|---|
| 新建/批准入库 | 补向量 |
| 改标题/标签/正文、应用审核修改 | 重新嵌入覆盖 |
| 删除、驳回、移入回收站、永久删除 | 按 path 清掉向量 |
| 恢复回收站 → 主库 | 重新补向量 |

未启用时零网络请求；下次全量 `embed-backfill` 会顺带清理孤儿向量（已删卡残留）。

## 3. 召回行为

| 条件 | 行为 |
|---|---|
| 未配置 | 纯词法（FTS5+BM25+同义兜底），零网络、零变化 |
| 已配置 + 缓存覆盖 ≥30% | BM25 结果 + 向量 Top-50，向量排名按 `2 × (1-(rank-1)/50)` 加分；仅向量命中的卡从 2 分起 |
| 缓存不足 30% | 跳过语义路（半套缓存不可信） |
| 请求失败 | 静默降级，冷却 60 秒，不影响词法结果 |

## 4. 成本与隐私

- 每条卡片只嵌入一次（`title + 正文前 1800 字`），之后只嵌入查询。
- 3000 张卡 × 1800 字 ≈ 540 万字符，`text-embedding-3-small` 约 $0.02（一次性）；查询侧每次 1 次短请求。
- 数据会发送到你配置的端点；不配置就完全不出本机。

## 5. 验证

```bash
node tests/embeddings.test.mjs
```

单测用本地 mock `/embeddings` 服务器覆盖：未配置不启用、同义类无字面交集可召回、覆盖率不足跳过、服务不可用降级。

## 6. 已知限制

- 缓存表不回填历史删除/状态变化：卡片删除后向量行仍在（检索只查 `cards` 表，不会召回到已删卡）。
- 只有查询向量会实时请求；批量建缓存需手动跑脚本（也可接 CI/定时任务）。
- 向量奖励是固定经验值（2 分上限），没有在本机真实数据上调过参；接入后建议用 `bench/README.md` 的金标集复测再调。

## 7. 一键启停本地服务（面板）

「服务不可达」是这套可选功能最常见的卡点：红点在那儿，用户唯一的自解办法是打开终端敲
`OLLAMA_HOST=127.0.0.1:7997 ollama serve`。现在这件事在面板上是一个按钮。

**接口** `POST /memory-eternal/api/embedding/service`

| body | 行为 | 返回 |
|---|---|---|
| `{action:'start'}` | 能复用就复用（11434 / 7979 已有服务直接指过去），否则拉起 `ollama serve`（`OLLAMA_HOST=127.0.0.1:7997`）并轮询到就绪（最长 30s） | `{ok, reused, pid, baseUrl, models}` |
| `{action:'stop'}` | **只停本插件启动的进程**（pid 记在 `$DSH_HOME/ollama-service.json`） | `{ok, stopped, …}`；非面板启动返回 `code:'NOT_MANAGED'` |
| `{action:'restart'}` | 先停再起 | 同上 |
| `GET` | 只读状态 | `{installed, exe, running, managed, pid, baseUrl, reuse}` |

三条硬约束（实现见 [lib/ollama-service.js](../lib/ollama-service.js)）：

1. **只停自己启动的**：用户自己起的 Ollama（11434 或其它端口）一律不碰，只做「复用」；
2. **能复用就复用**：探测顺序 `7997 → 11434 → 7979`，命中即返回，不重复起进程；
3. **失败说人话**：`NO_BINARY`（找不到 exe，给安装引导）/ `SPAWN_FAILED` / `TIMEOUT`（进程已起但没就绪，提示稍后刷新）三种错误码分开。

实测（Windows，Ollama 0.40.16）：

```
GET  /embedding/service        → installed:true running:false
POST {action:'start'}          → ok:true reused:false pid:44808 baseUrl:http://127.0.0.1:7997/v1
GET  /embedding/service        → running:true managed:true
POST {action:'stop'}           → ok:true stopped:true
```

**全量回填实测**：`POST /embedding/backfill {limit:20000}` → 4,313 张待补，约 18–20 张/秒，~3.5 分钟跑完，
向量覆盖从 **2,980/7,293 → 7,293/7,293（100%）**；期间词法检索不受影响（回填只写 `card_vec`）。

## 8. 三种部署方式（面板可切）

| 模式 | 含义 | 需要什么 | 实测成本 |
|---|---|---|---|
| `builtin` 内置语义 | **零安装**：字符 n-gram 哈希向量 + 内置近义表归一（[lib/builtin-embed.js](../lib/builtin-embed.js)），768 维、纯 JS、不联网 | 什么都不用装 | 7,293 张卡 **8 秒**回填完 |
| `local` 本地 Ollama | 本机跑 `bge-m3` 等模型 | Ollama + 一个模型（面板可一键启动服务/拉模型） | 7,293 张卡约 3.5 分钟（≈19 张/秒） |
| `online` 在线 API | 任意 OpenAI 兼容的 embeddings 端点 | baseUrl + 模型名 + API Key | 取决于网络与配额 |

切换在面板「部署方式」下拉里做，选定后**立即写配置并生效**（`POST /embedding/deploy`），不是只改界面状态。

> **历史坑**：早期实现里 `mode=builtin` 会强制把 `enabled` 写成 `false` —— 用户选了「内置语义」，实际效果等于
> 关掉语义召回，而界面上看起来是「已选中」。现在内置是**真能用**的通道：`settingsFor()` 为它返回
> `{mode:'builtin', model:'builtin-ngram-768'}`，`embedTexts()` 在本地算，`denseSearch()` 照常按 model 过滤。

### 内置通道的能力边界（别高估）

它做的是**字面/词形相近 + 有限近义**，不是真正的语义推理：

| 输入对 | 相似度 | 说明 |
|---|---|---|
| 「语义召回怎么开启」vs「怎么开启语义召回功能」 | 0.58 | 同义重排认得出 |
| 「脚本跑久了会被卡住」vs「脚本 卡住 排查」 | 0.42 | 词形重叠 |
| 「脚本跑久了会被卡住」vs「任务挂住不动，怀疑死锁」 | 0.18 | 只能靠内置近义表（卡住≈挂住≈死锁） |
| 「脚本跑久了会被卡住」vs「图形界面渲染性能优化」 | 0.02 | 无关，区分得开 |

近义表在 `lib/builtin-embed.js` 的 `SYNONYM_GROUPS`（24 组，覆盖卡住/报错/配置/检索/备份/还原/权限/性能/皮肤/测试/版本/向量… 等高频概念）。**加词成本极低**，发现哪个词认不出就往对应组里塞一个。

### 向量存储：一张卡可以有多份向量

`card_vec` 主键是 **(id, model)**（不是单列 `id`）。这样切模型不会覆盖旧通道的向量：

```
按模型分行: bge-m3 7293 | builtin-ngram-768 7293
```

早期是单列主键，切一次模型就得把整个库重算一遍（用户看到「刚算完 7293，切一下剩 208」）。老库在
`ensureVecTable()` 里自动迁移（重建表 + 搬数据，失败回滚，下次再试）。

## 9. 两个门槛（避免「搜什么都一堆」）

语义召回接上之后，很容易出现「输入一句自然语言，返回几百条」——不是召回错了，是**门槛缺失**：

| 门槛 | 位置 | 值 | 作用 |
|---|---|---|---|
| 语义相似度下限 | `denseSearch()` | 远程模型 **0.35** / 内置通道 **0.12** | 低于它当作没命中，交给词法结果主导。两条通道分布差很远：真模型弱相关也在 0.4 上下，内置 n-gram 同义说法通常只有 0.15–0.25，同一个阈值会把内置整条掐死（实测完全无召回） |
| 相关性相对门槛 | `/cards?q=` | `≥ max(2, 最高分 × 0.55)` | 多词查询会靠常见词命中大半个库，按相对分数收口；响应里带 `relevanceFloor` 便于观察 |

实测（7,293 张卡、全量向量）：

```
「火绒」                  total 54 → 5      （floor=10，首条 16.8/body）
「语义召回怎么开」         total 51          （前两条 2.6/2.7，纯语义命中）
```

**已知限制**：长句自然语言查询（「怎么防止脚本被卡住」）仍然会返回很多——这类查询的词法命中覆盖大半个库，
而相关性分数分布很密（16.1 / 16.0 / 15.9…），相对门槛切不动。要真正收口得引入「查询词覆盖度」或 rerank 模型
（`lib/rerank.js` 已有接缝，配置 `rerankModel` 后由模型重排）。

## 10. 面板操作流程（一条路走完）

面板只做一件事：**让用户按顺序点下去**。部署方式在标题右侧，服务相关的东西只在「本地 Ollama」下出现。

```
🔍 语义召回（可选）                            [ 部署方式 ▼ ]

本地 Ollama： ① 服务 → ② 模型 → ③ 启用      （当前步高亮，完成的打勾）
内置 / 在线： 不出现任何「服务」字样
```

**主按钮只有一颗**，文案说清「这一下会发生什么」：

| 当前状态 | 主按钮 | 点了之后 |
|---|---|---|
| 本地 + 服务未起 + 未启用 | ▶ 启动服务并启用 | 先 `service start`，就绪后 `deploy` 写配置并建向量 |
| 本地 + 服务在跑 + 未启用 | ▶ 启用语义召回 | `deploy` 写配置 + 建向量 |
| 任意模式 + 已启用 | ■ 关闭语义召回 | 关语义检索（**不停服务**；停服务在①的次级小按钮里） |
| 内置 / 在线 + 未启用 | ▶ 启用语义召回 | 内置直接本地生效；在线先写 baseUrl/模型/Key 再启用 |

配套约束：

- **步骤锁**：① 没完成时 ②③ 置灰并提示「先启动服务」；② 没选模型时 ③ 置灰。
- **切换即生效**：下拉一改就 `POST /embedding/deploy`，失败回滚下拉与提示。
- **不再误报「服务不可达」**：`/embedding/status` 默认就探测（3 秒缓存），面板不需要记得带 `?probe=1`。
- **停止服务是次级操作**：只有「本地 Ollama + 服务在跑」时才出现小号「重启 / 停止」，避免和主流程抢注意力。

## 11. 配置持久化：为什么存了还会变回去

用户报过一个很典型的故障：**切到「内置语义」并关闭，点保存，关掉重开 → 又变回「本地 Ollama + 已开启」**。
查下来是三层问题叠在一起，每一层都会让「保存」看起来没生效：

| # | 原因 | 表现 | 修复 |
|---|---|---|---|
| 1 | `writeEmbeddingConfig` 里有隐式改写：`enabled=true` 且 `mode=builtin` → **自动改成 local** | 选内置、开启后，文件里落的是 local | 删掉这条隐式规则；要不要 builtin 由调用方显式决定 |
| 2 | 面板把「在线模式的预设地址」（`api.siliconflow.cn`）写进了 `mode=local` 的 baseUrl | 「本地 Ollama」去连公网，服务状态全错 | `mode=local` 时校验必须是 `127.0.0.1/localhost`，否则自动纠正为 `7997` 并通过 `corrected` 如实回报 |
| 3 | **旧版宿主进程**（插件 ≤0.31.x）在 web 自愈/配置同步时重写 `<config>.embedding.json` | 用户存的「内置 + 关闭」被盖回 `local + bge-m3`，重启即复现 | 配置迁到 **`<config>.embedding.v2.json`**，旧进程写的是废弃路径；v2 首次启动从旧文件迁移一次 |

配套的其它一致性约束：

- `enabled=false` 只改这一个字段，**不动 mode / model / baseUrl**；
- `builtin` 不需要地址也能保存（不会因为缺 baseUrl 整单被拒）；
- 传了「非空但非法」的地址（`ftp://`、缺 scheme）**直接拒**，不静默改写成空；
- 任何写配置（`/embedding/config`、`/embedding/deploy`）成功后**立刻清掉服务探测缓存**，否则 3 秒内状态栏还显示上一通道。

实测（本机，插件 0.40.1）：

```
POST /embedding/config {mode:'builtin', enabled:false, model:'builtin-ngram-768'}
  → mode=builtin enabled=false
重启 web（含被旧宿主自愈拉起的那条路径）
GET /embedding/status → mode=builtin enabled=false   ✅ 不再回滚

POST /embedding/config {mode:'local'}        # 旧配置里残留公网地址
  → baseUrl=http://127.0.0.1:7997/v1  corrected=['local 模式的地址必须是本机…']
```

> 归属关系：主「保存配置」按钮写的是**插件设置**（capture/recall/audit/备份…），不碰语义召回；
> 语义召回的 mode/enabled/模型由面板自身的动作**即时落盘**。所以「保存配置」不需要、也不会覆盖它 ——
> 之前的回滚全部来自上面三层。




