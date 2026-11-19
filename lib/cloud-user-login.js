// 用户端登录 / 注册 / 授权注册页（与管理端完全分离）
// 视觉参考腾讯云登录页：左侧品牌区 + 右侧卡片（窄屏单栏）。**扫码优先**。
import { shell } from './cloud-admin-ui.js'

const AUTH_CSS = ".auth{display:flex;min-height:100vh;align-items:stretch}.brand{flex:1.1;display:flex;flex-direction:column;justify-content:center;padding:56px 48px;background:linear-gradient(135deg,#0b1220 0%,#101a2e 45%,#0e1526 100%);border-right:1px solid #1b2432}.brand h2{font-size:26px;margin:0 0 8px;letter-spacing:.02em}.brand p{color:#8b949e;margin:0 0 26px;font-size:13.5px}.brand ul{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:12px;font-size:13px;color:#a9b4c2}.brand li:before{content:'·';color:#2f6feb;font-weight:700;margin-right:9px}.logo{width:38px;height:38px;border-radius:10px;background:linear-gradient(135deg,#2f6feb,#6ea8fe);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:17px;margin-bottom:22px}.pane{flex:1;display:flex;align-items:center;justify-content:center;padding:40px 24px}.box{width:100%;max-width:392px}.box h1{font-size:21px;margin:0 0 6px}.box .sub{margin:0 0 20px;font-size:12.5px;opacity:.55}.tabs{display:flex;gap:4px;margin-bottom:18px;border-bottom:1px solid #232a33}.tabs button{flex:1;padding:9px 2px;border:0;background:transparent;color:#8b949e;border-bottom:2px solid transparent;border-radius:0;font-size:13px;cursor:pointer}.tabs button.on{color:#e6e9ef;border-bottom-color:#2f6feb}.tabs button:hover{color:#c9d1d9}.field{margin-bottom:12px}.field label{display:block;font-size:12px;color:#8b949e;margin-bottom:6px}.field input{width:100%;padding:11px 12px;border-radius:8px;border:1px solid #2a323d;background:#0b0f14;color:#e6e9ef;font:inherit;outline:none}.field input:focus{border-color:#2f6feb;box-shadow:0 0 0 3px rgba(47,111,235,.15)}.btn{width:100%;padding:11px;border-radius:8px;border:1px solid #2f6feb;background:#2f6feb;color:#fff;font:inherit;cursor:pointer}.btn:hover{background:#3b7bf5}.btn.ghost{background:transparent;border-color:#2a323d;color:#c9d1d9}.qr-wrap{display:flex;flex-direction:column;align-items:center;gap:12px;padding:8px 0 4px}.qr-box{width:220px;height:220px;background:#fff;border-radius:12px;display:flex;align-items:center;justify-content:center;overflow:hidden}.qr-box img{width:100%;height:100%;display:block}.qr-state{font-size:12.5px;color:#8b949e;text-align:center;min-height:18px}.qr-state.ok{color:#3fb950}.qr-state.err{color:#ff7b72}.foot{margin-top:16px;font-size:12px;color:#8b949e;text-align:center}.foot a{color:#6ea8fe}.err{color:#ff7b72;font-size:12.5px;margin-top:10px}.ok{color:#3fb950;font-size:12.5px;margin-top:10px;word-break:break-all}@media(max-width:860px){.auth{flex-direction:column}.brand{display:none}.pane{padding:28px 18px}}"

