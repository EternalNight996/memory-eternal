// 控制台前端脚本（/api/console.js）
export const CONSOLE_JS = String.raw`
(function(){
  var API='/api';
  function $(id){ return document.getElementById(id); }
  function show(id,msg,cls){ var b=$(id); if(!b)return; b.className=cls||'err'; b.textContent=msg; b.style.display='block'; }
  function post(p,b){ return fetch(API+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})}).then(function(r){return r.json().catch(function(){return{};}).then(function(d){return [r.ok,d,r.status];});}); }

  var lo=$('logout'); if(lo) lo.addEventListener('click',function(){ fetch(API+'/signout',{method:'POST'}).catch(function(){}).then(function(){ location.href=API+'/login'; }); });

  // 订阅走 <a href>（服务端已生成完整 URL），这里只处理「刷新订阅状态」
  var rf=$('refresh'); if(rf) rf.addEventListener('click',function(){
    rf.textContent='刷新中…';
    post('/console/refresh-subscription',{}).then(function(){
      location.reload();
    }).catch(function(){ location.reload(); });
  });

  var mk=$('mkvault'); if(mk) mk.addEventListener('click',function(){
    var n=(($('vname')||{}).value||'').trim().toLowerCase();
    if(!n){ show('everr','请填库名'); return; }
    post('/console/vaults',{name:n}).then(function(R){
      if(R[0]&&R[1].ok){ location.reload(); }
      else if(R[2]===402){ show('everr','需要先订阅才能建库'); }
      else { show('everr', R[1].error||('HTTP '+R[2])); }
    }).catch(function(e){ show('everr','网络错误：'+e.message); });
  });

  // 库行的「生成匹配码」→ **直接生成**（以前只预选库，用户以为点了没反应）
  document.querySelectorAll('[data-pair]').forEach(function(b){
    b.addEventListener('click',function(){
      var vault=b.getAttribute('data-pair');
      var v=document.getElementById('pairvault');
      if(v) v.value=vault;
      var g2=document.getElementById('pairgen');
      if(g2) g2.click();
    });
  });
  // 生成匹配码（带安全策略：库 + IP 白名单 + 仅本账号）
  var gen=document.getElementById('pairgen');
  if(gen) gen.addEventListener('click',function(){
    var vd=document.getElementById('pairvault');
    var ipEl=document.getElementById('pairip');
    var owEl=document.getElementById('pairowner');
    var vault=vd?String(vd.value||'').trim():'';
    if(!vault){ alert('先选一个库（还没有库就先建库）'); return; }
    var ip=ipEl?String(ipEl.value||'').trim():'';
    var onlyOwner=owEl?!!owEl.checked:true;
    var out=document.getElementById('pairout');
    if(out){ out.style.display='block'; out.style.color='#8b949e'; out.textContent='生成中…'; }
    post('/console/pair',{vault:vault,ipAllow:ip,onlyOwner:onlyOwner}).then(function(R){
      if(!out) return;
      out.style.display='block';
      if(R[0]&&R[1].ok){
        out.style.color='#3fb950';
        out.innerHTML='匹配码（只显示这一次）：<code style="font-size:13px;background:#0b0f14;padding:3px 8px;border-radius:6px">'+R[1].code+'</code>'
          +'<div style="margin-top:6px;color:#8b949e;font-size:11.5px">库 '+(R[1].vault||vault)+(onlyOwner?' · 仅本账号':' · 不限账号')+(ip?' · IP '+ip:' · 不限 IP')+'</div>';
        if(ipEl) ipEl.value='';
      } else {
        out.style.color='#e5534b';
        out.textContent='生成失败：'+((R[1]&&R[1].error)||('HTTP '+R[2]));
      }
    }).catch(function(e){ if(out){ out.style.display='block'; out.style.color='#e5534b'; out.textContent='网络错误：'+e.message; } });
  });

  document.querySelectorAll('[data-revoke]').forEach(function(b){
    b.addEventListener('click',function(){
      if(!confirm('吊销这个匹配码？')) return;
      var id=b.getAttribute('data-revoke');
      post('/console/pair/'+id+'/revoke',{}).then(function(R){ if(R[0]) location.reload(); else alert('失败 HTTP '+R[2]); });
    });
  });
})();
`