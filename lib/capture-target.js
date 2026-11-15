// 自动沉淀的**写入目标**判定（本地库 / 云端库）。
//
// 为什么需要这个模块：v0.48.2 之前，capture 一律「本地永远写 + 云端是副本」。
// 结果是用户切到云端模式后，本机 `~/.dsh/memory-vault` 还在持续长卡（真实现场：
// 云端 9656 张、本地 46 张碎片），用户看到的是「我明明切了云端，它还在往本地插」。
// 对使用者来说这在语义上就是脏数据 —— 本地库不再是"账本"，而是一份残缺副本。
//
// 现在的口径（默认，可由 `cloudWriteMode` 覆盖）：
//   · 云端可用 → **只写云端**：成功即完成；失败进 JSONL 补推队列（不写本地库，
//     避免污染；队列里存的是完整卡，恢复后自动补推，数据不丢）；
//   · 云端不可用 / 未登录 → 写本地（离线照常可用）；
//   · `cloudWriteMode = 'both'` → 老行为（本地写 + 异步推送），给需要本地账本的人。
//
// 纯函数，便于单测；不读文件、不发网络。调用方自己把 conn / cfg 递进来。
import { readCloudConn } from './cloud-push.js'

/** 允许的取值（配置面板与 schema 共用）。 */
export const CLOUD_WRITE_MODES = ['cloud', 'both']

/**
 * 云端连接是否**真的可用**（能发请求）。
 * 与 `cloud-push.shouldPushToCloud()` 同口径：mode=cloud + active + 有令牌 + 合法地址。
 */
export function cloudReady(conn) {
  const c = conn || {}
  return c.mode === 'cloud' && c.active !== false && !!String(c.token || '').trim() && /^https?:\/\//i.test(String(c.url || ''))
}

/**
 * 决定这次沉淀写哪里。
 * @param {{conn?:object, cfg?:object}} input
 * @returns {'cloud'|'local'}
 */
export function resolveCaptureTarget({ conn = null, cfg = null } = {}) {
  const c = conn || {}
  const f = cfg || {}
  if (!cloudReady(c)) return 'local'
  // 默认 cloud：云端模式下不再往本地库写（用户口径）。
  return String(f.cloudWriteMode || '').toLowerCase() === 'both' ? 'local' : 'cloud'
}

/** 便捷版：自己读 $DSH_HOME 的云端连接文件，再判定。 */
export function resolveCaptureTargetFromEnv(cfg = null, env = process.env) {
  return resolveCaptureTarget({ conn: readCloudConn(env), cfg })
}
