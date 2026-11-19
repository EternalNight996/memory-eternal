// 支付页脚本：选套餐 → 下单 → 扫码 → 轮询到账
export const PAY_JS = String.raw`
(function(){
  var API='/api';
  var BOOT=window.__ME_PAY__||{};
  var state={sku:'',channel:'native',orderId:'',timer:null};
  function $(id){return document.getElementById(id);}
  function show(id,msg,cls){var b=$(id);if(!b)return;b.className=cls||'sub';b.textContent=msg;}
  var period='month';
  function skuFor(base){
    if(period==='month') return base;
    return base+'-'+(period==='half'?'half':'year');
  }
  document.querySelectorAll('[data-period]').forEach(function(b){
    b.addEventListener('click',function(){
      period=b.getAttribute('data-period');
      document.querySelectorAll('[data-period]').forEach(function(x){x.classList.toggle('on',x===b)});
      document.querySelectorAll('.plan').forEach(function(c){
        var base=c.getAttribute('data-sku');
        c.setAttribute('data-real',skuFor(base));
      });
    });
  });
  document.querySelectorAll('.plan').forEach(function(c){
    c.setAttribute('data-real',skuFor(c.getAttribute('data-sku')));
    c.addEventListener('click',function(){
      document.querySelectorAll('.plan').forEach(function(x){x.classList.toggle('on',x===c)});
      state.sku=c.getAttribute('data-real');
      $('paybox').style.display='block';
      $('paytitle').textContent=c.querySelector('.n').textContent+' · '+c.querySelector('.p').textContent.replace('/月','');
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
        if(d.code==='pay_unconfigured'){ show('paystate','支付通道未配置，请联系管理员手动开通'); return; }
        show('paystate', d.error || ('创建订单失败 HTTP '+R[2]));
      }).catch(function(e){ go.disabled=false; show('paystate','网络错误：'+e.message); });
  });
})();
`