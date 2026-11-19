// 用户端登录 / 注册页（与管理端完全分离）
//
// 结构：**Tab 切换**（登录 / 注册 / MengBot / 密钥），一次只显示一个面板。
// 之前是四张卡片垂直堆叠，手机上要滚三屏才看到「用密钥」——用户明确要求改掉。
// 支持 ?tab=signup 直接落到某个面板（便于从面板里给「去注册」链接）。
import { shell } from './cloud-admin-ui.js'

const TABS_CSS = [
  '.tabs{display:flex;gap:6px;margin-bottom:14px;border-bottom:1px solid #232a33}',
  '.tabs button{flex:1;padding:9px 4px;border:0;background:transparent;color:#8b949e;border-bottom:2px solid transparent;border-radius:0;font-size:13px}',
  '.tabs button.on{color:#e6e9ef;border-bottom-color:#2f6feb}',
  '.tabs button:hover{color:#c9d1d9}',
  '.hint{font-size:12px;opacity:.55;margin-bottom:10px}',
].join('')

export function userLoginPage(opts = {}) {
  const err = String(opts.error || '')
  const authStart = String(opts.authStart || '/memory-eternal/api/cloud/auth/start')
  const signupMode = String(opts.signupMode || 'open')
  const inviteField = signupMode === 'invite' ? '<input id="ri" type="text" placeholder="邀请码">' : ''
  const inviteHint = signupMode === 'invite' ? '邀请制：需要邀请码' : '注册即签发一枚访问密钥（只显示一次）'
  const errBlock = err ? '<div class="err" style="display:block">' + err + '</div>' : '<div class="err" id="e1" style="display:none"></div>'

  const body = [
    '<style>' + TABS_CSS + '</style>',
    '<div class="wrap login" style="max-width:420px">',
    '<h1>记忆云</h1>',
    '<div class="sub" style="margin:6px 0 16px">服务端管理员请走 <a href="/memory-eternal/api/admin">管理端登录</a></div>',

    '<div class="tabs">',
    '<button type="button" data-tab="signin">登录</button>',
    '<button type="button" data-tab="signup">注册</button>',
    '<button type="button" data-tab="mengbot">MengBot</button>',
    '<button type="button" data-tab="key">密钥</button>',
    '</div>',

    // 登录面板
    '<div class="card" id="p-signin">',
    '<input id="le" type="text" placeholder="邮箱" autocomplete="username">',
    '<input id="lp" type="password" placeholder="密码" autocomplete="current-password" style="margin-top:8px">',
    '<div class="row" style="margin-top:12px"><button id="signin">登录</button>',
    '<a href="?tab=signup" style="font-size:12px;margin-left:6px">没有账号？去注册</a></div>',
    errBlock, '</div>',

    // 注册面板
    '<div class="card" id="p-signup" style="display:none">',
    '<div class="hint">' + inviteHint + '</div>',
    '<input id="re" type="text" placeholder="邮箱" autocomplete="username">',
    '<input id="rp" type="password" placeholder="密码（至少 8 位）" autocomplete="new-password" style="margin-top:8px">',
    inviteField,
    '<div class="row" style="margin-top:12px"><button id="signup">注册并登录</button>',
    '<a href="?tab=signin" style="font-size:12px;margin-left:6px">已有账号？去登录</a></div>',
    '<div class="err" id="e2" style="display:none"></div>',
    '<div class="ok" id="ok2" style="display:none"></div></div>',

    // MengBot 面板
    '<div class="card" id="p-mengbot" style="display:none">',
    '<div class="hint">跳转 MengBot 完成授权，回来自动建号；已有同邮箱账号时会绑定过去。</div>',
    '<a href="' + authStart + '"><button type="button">用 MengBot 登录</button></a></div>',

    // 密钥面板
    '<div class="card" id="p-key" style="display:none">',
    '<div class="hint">密钥形如 <code>me_…</code>，由管理员发放。</div>',
    '<input id="k" type="password" placeholder="me_..." autocomplete="off">',
    '<div class="row" style="margin-top:12px"><button id="go">验证</button></div>',
    '<div class="err" id="e3" style="display:none"></div>',
    '<div class="ok" id="ok3" style="display:none"></div></div>',
    '</div>',
    '<script src="/memory-eternal/api/login.js"></script>',
  ].join('')

  return shell('记忆云 · 登录', body)
}