// 记忆核心 · 插件自带前端资源（web/ 目录）的完整性判据。
//
// 为什么单独一个模块：**宿主启动自检**（index.js）与**独立 web 进程兜底**（lib/web.js）
// 必须用同一份判据和同一句措辞，否则两边会给出不一样的说法。
//
// 背景（issue #14）：有人从插件市场装出来的副本里只有 package.json / lib/，`web/` 没落地
// （发布物本身是齐的：npm 0.10.0 tgz 与 tag v0.10.0 都含 web/index.html）。那时侧边栏
// 「记忆」的 iframe 只会拿到一页原始的 `{"ok":false,"error":"ENOENT ... web/index.html"}`，
// 用户和维护者都看不出「装坏了、该怎么修」。

import { existsSync } from 'node:fs'
import path from 'node:path'

/** 前端界面必需的静态资源（相对包的 web/ 目录）。 */
export const WEB_ASSET_FILES = ['index.html', 'app.js']

/**
 * 列出 web/ 下缺失的资源文件名；空数组 = 齐全。
 * @param {string} packageRoot 插件包根目录（含 package.json 的那一层）
 * @param {string[]} files 需要检查的文件名
 */
export function missingWebAssets(packageRoot, files = WEB_ASSET_FILES) {
  return files.filter((f) => !existsSync(path.join(packageRoot, 'web', f)))
}

/** 缺 app.js 是硬故障：界面彻底起不来（缺 index.html 还能用内置外壳兜底）。 */
export function isHardMissing(missing) {
  return (missing || []).includes('app.js')
}

/**
 * 写进「自动沉淀日志」的那句话（宿主与独立服务共用，保证两处措辞一致）。
 * 顺带给出可照做的修法，避免用户再开一个 issue 问「怎么修」。
 */
export function missingAssetsReason(missing, packageRoot) {
  const list = (missing || []).map((f) => `web/${f}`).join('、')
  const where = path.join(packageRoot, 'web')
  const hard = isHardMissing(missing)
  return `插件安装不完整：缺少 ${list}（${where}）——${hard ? '侧边栏「记忆」界面无法加载' : '已用内置外壳兜底，界面仍可用'}。`
    + `修法：完全退出 DSH → 删掉 ${path.join(path.dirname(packageRoot), 'memory-eternal')} → 重开 DSH 后「插件 → 添加插件」重新安装`
}
