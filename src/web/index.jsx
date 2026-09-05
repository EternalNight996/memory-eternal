// 记忆核心 · Web UI 入口（浏览器/iframe 独立挂载）。
//
// 复用 src/client/index.tsx 的 MemoryLibrary（同一套 UI 与 DSH 内嵌零分叉），
// 仅替换：locale（跟 DSH 系统语言配置）与挂载点（#root 全屏，非弹窗形态）。
// API 走同源相对路径 /memory-eternal/api/*，由 lib/web.js 的独立 server 提供。
//
// 语言判定：URL ?lang=（DSH 内嵌 iframe 由 client 壳传入，首屏即正确；后续
// 语言变化经 postMessage 实时推送）> navigator.language（独立浏览器访问兜底）。

import React, { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryLibrary, ZH, EN } from '../client/index.tsx'

function initialLang() {
  try {
    const q = new URLSearchParams(window.location.search).get('lang')
    if (q === 'zh' || q === 'en') return q
  } catch {}
  return (typeof navigator !== 'undefined' && String(navigator.language || '').toLowerCase().startsWith('zh')) ? 'zh' : 'en'
}

function WebApp() {
  const [lang, setLang] = useState(initialLang)
  // client 壳在 DSH 系统语言切换时经 postMessage 推送 { source, type: 'locale', lang }
  useEffect(() => {
    const onMsg = (e) => {
      const d = e && e.data
      if (d && d.source === 'memory-eternal' && d.type === 'locale' && (d.lang === 'zh' || d.lang === 'en')) setLang(d.lang)
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])
  const t = useMemo(() => (key) => (lang === 'zh' ? ZH : EN)[key] ?? ZH[key] ?? key, [lang])
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  return <MemoryLibrary t={t} inModal={false} />
}

const root = createRoot(document.getElementById('root'))
root.render(<WebApp />)
