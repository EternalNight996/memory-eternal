// 登录页前端脚本（由服务端以 /memory-eternal/api/login.js 提供）
// 放独立文件而不是内联：内联要转义大量引号，实际已经写坏过一次。
export const LOGIN_JS = String.raw`
(function(){
  var API = '/memory-eternal/api';
  var TABS = ['signin','signup','mengbot','key'];
  function $(id){ return document.getElementById(id); }
  function show(id, msg, kind){ var b=$(id); if(!b) return; b.className = kind||'err'; b.textContent = msg; b.style.display='block'; }
  function hide(id){ var b=$(id); if(b) b.style.display='none'; }
  function post(path, body){
    return fetch(API+path, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body||{}) })
      .then(function(r){ return r.json().catch(function(){return{};}).then(function(d){ return [r.ok, d, r.status]; }); });
  }

  // ---- Tab 切换 ----
  function activate(name){
    var btns = document.querySelectorAll('[data-tab]');
    for (var i=0;i<btns.length;i++){
      var b = btns[i];
      if (b.getAttribute('data-tab') === name) b.classList.add('on'); else b.classList.remove('on');
    }
    for (var j=0;j<TABS.length;j++){
      var p = $('p-' + TABS[j]);
      if (p) p.style.display = (TABS[j] === name) ? 'block' : 'none';
    }
    try { history.replaceState(null, '', '?tab=' + name); } catch (e) { /* 忽略 */ }
  }
  var btns0 = document.querySelectorAll('[data-tab]');
  for (var i0=0;i0<btns0.length;i0++){
    (function(b){ b.addEventListener('click', function(){ activate(b.getAttribute('data-tab')); }); })(btns0[i0]);
  }
  var want = 'signin';
  try { want = new URLSearchParams(location.search).get('tab') || 'signin'; } catch (e) { /* 忽略 */ }
  if (TABS.indexOf(want) < 0) want = 'signin';
  activate(want);

  // ---- 登录 ----
  var si = $('signin');
  if (si) si.addEventListener('click', function(){
    hide('e1');
    var mail = (($('le')||{}).value || '').trim();
    var pass = ($('lp')||{}).value || '';
    if (!mail || !pass) { show('e1','请填邮箱和密码'); return; }
    post('/signin', { email:mail, password:pass }).then(function(R){
      if (R[0] && R[1].ok) { show('e1','登录成功，跳转中…','ok'); location.href = API + '/me'; }
      else { show('e1', R[1].error || ('HTTP ' + R[2])); }
    }).catch(function(err){ show('e1','网络错误：' + err.message); });
  });

  // ---- 注册 ----
  var su = $('signup');
  if (su) su.addEventListener('click', function(){
    hide('e2'); hide('ok2');
    var mail = (($('re')||{}).value || '').trim();
    var pass = ($('rp')||{}).value || '';
    var inv = $('ri') ? (($('ri').value)||'').trim() : '';
    if (!mail || !pass) { show('e2','请填邮箱和密码'); return; }
    post('/signup', { email:mail, password:pass, invite:inv }).then(function(R){
      if (R[0] && R[1].ok) {
        var k = R[1].token || '';
        show('ok2', '注册成功' + (k ? (' · 访问密钥（只显示这一次）：' + k) : '') + ' · 已自动登录', 'ok');
      } else { show('e2', R[1].error || ('HTTP ' + R[2])); }
    }).catch(function(err){ show('e2','网络错误：' + err.message); });
  });

  // ---- 密钥验证 ----
  var go = $('go');
  if (go) go.addEventListener('click', function(){
    hide('e3'); hide('ok3');
    var k = (($('k')||{}).value || '').trim();
    if (!k) { show('e3','请填密钥'); return; }
    fetch(API + '/cloud/whoami', { headers:{ Authorization:'Bearer ' + k } })
      .then(function(r){ return r.json().catch(function(){return{};}).then(function(d){ return [r.ok, d, r.status]; }); })
      .then(function(R){
        if (R[0] && R[1].ok) { show('ok3', '密钥有效 · owner=' + (R[1].owner||'?'), 'ok'); }
        else { show('e3', R[1].error || ('验证失败 HTTP ' + R[2])); }
      }).catch(function(err){ show('e3','网络错误：' + err.message); });
  });
})();
`