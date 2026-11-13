# 兼容性（COMPAT）

`memory-eternal-cloud` 只依赖宿主插件的**公开内部出口**：

| 出口 | 用途 | 从哪个版本起稳定 |
|---|---|---|
| `lib/api.js` 的 `createApi(deps)` / `API_PREFIX` | 按租户构造 API 实例 | 0.31.0 |
| `lib/capture-run.js` 的 `configFilePath(env)` | 定位共享配置文件 | 0.24.0 |
| `lib/db.js` 的 `closeAllDb()` / `backupDb()` | 还原前后收句柄、导出快照 | 0.31.0 |
| 动态 `import('./cloud-server.js')` | 宿主按需加载私有模块 | 0.40.0 |

## 兼容矩阵

| memory-eternal-cloud | memory-eternal（宿主插件） | 说明 |
|---|---|---|
| 0.40.x | 0.40.x | 当前线；`/cloud/*` 接口全套 |
| 0.39.x | 0.39.x | 无 `windowStart`（备份时间窗）字段 |
| < 0.39 | — | 未发布 |

升级规则：**云端包的主版本必须 ≤ 宿主插件主版本**；次版本可以落后（缺的新接口会被客户端优雅降级，
例如 `/backup/config` 不认识 `windowStart` 时只写回老字段）。
