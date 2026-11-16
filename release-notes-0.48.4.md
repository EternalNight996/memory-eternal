## 🎨 v0.48.4 — 云端模式下卡片不再发灰（取消「未同步」）

### 你看到的

切到云端模式后，每一张卡片都挂着 `⏳ 未同步`、边框变虚线、整张压暗到 55%（截图里 6 张全中）。

### 为什么

`showSync` 原来是这么算的：

```jsx
showSync={cloudForm.mode === 'cloud' || cards.some((c) => c.cloudSyncedAt)}
//         ↑ 云端模式 → 强行开启"逐张判同步"
```

而判断单张卡的 `unsynced = !!showSync && !card.cloudSyncedAt` 用的是 `cloud_synced_at` —— 这是**本地推送记账列**，云端库里每张卡都没有它。于是云端模式下**每张卡都被判成未同步**。

### 改成什么

```jsx
showSync={cloudForm.mode !== 'cloud' && cards.some((c) => c.cloudSyncedAt)}
//         ↑ 云端模式整列不判：卡本来就在云端，没有"同步"这回事
```

- **云端模式**：不显示 `未同步`、不虚框、不压暗（已实测 `unsynced` 卡 0、徽标 0、`border-style: solid`、`opacity: 1`）；
- **本地库且真有过同步记录**：保留逐张区分（这是原来那套的正确用法，切回本地时仍能看到哪些还没推上去）；
- 虚线边框 / 55% 压暗 / ⏳ 徽标仍然只由 `unsynced` 一个开关控制，没有各写一份。

### 验证

- 新增 `tests/card-sync-badge.test.mjs`（3 例）：`showSync` 不许包含"处于云端模式"、三个视觉开关必须同源、构建产物守卫；
- CDP 实测（客户端 localStorage 切云端模式，同一实例 2 张卡）：`unsyncedCards=0`、`unsyncedBadges=0`、`borderStyle=solid`、`opacity=1`，页面文本里"未同步"只剩 CSS 注释（不是界面文案）；
- 截图：`runs/cloud-card-badge/cloud-cards.png`。

> 注意：这张图里剩下的 `⏳ 待审核` 是**审核态**（不是同步态），属于设计内 —— 待审队列里的卡就该标出来。
