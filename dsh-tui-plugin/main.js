// memory-eternal-tui — dsh-TUI 的官方命令入口。
//
// 这里不做第二套 TUI UI：命令只负责把用户送到同一套 Memory Atlas Web UI。
// 审批仍然在 Web 里由人完成，不新增 agent 工具，也不触碰审核守卫。
import { spawn } from 'node:child_process'
import { AuditScene } from './scene.js'

export const name = 'memory-eternal-tui'
export const inject = ['agents']

const URL = 'http://127.0.0.1:7999/'
const COMMAND_ID = 'memory-eternal-tui.open'
const AUDIT_COMMAND_ID = 'memory-eternal-tui.audit'
const AUDIT_SCENE_ID = 'memory-eternal-tui-audit'

function openUrl() {
  const cmd = process.platform === 'win32' ? 'rundll32' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', URL] : [URL]
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', () => {})
    child.unref()
  } catch { /* 平台没有 opener 时由调用方提示手动访问 */ }
}

function openMemory() {
  // 优先让 CLI 确保常驻 Web 已启动并打开浏览器；命令不存在时直接打开 URL。
  try {
    const child = spawn('dsh-memory', ['open'], {
      detached: true,
      stdio: 'ignore',
      shell: true,
      windowsHide: true,
    })
    child.on('error', () => openUrl())
    child.on('exit', (code) => { if (code !== 0) openUrl() })
    child.unref()
  } catch {
    openUrl()
  }
}

export function apply(ctx) {
  // ── 为什么不能「拿不到 tuiPluginHost 就直接 return」────────────────────────
  // tuiPluginHost / tuiScenes 都是**后挂载**的 TUI seam：cordis 只保证插件被拉起来，
  // 不保证它激活时宿主 seam 已经就绪。旧实现 `const host = ctx.get('tuiPluginHost', false); if (!host) return`
  // 一旦抢跑就永久放弃 —— 表现为命令面板里根本没有 /memory、/audit（issue #50 用户实测）。
  // 参照 dsh-tui-find（同宿主同 API）：软探测 + 50ms 小步轮询，挂上再注册；10s 还没挂
  // 就安静收手（确实没有 TUI 运行时的组合不该报错）。
  const HOST_POLL_MS = 50
  const HOST_MAX_ATTEMPTS = 200 // ≈10s
  let disposed = false
  let hostTimer = null
  let hostAttempts = 0
  let hostDisposer = null

  const probe = (name) => {
    try { return ctx.get(name, false) } catch { return false }
  }

  const registerCommands = (host) => {
    const disposers = []
    disposers.push(host.registerCommand(ctx, COMMAND_ID, {
      recordInput: false,
      handler: () => {
        openMemory()
        return { kind: 'success', text: `Memory Atlas 已打开：${URL}` }
      },
    }))
    disposers.push(host.registerCommand(ctx, AUDIT_COMMAND_ID, {
      recordInput: false,
      handler: () => {
        const runtime = probe('tuiScenes')
        if (!runtime) return { kind: 'error', text: '当前 dsh-tui 没有 scenes 运行时' }
        if (runtime.active?.id === AUDIT_SCENE_ID) runtime.close()
        const opened = runtime.open(AUDIT_SCENE_ID)
        return opened
          ? { kind: 'success', text: 'Memory Atlas / 待审 已打开' }
          : { kind: 'error', text: '审核场景未注册' }
      },
    }))
    return () => { for (const d of disposers) { try { if (typeof d === 'function') d() } catch { /* 卸载失败不影响其他 */ } } }
  }

  const tryRegisterCommands = () => {
    hostTimer = null
    if (disposed) return
    const host = probe('tuiPluginHost')
    if (!host) {
      hostAttempts += 1
      if (hostAttempts < HOST_MAX_ATTEMPTS) hostTimer = setTimeout(tryRegisterCommands, HOST_POLL_MS)
      return
    }
    try {
      hostDisposer = registerCommands(host)
    } catch (error) {
      console.warn('[memory-eternal-tui] command registration failed:', error)
    }
  }
  tryRegisterCommands()

  // tuiScenes 同样可能晚于本插件挂载：沿用原来的软探测 + 50ms 重试（最多 ~2s）。
  let sceneDisposer = null
  let sceneTimer = null
  let attempts = 0
  const registerScene = () => {
    sceneTimer = null
    if (disposed) return
    const scenes = probe('tuiScenes')
    if (scenes && !sceneDisposer) {
      try {
        sceneDisposer = scenes.register({ id: AUDIT_SCENE_ID, title: 'Memory Atlas / 待审', component: AuditScene }, ctx)
      } catch (error) {
        console.warn('[memory-eternal-tui] scene registration failed:', error)
      }
    }
    if (!sceneDisposer && attempts < 40) {
      attempts += 1
      sceneTimer = setTimeout(registerScene, 50)
    }
  }
  registerScene()

  ctx.effect(() => () => {
    disposed = true
    if (hostTimer) clearTimeout(hostTimer)
    if (sceneTimer) clearTimeout(sceneTimer)
    if (hostDisposer) hostDisposer()
    if (sceneDisposer) sceneDisposer()
  })
}
