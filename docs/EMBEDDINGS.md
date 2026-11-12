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

### 内网 / 无法直连 ollama.com 的机器（离线）

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
