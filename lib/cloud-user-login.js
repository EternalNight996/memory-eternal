// 用户端登录 / 注册页（与管理端完全分离）
//
// 三个入口：① 邮箱+密码登录 ② 邮箱+密码注册 ③ MengBot 账号登录（OIDC）
// 另保留「用访问密钥」直连（me_…），兼容老用户与脚本。
// 本页**不收管理令牌** —— 那是服务端管理员的，混进来就是权限串味。
import { shell } from './cloud-admin-ui.js'

const PAGE_CSS = 'input[type=text],input[type=password]{margin-top:8px}'

export function userLoginPage(opts = {}) {
  const err = String(opts.error || '')
  const authStart = String(opts.authStart || '/memory-eternal/api/cloud/auth/start')
  const signupMode = String(opts.signupMode || 'open')
  const inviteField = signupMode === 'invite'
    ? '<input id="ri" type="text" placeholder="邀请码">'
    : ''
  const inviteHint = signupMode === 'invite' ? '当前为邀请制，需要邀请码' : '开放注册，注册即签发一枚访问密钥（只显示一次）'
  const errBlock = '<div class="err" id="e1" style="display:' + (err ? 'block' : 'none') + '">' + err + '</div>'

  const body = [
    '<div class="wrap login" style="max-width:460px">',
    '<style>' + PAGE_CSS + '</style>',
    '<h1>登录 / 注册</h1>',
    '<div class="sub" style="margin:6px 0 16px">登录后访问<strong>你自己的</strong>记忆库。服务端管理员请走 <a href="/memory-eternal/api/admin">管理端登录</a>。</div>',

    '<div class="card"><h2>账号登录</h2>',
    '<input id="le" type="text" placeholder="邮箱" autocomplete="username">',
    '<input id="lp" type="password" placeholder="密码" autocomplete="current-password">',
    '<div class="row" style="margin-top:10px"><button id="signin">登录</button></div>',
    errBlock, '</div>',

    '<div class="card"><h2>注册新账号</h2>',
    '<div class="sub" style="margin-bottom:8px">' + inviteHint + '</div>',
    '<input id="re" type="text" placeholder="邮箱" autocomplete="username">',
    '<input id="rp" type="password" placeholder="密码（至少 8 位）" autocomplete="new-password">',
    inviteField,
    '<div class="row" style="margin-top:10px"><button id="signup">注册</button></div>',
    '<div class="err" id="e2" style="display:none"></div>',
    '<div class="ok" id="ok2" style="display:none"></div></div>',

    '<div class="card"><h2>用 MengBot 账号</h2>',
    '<div class="sub" style="margin-bottom:10px">跳转 MengBot 完成授权，回来自动建号或绑定到同邮箱账号。</div>',
    '<a href="' + authStart + '"><button type="button">用 MengBot 登录</button></a></div>',

    '<div class="card"><h2>用访问密钥</h2>',
    '<div class="sub" style="margin-bottom:8px">密钥形如 <code>me_…</code>，可由管理员发放。</div>',
    '<input id="k" type="password" placeholder="me_..." autocomplete="off">',
    '<div class="row" style="margin-top:10px"><button id="go">验证</button></div>',
    '<div class="err" id="e3" style="display:none"></div>',
    '<div class="ok" id="ok3" style="display:none"></div></div>',
    '</div>',
    '<script src="/memory-eternal/api/login.js"></script>',
  ].join('')

  return shell('记忆云 · 登录', body)
}