// 记忆核心 · 设置句柄兼容层（跨 dsh 两代设置接口）
//
// 背景：dsh 0.1.7-alpha.1 移除了 `ctx.settings.register()` / `installSection()`。
// 之前插件在 apply 开头调用它，于是在 0.1.7 宿主上直接抛
//   TypeError: ctx.settings.register is not a function
// 插件激活失败（宿主日志：「1 entry did not activate」；desktop 端会直接判定
// renderer boot failed）。这就是 issue #5 报告的破坏性变更。
//
// 0.1.7 的 SettingsForms 方法集为：configure / describe / update(ns, patch,
// expectedRevision) / replace / mutate / write / schema —— 没有 per-registration
// 的 watcher，配置改为「由 Loader 依插件导出的 Config schema 解析后经
// apply(ctx, config) 传入」。
//
// 本模块把两代接口收敛成同一个句柄，插件其余代码无需改动：
//   - get()    : 取当前生效配置
//   - watch(cb): 0.1.6 及更早走原生 watcher；0.1.7 返回空 disposer
//   - update(p): 0.1.7 经 configEditor.edit(entry, current => {...current, ...p}) 落盘
//
// 为什么 0.1.7 可以不要 watcher：configEditor.edit() 收尾会调用
// reconcileProfilePatches()（dsh-app-boot），该 entry 随即被重新加载，
// apply() 会带着新 config 再跑一次——原先放在 watch 回调里的刷新逻辑
// 只要在 apply 内先执行一遍即可（插件里正是这么写的，见 index.js 的 syncAudit）。

/**
 * 建立一个设置句柄，自动适配 dsh ≤0.1.6 与 ≥0.1.7 两代接口。
 * @param {object} ctx Cordis 插件上下文
 * @param {string} namespace 设置命名空间（0.1.5 线用；0.1.7 线只作为 identity）
 * @param {Function} Schema schemastery schema（插件导出的 Config）
 * @param {object|undefined} base apply() 收到的 config
 */
export function createSettingsHandle(ctx, namespace, Schema, base) {
  // 0.1.6 及更早：原生路径，行为与历史版本完全一致
  if (typeof ctx.settings?.register === 'function') {
    return ctx.settings.register(namespace, Schema, { base: base ?? {} })
  }

  // 依 schema 兜一次默认值：0.1.7 的 Loader 通常已经解析过 entry 的 config，
  // 但个别宿主可能只透传原始 patch，兜底可以避免配置项静默变成 undefined。
  const resolve = (raw) => {
    try {
      const out = Schema(raw ?? {})
      if (out !== null && typeof out === 'object') return out
    } catch { /* 解析失败时退回原始值，保证插件仍能起来 */ }
    return raw ?? {}
  }

  let current = resolve(base)

  return {
    get: () => current,

    // 0.1.7 没有 per-registration watcher；配置写入会重载本 entry，
    // apply() 重跑时设置相关逻辑自然重算，所以返回空 disposer。
    watch: () => () => {},

    update: async (patch) => {
      const entry = ctx.fiber?.entry
      const editor = ctx.get?.('configEditor')
      if (entry === undefined || editor === undefined) {
        throw new Error('memory-eternal: 当前宿主没有 configEditor，无法写入配置')
      }
      await editor.edit(entry, (raw) => ({ ...(raw ?? {}), ...(patch ?? {}) }))
      // 写入后同一 apply 生命周期内继续读到的应是新值
      current = resolve({ ...current, ...(patch ?? {}) })
    },
  }
}
