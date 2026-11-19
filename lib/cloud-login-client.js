// 登录页前端脚本（由服务端以 /memory-eternal/api/login.js 提供）
// 放独立文件而不是内联：内联要转义大量引号，实际已经写坏过一次。
export const LOGIN_JS = String.raw`
(function(){
  var API = '/memory-eternal/api';
  function $(id){ return document.getElementById(id); }
  function show(id, msg, kind){ var b=$(id); if(!b) return; b.className = kind||'err'; b.textContent = msg; b.style.display='block'; }
  function hide(id){ var b=$(id); if(b) b.style.display='none'; }
  function post(path, body){
    return fetch(API+path, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body||{}) })
      .then(function(r){ return r.json().catch(function(){return{};}).then(function(d){ return [r.ok, d, r.status]; }); });
  }

  var si = $('signin');
  if (si) si.addEventListener('click', function(){
    hide('e1');
    var e = ($('le')||{}).value || '';
    var p = ($('lp')||{}).value || '';
    e = e.trim();
    if (!e || !p) { show('e1','请填邮箱和密码'); return; }
    post('/signin', { email:e, password:p }).then(function(R){
      if (R[0] && R[1].ok) { location.href = API + '/me'; }
      else { show('e1', R[1].error || ('HTTP ' + R[2])); }
    }).catch(function(err){ show('e1','网络错误：' + err.message); });
  });

  var su = $('signup');
  if (su) su.addEventListener('click', function(){
    hide('e2'); hide('ok2');
    var e = (($('re')||{}).value || '').trim();
    var p = ($('rp')||{}).value || '';
    var inv = $('ri') ? (($('ri').value)||'').trim() : '';
    if (!e || !p) { show('e2','请填邮箱和密码'); return; }
    post('/signup', { email:e, password:p, invite:inv }).then(function(R){
      if (R[0] && R[1].ok) {
        var k = R[1].token || '';
        show('ok2', '注册成功' + (k ? ('，访问密钥（只显示这一次）：' + k) : '') + ' —— 已自动登录', 'ok');
      } else { show('e2', R[1].error || ('HTTP ' + R[2])); }
    }).catch(function(err){ show('e2','网络错误：' + err.message); });
  });

  var go = $('go');
  if (go) go.addEventListener('click', function(){
    hide('e3'); hide('ok3');
    var k = (($('k')||{}).value || '').trim();
    if (!k) { show('e3','请填密钥'); return; }
    fetch(API + '/cloud/whoami', { headers:{ Authorization:'Bearer ' + k } })
      .then(function(r){ return r.json().catch(function(){return{};}).then(function(d){ return [r.ok, d, r.status]; }); })
      .then(function(R){
        if (R[0] && R[1].ok) { show('ok3', '密钥有效 · owner=' + (R[1].owner||'?') + '，回面板填这串密钥即可', 'ok'); }
        else { show('e3', R[1].error || ('验证失败 HTTP ' + R[2])); }
      }).catch(function(err){ show('e3','网络错误：' + err.message); });
  });
})();
`