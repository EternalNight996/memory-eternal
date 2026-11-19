// 用户端登录页（与 cloud-admin-ui 的管理端**完全分离**）
//
// 收什么：MengBot 账号（OIDC 跳转）、me_ 访问密钥。
// 不收什么：管理令牌 —— 那是服务端管理员的，混在一起就是权限串味。
import { shell } from './cloud-admin-ui.js'

export function userLoginPage(opts = {}) {
  const err = String(opts.error || '')
  const authStart = String(opts.authStart || '/memory-eternal/api/cloud/auth/start')
  return shell('记忆云 · 用户登录',
    '<div class="wrap login"><h1>用户登录</h1>'
    + '<div class="sub" style="margin:6px 0 18px">登录后访问<strong>你自己的</strong>记忆库。服务端管理员请走 <a href="/memory-eternal/api/admin">管理端登录</a>。</div>'
    + '<div class="card"><h2>用 MengBot 账号</h2>'
    + '<div class="sub" style="margin-bottom:10px">跳转 MengBot 完成授权，回来自动建立会话。</div>'
    + '<a href="' + authStart + '"><button type="button">用 MengBot 登录</button></a></div>'
    + '<div class="card"><h2>用访问密钥</h2>'
    + '<div class="sub" style="margin-bottom:10px">密钥形如 <code>me_…</code>，由管理员或你自己的面板签发。</div>'
    + '<input id="k" type="password" autocomplete="off" placeholder="me_...">'
    + '<div class="row" style="margin-top:10px"><button id="go">验证</button></div>'
    + '<div class="err" id="e" style="display:' + (err ? 'block' : 'none') + '">' + err + '</div>'
    + '<div class="ok" id="ok" style="display:none"></div></div></div>'
    + '<script>document.getElementById("go").addEventListener("click",async function(){'
    + 'var e=document.getElementById("e"),ok=document.getElementById("ok");'
    + 'e.style.display="none";ok.style.display="none";var k=document.getElementById("k").value.trim();'
    + 'if(!k){e.textContent="请填密钥";e.style.display="block";return}'
    + 'try{var r=await fetch("/memory-eternal/api/cloud/whoami",{headers:{Authorization:"Bearer "+k}});'
    + 'var d=await r.json().catch(function(){return{}});'
    + 'if(r.ok&&d.ok){ok.textContent="密钥有效 · owner="+(d.owner||"?")+"，回面板填这串密钥即可";ok.style.display="block"}'
    + 'else{e.textContent=d.error||("验证失败 HTTP "+r.status);e.style.display="block"}'
    + '}catch(err){e.textContent="网络错误："+err.message;e.style.display="block"}})</script>')
}