export function userLoginPage(opts = {}) {
  const err = String(opts.error || '')
  const signupMode = String(opts.signupMode || 'open')
  const inviteField = signupMode === 'invite'
    ? '<div class="field"><label>邀请码</label><input id="ri" type="text" placeholder="邀请码"></div>'
    : ''
  const inviteHint = signupMode === 'invite' ? '邀请制：需要邀请码' : '注册后立即签发一枚访问密钥（只显示一次）'
  const body = [
    '<style>' + AUTH_CSS + '</style>',
    '<div class="auth">',
    '<aside class="brand">',
    '<div class="logo">M</div>',
    '<h2>Memory Eternal</h2>',
    '<p>本地优先的 AI 记忆库 · 记忆云</p>',
    '<ul>',
    '<li>数据在你自己手里，随时可导出</li>',
    '<li>卡片先进审核区，人审后才入库</li>',
    '<li>扫码即登录，不用再记一套账号</li>',
    '</ul>',
    '</aside>',
    '<main class="pane"><div class="box">',
    '<h1>登录记忆云</h1>',
    '<p class="sub">用手机扫码授权，或用邮箱密码登录</p>',
    '<div class="tabs">',
    '<button type="button" data-tab="qr">扫码</button>',
    '<button type="button" data-tab="signin">密码</button>',
    '<button type="button" data-tab="signup">注册</button>',
    '<button type="button" data-tab="key">密钥</button>',
    '</div>',
    '<div id="p-qr">',
    '<div class="qr-wrap">',
    '<div class="qr-box"><img id="qrimg" alt="二维码"></div>',
    '<div class="qr-state" id="qrstate">正在生成二维码…</div>',
    '<button class="btn ghost" id="qrrefresh" type="button">刷新二维码</button>',
    '</div></div>',
    '<div id="p-signin" style="display:none">',
    '<div class="field"><label>邮箱</label><input id="le" type="text" autocomplete="username" placeholder="you@example.com"></div>',
    '<div class="field"><label>密码</label><input id="lp" type="password" autocomplete="current-password"></div>',
    '<button class="btn" id="signin" type="button">登录</button>',
    '<div class="err" id="e1" style="display:none"></div>',
    '</div>',
    '<div id="p-signup" style="display:none">',
    '<p class="sub">' + inviteHint + '</p>',
    '<div class="field"><label>邮箱</label><input id="re" type="text" autocomplete="username" placeholder="you@example.com"></div>',
    '<div class="field"><label>密码（至少 8 位）</label><input id="rp" type="password" autocomplete="new-password"></div>',
    inviteField,
    '<button class="btn" id="signup" type="button">注册并登录</button>',
    '<div class="err" id="e2" style="display:none"></div>',
    '<div class="ok" id="ok2" style="display:none"></div>',
    '</div>',
    '<div id="p-key" style="display:none">',
    '<div class="field"><label>访问密钥（me_…）</label><input id="k" type="password" autocomplete="off" placeholder="me_..."></div>',
    '<button class="btn" id="go" type="button">验证</button>',
    '<div class="err" id="e3" style="display:none"></div>',
    '<div class="ok" id="ok3" style="display:none"></div>',
    '</div>',
    '<div class="foot">服务端管理员请走 <a href="/memory-eternal/api/admin">管理端登录</a></div>',
    '</div></main></div>',
    '<script src="/memory-eternal/api/login.js"></script>',
  ].join('')
  return shell('记忆云 · 登录', body)
}

/** 授权注册页：MengBot 的资料只读展示，用户只补一个密码。 */
export function authorizePage(opts = {}) {
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>\"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  const ticket = String(opts.ticket || '')
  const profile = opts.profile || {}
  const email = String(opts.email || profile.email || '')
  const name = String(profile.name || '')
  const pic = String(profile.picture || '')
  const avatar = pic
    ? '<img src="' + esc(pic) + '" alt="" style="width:56px;height:56px;border-radius:50%;object-fit:cover;border:1px solid #2a323d">'
    : '<div style="width:56px;height:56px;border-radius:50%;background:#1f6feb33;display:flex;align-items:center;justify-content:center;font-size:22px">' + esc((name || email || '?').slice(0, 1).toUpperCase()) + '</div>'
  const form = ticket
    ? [
        '<div style="display:flex;gap:14px;align-items:center;margin-bottom:18px">',
        avatar,
        '<div style="min-width:0"><div style="font-size:15px">' + esc(name || '(未提供昵称)') + '</div>',
        '<div style="font-size:12.5px;color:#8b949e;word-break:break-all">' + esc(email) + '</div></div>',
        '</div>',
        '<div class="field"><label>设置密码（至少 8 位）</label><input id="pw" type="password" autocomplete="new-password"></div>',
        '<div class="field"><label>再输一次</label><input id="pw2" type="password" autocomplete="new-password"></div>',
        '<button class="btn" id="done" type="button">完成注册并登录</button>',
        '<div class="err" id="ea" style="display:none"></div>',
        '<div class="foot">已有账号？<a href="/memory-eternal/api/login">去登录</a></div>',
        '<script src="/memory-eternal/api/authorize.js"></script>',
      ].join('')
    : '<div class="err" style="display:block">' + esc(opts.error || '授权凭证无效，请重新扫码') + '</div>'
      + '<div class="foot"><a href="/memory-eternal/api/login">← 返回登录</a></div>'
  const body = [
    '<style>' + AUTH_CSS + '</style>',
    '<div class="auth">',
    '<aside class="brand"><div class="logo">M</div><h2>完成注册</h2>',
    '<p>你的 MengBot 资料已带过来</p><ul>',
    '<li>头像 / 昵称 / 邮箱以 MengBot 为准</li>',
    '<li>只需再设一个密码，用于网页端快捷登录</li>',
    '<li>密码与 MengBot 账号互不影响</li>',
    '</ul></aside>',
    '<main class="pane"><div class="box">',
    '<h1>确认资料并设置密码</h1>',
    '<p class="sub">资料来自 MengBot，不可在此修改</p>',
    form,
    '</div></main></div>',
  ].join('')
  return shell('记忆云 · 完成注册', body)
}