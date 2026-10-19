// 版本卡（插件信息）的**纯判定**：输入是探针事实，输出是「显示哪种警告 / 哪句提示 / 是否高亮按钮」。
//
// 为什么必须抽出来（真实事故）：0.10.45 我把「重启常驻实例」按钮塞进 `residentNeedsRestart ? ... :` 分支，
// 只考虑了「常驻旧 / 全部对齐」两种状态，漏了第三种「常驻新 + 宿主旧」——用户机器正好命中，按钮再次消失。
// 手写的三元链没被穷举，测试也只能覆盖我想到的那几条。这里改成**纯函数 + 表驱动**：
// 组合（≥12 种）在测试里逐条钉死，组件只负责把 key 翻成文案。
//
// 关键不变式：只要拿得到版本信息，**按钮永远显示**（showButton === true）。

export function versionCardState({
  hasVersion = false,
  hostVersion = '',
  onDisk = '',
  residentServed = '',
  residentPresent = false,
  residentManaged = null,
  residentManagedKnown = null,
  residentManagedBy = '',
  replaceBlocked = null,
} = {}) {
  const disk = String(onDisk || '')
  const host = String(hostVersion || '')
  const served = String(residentServed || '')

  const residentDown = Boolean(hasVersion && residentPresent && !served)
  const residentStale = Boolean(disk && served && served !== disk)
  const residentLockUnknown = residentManaged === false && residentManagedKnown === false
  const residentHostManaged = residentManagedBy === 'host'
  const residentUnmanaged = residentManaged === false && !residentLockUnknown && !residentHostManaged
  const hostStale = Boolean(host && disk && host !== disk)
  const replaceBlockedFresh = Boolean(replaceBlocked && replaceBlocked.fresh)
  const residentNeedsRestart = residentStale || residentDown || residentUnmanaged || residentLockUnknown

  // 警告块：优先级与旧实现完全一致（宿主旧最先说，因为那是「本页看不到新代码」的最直接原因）
  let warn = null
  if (hostStale) warn = 'hostProcessStale'
  else if (residentDown) warn = 'residentDown'
  else if (replaceBlockedFresh) warn = 'residentReplaceBlocked'
  else if (residentLockUnknown) warn = 'residentLockUnknown'
  else if (residentUnmanaged) warn = 'residentUnmanaged'

  // 按钮旁的一句说明：说清「点了能解决什么、不能解决什么」
  // 注意区分「版本落后」与「版本相同但没人保活」：后者说「换成 vX（当前 vX）」是自相矛盾的（截图实测）。
  let hint
  if (residentDown) hint = 'restartStart'
  else if (residentStale) hint = 'restartFixes'
  else if (residentUnmanaged || residentLockUnknown) hint = 'restartRepair'
  else if (hostStale) hint = 'restartHostOnly'
  else hint = 'restartAnyway'

  return {
    showButton: Boolean(hasVersion),
    emphasis: residentNeedsRestart,
    warn,
    hint,
    hostStale,
    residentDown,
    residentStale,
    residentUnmanaged,
    residentLockUnknown,
    residentHostManaged,
    needsRestart: residentNeedsRestart,
  }
}
