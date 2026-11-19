// 登录页脚本：扫码轮询 + 密码/注册/密钥。由 /memory-eternal/api/login.js 提供。
export const LOGIN_JS = String.raw`
(function(){
  var API = '/memory-eternal/api';
  var TABS = ['qr','signin','signup','key'];
  function $(id){ return document.getElementById(id); }
  function show(id,msg,kind){ var b=$(id); if(!b)return; b.className=kind||'err'; b.textContent=msg; b.style.display='block'; }
  function hide(id){ var b=$(id); if(b) b.style.display='none'; }
  function post(p,b){ return fetch(API+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})}).then(function(r){return r.json().catch(function(){return{};}).then(function(d){return [r.ok,d,r.status];});}); }

  function activate(name){
    var bs=document.querySelectorAll('[data-tab]');
    for(var i=0;i<bs.length;i++){ bs[i].classList[bs[i].getAttribute('data-tab')===name?'add':'remove']('on'); }
    for(var j=0;j<TABS.length;j++){ var p=$('p-'+TABS[j]); if(p) p.style.display=(TABS[j]===name)?'block':'none'; }
    try{ history.replaceState(null,'','?tab='+name); }catch(e){}
  }
  var bs0=document.querySelectorAll('[data-tab]');
  for(var i0=0;i0<bs0.length;i0++){ (function(b){ b.addEventListener('click',function(){ activate(b.getAttribute('data-tab')); }); })(bs0[i0]); }

  // ---- 扫码登录 ----
  var pollTimer=null, pollId='', polling=false;
  function stopPoll(){ if(pollTimer){clearInterval(pollTimer);pollTimer=null;} polling=false; }
  function setState(msg,cls){ var el=$('qrstate'); if(!el)return; el.textContent=msg; el.className='qr-state'+(cls?(' '+cls):''); }
  function pollOnce(){
    if(!pollId) return;
    fetch(API+'/cloud/auth/poll?poll_id='+encodeURIComponent(pollId)).then(function(r){return r.json().catch(function(){return{};});}).then(function(d){
      if(d && d.ok && d.needAuthorize && d.regTicket){
        stopPoll(); setState('需要补设密码，正在跳转…','ok');
        location.href = API + '/register/authorize?ticket=' + encodeURIComponent(d.regTicket);
        return;
      }
      if(d && d.ok && d.token){
        stopPoll(); setState('授权成功，正在登录…','ok');
        try{ localStorage.setItem('me_cloud_token', d.token); localStorage.setItem('me_cloud_owner', d.owner||''); }catch(e){}
        location.href = API + '/me';
        return;
      }
      if(d && d.pending){ setState('等待手机确认…'); return; }
      if(d && d.code==='poll_expired'){ stopPoll(); setState('二维码已过期，请刷新','err'); return; }
    }).catch(function(){ /* 网络抖动，下次再试 */ });
  }
  function newQr(){
    stopPoll();
    setState('正在生成二维码…');
    post('/cloud/auth/poll/start',{}).then(function(R){
      var d=R[1]||{};
      if(!R[0]||!d.ok||!d.url){ setState('二维码生成失败：'+(d.error||('HTTP '+R[2])),'err'); return; }
      pollId=d.pollId||'';
      var img=$('qrimg');
      if(img) img.src = API + '/cloud/auth/qr?d=' + encodeURIComponent(d.url);
      setState('请用手机扫码授权');
      polling=true;
      pollTimer=setInterval(pollOnce, Math.max(2,(d.interval||3))*1000);
    }).catch(function(e){ setState('网络错误：'+e.message,'err'); });
  }
  var rf=$('qrrefresh'); if(rf) rf.addEventListener('click', newQr);

  // ---- 密码登录 ----
  var si=$('signin'); if(si) si.addEventListener('click', function(){
    hide('e1');
    var m=(($('le')||{}).value||'').trim(), p=($('lp')||{}).value||'';
    if(!m||!p){ show('e1','请填邮箱和密码'); return; }
    post('/signin',{email:m,password:p}).then(function(R){
      if(R[0]&&R[1].ok){ show('e1','登录成功，跳转中…','ok'); location.href=API+'/me'; }
      else show('e1', R[1].error||('HTTP '+R[2]));
    }).catch(function(e){ show('e1','网络错误：'+e.message); });
  });

  // ---- 注册 ----
  var su=$('signup'); if(su) su.addEventListener('click', function(){
    hide('e2'); hide('ok2');
    var m=(($('re')||{}).value||'').trim(), p=($('rp')||{}).value||'';
    var inv=$('ri')?(($('ri').value)||'').trim():'';
    if(!m||!p){ show('e2','请填邮箱和密码'); return; }
    post('/signup',{email:m,password:p,invite:inv}).then(function(R){
      if(R[0]&&R[1].ok){ var k=R[1].token||''; show('ok2','注册成功'+(k?(' · 访问密钥（只显示这一次）：'+k):'')+' · 已自动登录','ok'); }
      else show('e2', R[1].error||('HTTP '+R[2]));
    }).catch(function(e){ show('e2','网络错误：'+e.message); });
  });

  // ---- 密钥 ----
  var go=$('go'); if(go) go.addEventListener('click', function(){
    hide('e3'); hide('ok3');
    var k=(($('k')||{}).value||'').trim();
    if(!k){ show('e3','请填密钥'); return; }
    fetch(API+'/cloud/whoami',{headers:{Authorization:'Bearer '+k}}).then(function(r){return r.json().catch(function(){return{};}).then(function(d){return [r.ok,d,r.status];});}).then(function(R){
      if(R[0]&&R[1].ok) show('ok3','密钥有效 · owner='+(R[1].owner||'?'),'ok');
      else show('e3', R[1].error||('验证失败 HTTP '+R[2]));
    }).catch(function(e){ show('e3','网络错误：'+e.message); });
  });

  // 初始 Tab：?tab= 优先，否则扫码
  var want='qr';
  try{ want=new URLSearchParams(location.search).get('tab')||'qr'; }catch(e){}
  if(TABS.indexOf(want)<0) want='qr';
  activate(want);
  if(want==='qr') newQr();
})();
`

// 授权注册页脚本：提交 ticket + 密码
export const AUTHORIZE_JS = String.raw`
(function(){
  var API='/memory-eternal/api';
  function $(id){ return document.getElementById(id); }
  var btn=$('done'); if(!btn) return;
  btn.addEventListener('click', function(){
    var e=$('ea'); e.style.display='none';
    var pw=($('pw')||{}).value||'', pw2=($('pw2')||{}).value||'';
    if(pw.length<8){ e.textContent='密码至少 8 位'; e.style.display='block'; return; }
    if(pw!==pw2){ e.textContent='两次输入不一致'; e.style.display='block'; return; }
    var t=new URLSearchParams(location.search).get('ticket')||'';
    fetch(API+'/cloud/auth/authorize',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticket:t,password:pw})})
      .then(function(r){return r.json().catch(function(){return{};}).then(function(d){return [r.ok,d,r.status];});})
      .then(function(R){
        if(R[0]&&R[1].ok){ e.className='ok'; e.textContent='注册成功，正在跳转…'; e.style.display='block'; setTimeout(function(){ location.href=API+'/me'; },700); }
        else { e.className='err'; e.textContent=R[1].error||('HTTP '+R[2]); e.style.display='block'; }
      }).catch(function(err){ e.textContent='网络错误：'+err.message; e.style.display='block'; });
  });
})();
`