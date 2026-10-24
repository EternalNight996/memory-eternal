// issue #51 回归守卫：蒸馏/精炼的 LLM 调用必须带 sessionId。
//
// 事故（issue #51）：DSH 的 GenerateOptions 有官方字段 sessionId；opencode-go 之类的网关
// **只在拿到它时**才注入 x-opencode-session 头，缺了这个头网关一律
// 400 {"type":"MissingSessionID"}。表现：每一轮自动沉淀的首跳必然失败、白烧一次调用，
// 面板长期挂「⚠ 自动沉淀异常」（卡片其实靠换 provider 兜底建出来了）。
// 本文件锁两件事：① 两个 LLM 入口都把 sessionId 塞进 options（真值优先、常量兜底）；
// ② 宿主捕获链路把真实会话 id 透传进来，而不是永远用常量。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { summarizeTurnDetailed, callLlmJson, resolveLlmSessionId } from '../lib/capture.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => readFileSync(path.join(root, f), 'utf8')
const captureSrc = read('lib/capture.js')
const indexSrc = read('index.js')

/** 假 llm：记下每次 stream 的 options，按 BlockAssembler 期望的格式吐一个文本块 */
function recordingLlm(text) {
  const calls = []
  return {
    calls,
    stream: async function* (options) {
      calls.push(options)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: 'stop' }
    },
  }
}

// 必须过 summarizeTurnDetailed 的三道预筛（长度 >120、无注入噪声、looksDurable）
const durableTalk = [
  '用户：我的 React 列表滚动很卡，怎么优化？',
  '助手：先用 React.memo 包住行组件减少重渲染，再用 useMemo 缓存昂贵计算；数据量大时上虚拟滚动（react-window 轻量、react-virtualized 功能全，行高固定优先 react-window）。',
  '用户：还有别的坑吗？',
  '助手：不要在渲染循环里创建内联对象/函数（每次都是新引用，memo 全失效），也别把 index 当 key；用 React DevTools Profiler 先定位再改。',
].join('\n')

test('summarizeTurnDetailed：真实会话 id 原样透传到 llm.stream options（不改写、不拼请求头）', async () => {
  const llm = recordingLlm(JSON.stringify({ save: false }))
  await summarizeTurnDetailed(llm, { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }, durableTalk, { sessionId: 'session-abc123' })
  assert.equal(llm.calls.length, 1, '正常情况只该发一次请求')
  const opts = llm.calls[0]
  assert.equal(opts.sessionId, 'session-abc123', 'host 捕获链路必须把真实 sessionId 传下去')
  assert.equal(opts.purpose, 'memory-capture')
  assert.equal('headers' in opts, false, '不要自己拼 x-opencode-session 头（那是 provider 的事，插件只给 sessionId）')
})

test('summarizeTurnDetailed：调用方没给 sessionId 时用稳定常量，绝不能是 undefined（否则首跳 400）', async () => {
  const llm = recordingLlm(JSON.stringify({ save: false }))
  await summarizeTurnDetailed(llm, { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }, durableTalk, {})
  const sid = llm.calls[0].sessionId
  assert.equal(typeof sid, 'string')
  assert.ok(sid.length > 0, 'sessionId 不能是空串/undefined：网关只认"有值"')
  assert.equal(sid, 'memory-eternal-capture', '兜底常量要稳定（同一进程复用，别每次随机）')

  const blank = recordingLlm(JSON.stringify({ save: false }))
  await summarizeTurnDetailed(blank, { provider: 'p', model: 'm' }, durableTalk, { sessionId: '   ' })
  assert.equal(blank.calls[0].sessionId, 'memory-eternal-capture', '空白 sessionId 也要回退到常量')
})

test('callLlmJson（精炼/判别）：默认带 refine 常量，显式传入时用真值', async () => {
  const a = recordingLlm('{"ok":true}')
  await callLlmJson(a, { provider: 'opencode-go', model: 'm' }, { user: '判断这条是否矛盾', purpose: 'memory-refine-judge' })
  assert.equal(a.calls[0].sessionId, 'memory-eternal-refine')

  const b = recordingLlm('{"ok":true}')
  await callLlmJson(b, { provider: 'opencode-go', model: 'm' }, { user: 'x', sessionId: 'session-zzz' })
  assert.equal(b.calls[0].sessionId, 'session-zzz')
})

test('resolveLlmSessionId：空/空白/undefined 全回退，真值原样保留并 trim', () => {
  assert.equal(resolveLlmSessionId('', 'fb'), 'fb')
  assert.equal(resolveLlmSessionId('   ', 'fb'), 'fb')
  assert.equal(resolveLlmSessionId(undefined, 'fb'), 'fb')
  assert.equal(resolveLlmSessionId(null, 'fb'), 'fb')
  assert.equal(resolveLlmSessionId(' session-1 ', 'fb'), 'session-1')
  assert.equal(resolveLlmSessionId('', undefined), 'memory-eternal-capture', '兜底默认值就是捕获常量')
})

test('源码守卫：宿主捕获链路透传真实 sessionId；两处 options 都写进 sessionId', () => {
  // ① options 里确实有 sessionId（不是只在函数签名上收着）
  const optionHits = captureSrc.match(/sessionId: resolveLlmSessionId\(/g) || []
  assert.equal(optionHits.length, 2, 'callLlmJson 与 summarizeTurnDetailed 两处 options 都要带 sessionId，实测 ' + optionHits.length)
  assert.match(captureSrc, /const CAPTURE_LLM_SESSION_ID = 'memory-eternal-capture'/, '捕获兜底常量要在')
  assert.match(captureSrc, /const REFINE_LLM_SESSION_ID = 'memory-eternal-refine'/, '精炼兜底常量要在')
  // ② 宿主侧：调用 summarizeTurnDetailed 时把 sessionId 变量传进去
  assert.match(indexSrc, /summarizeTurnDetailed\(llm, route, text, \{[^}]*sessionId[^}]*\}/, 'index.js 的捕获链路要把 sessionId 传给 summarizeTurnDetailed')
  assert.match(indexSrc, /const sessionId = agent\?\.session\?\.id \?\? agent\?\.id/, 'sessionId 仍来自真实会话（不是写死）')
})
