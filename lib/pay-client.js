// 支付页脚本：选套餐 → 下单 → 扫码 → 轮询到账
export const PAY_JS = String.raw`
(function(){
  var API='/api';
  var BOOT=window.__ME_PAY__||{};
  var state={sku:'',channel:'native',orderId:'',timer:null};
  function $(id){return document.getElementById(id);}
  function show(id,msg,cls){var b=$(id);if(!b)return;b.className=cls||'sub';b.textContent=msg;}
  var period='month';
  var PERIOD_SUFFIX={month:'',half:'-half',year:'-year'};
  // 周期切换：同时更新价格与单位（数据来自 BOOT.plans，不从 DOM 反推）
  function priceOf(sku){
    var all=[]; for(var i=0;i<(BOOT.plans||[]).length;i++){ all.push(BOOT.plans[i]); (BOOT.plans[i].periods||[]).forEach(function(p){all.push(p)}) }
    for(var j=0;j<all.length;j++){ if(all[j].sku===sku) return all[j] }
    return null
  }
  function applyPeriod(){
    var suffix = period==='month' ? '' : (period==='half' ? '-half' : '-year');
    var unit = period==='month' ? '/月' : (period==='half' ? '/半年' : '/年');
    document.querySelectorAll('.plan').forEach(function(c){
      if(c.getAttribute('data-locked')) return;
      var real=c.getAttribute('data-sku')+suffix;
      c.setAttribute('data-real',real);
      var p=priceOf(real);
      if(p){
        var bp=c.querySelector('[data-price]'), up=c.querySelector('[data-unit]'), pm=c.querySelector('[data-permonth]');
        if(bp) bp.textContent='¥'+p.price;
        if(up) up.textContent=unit;
        if(pm) pm.textContent = period==='month' ? '按月付费，随时可停' : ('折合 ¥'+(p.price/(p.days/30)).toFixed(2)+'/月');
      }
    });
  }
  document.querySelectorAll('[data-period]').forEach(function(b){
    b.addEventListener('click',function(){
      period=b.getAttribute('data-period');
      document.querySelectorAll('[data-period]').forEach(function(x){x.classList.toggle('on',x===b)});
      applyPeriod();
    });
  });
  applyPeriod();   // 首屏按当前周期（默认月付）填充 data-real / 价格 / 单位
  document.querySelectorAll('.plan').forEach(function(c){
    if(c.getAttribute('data-locked')) return;   // 未开放档位点不动
    c.addEventListener('click',function(){
      document.querySelectorAll('.plan').forEach(function(x){x.classList.toggle('on',x===c)});
      state.sku=c.getAttribute('data-real');
      $('paybox').style.display='block';
      var nm=c.querySelector('.n').textContent, pr=c.querySelector('[data-price]'), un=c.querySelector('[data-unit]');
      $('paytitle').textContent=nm+(pr&&un?(' · '+pr.textContent+un.textContent):'');
      show('paystate','选择支付方式后点「生成二维码」');
    });
  });
  document.querySelectorAll('[data-channel]').forEach(function(b){
    b.addEventListener('click',function(){
      state.channel=b.getAttribute('data-channel');
      document.querySelectorAll('[data-channel]').forEach(function(x){x.classList.toggle('on',x===b)});
    });
  });
  function stopPoll(){ if(state.timer){clearInterval(state.timer);state.timer=null;} }
  function poll(){
    if(!state.orderId) return;
    fetch(API+'/pay/order/'+encodeURIComponent(state.orderId))
      .then(function(r){return r.json().catch(function(){return{}});})
      .then(function(d){
        if(d && d.status==='paid'){ stopPoll(); show('paystate','支付成功，正在跳转…'); setTimeout(function(){location.href=API+'/console';},800); }
      }).catch(function(){});
  }
  // 模拟支付：联调用。会真实写库 + 推送通知，和真实支付走同一条订单链路。
  var sim=$('paysim');
  if(sim) sim.addEventListener('click',function(){
    if(!state.orderId){ show('paystate','请先提交开通申请'); return; }
    sim.disabled=true; show('paystate','正在模拟支付…');
    fetch(API+'/pay/order/'+encodeURIComponent(state.orderId)+'/simulate',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})
      .then(function(r){return r.json().catch(function(){return{}})})
      .then(function(d){
        sim.disabled=false;
        if(d&&d.ok){ show('paystate','模拟支付成功，正在跳转…'); setTimeout(function(){location.href=API+'/orders';},900); }
        else show('paystate',(d&&d.error)||'模拟支付失败');
      }).catch(function(e){ sim.disabled=false; show('paystate','网络错误：'+e.message); });
  });
  var go=$('paygo');
  if(go) go.addEventListener('click',function(){
    if(!state.sku){ show('paystate','请先选择套餐'); return; }
    go.disabled=true; show('paystate','正在创建订单…');
    fetch(API+'/pay/order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sku:state.sku,channel:state.channel})})
      .then(function(r){return r.json().catch(function(){return{}}).then(function(d){return [r.ok,d,r.status];});})
      .then(function(R){
        go.disabled=false;
        var d=R[1]||{};
        if(R[0] && d.ok && d.qr){
          state.orderId=d.orderId;
          $('qrimg').innerHTML='<img alt=qr src="'+API+'/cloud/auth/qr?d='+encodeURIComponent(d.qr)+'">';
          show('paystate','请用'+(state.channel==='alipay'?'支付宝':'微信')+'扫码支付');
          stopPoll(); state.timer=setInterval(poll,3000);
          return;
        }
        if(d.code==='pay_unconfigured'){
          show('paystate','已提交开通申请，订单号 '+(d.orderId||'')+'。请联系管理员确认收款，确认后立即生效。');
          return;
        }
        show('paystate', d.error || ('创建订单失败 HTTP '+R[2]));
      }).catch(function(e){ go.disabled=false; show('paystate','网络错误：'+e.message); });
  });
})();
`