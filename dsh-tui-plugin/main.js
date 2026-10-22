// memory-eternal-tui — dsh-TUI 的官方命令入口。
//
// 这里不做第二套 TUI UI：命令只负责把用户送到同一套 Memory Atlas Web UI。
// 审批仍然在 Web 里由人完成，不新增 agent 工具，也不触碰审核守卫。
import { spawn } from 'node:child_process'

export const name = 'memory-eternal-tui'
export const inject = ['agents']

const URL = 'http://127.0.0.1:7999/'
const COMMAND_ID = 'memory-eternal-tui.open'

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
  const host = ctx.get('tuiPluginHost', false)
  if (!host) return

  const dispose = host.registerCommand(ctx, COMMAND_ID, {
    recordInput: false,
    handler: () => {
      openMemory()
      return { kind: 'success', text: `Memory Atlas 已打开：${URL}` }
    },
  })
  ctx.effect(() => dispose)
}

export default { name, inject, apply }
