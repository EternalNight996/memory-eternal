import fs from 'node:fs'
const p = 'src/client/index.tsx'
const raw = fs.readFileSync(p, 'utf8')
const CRLF = raw.includes('\r\n')
let s = raw.replace(/\r\n/g, '\n')

// ── ① 只有一个库时，整块「与哪个库搬数据」没必要 —— 没得选 ──────────────
// 条件：本机库 >1 个 或 云端库 >0 个（跨端搬才有意义）
const OLD_LABEL = `                      <label className="mc-field" style={{ margin: 0 }}>
                        <span className="mc-field-label">{t('vaultTargetLabel')}</span>`
if (!s.includes(OLD_LABEL)) { console.log('目标库 label 未找到'); process.exit(1) }

// 找到整个「与哪个库搬数据 + 重复策略 + 按钮」容器的开始
// 它在 <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 9 }}>
const iLabel = s.indexOf(OLD_LABEL)
const iWrap = s.lastIndexOf(`<div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 9 }}>`, iLabel)
if (iWrap < 0) { console.log('传输容器未找到'); process.exit(1) }
console.log('传输容器起点:', iWrap)

s = s.slice(0, iWrap) + `{/* 只有「有别的库可搬」时才显示这块 —— 单库场景下下拉里没东西可选，纯属占地方 */}
                      {(vaultList && vaultList.length > 1) || (cloudVaultList && cloudVaultList.length > 0) ? (
                      <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 9 }}>` + s.slice(iWrap + `<div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 9 }}>`.length)

fs.writeFileSync(p, CRLF ? s.replace(/\n/g, '\r\n') : s)
console.log('传输区已加条件')
