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
  // 手动模式的收款码切换
  var qrTab = 'wechat';
  document.querySelectorAll('[data-qr]').forEach(function(b){
    b.addEventListener('click',function(){
      qrTab = b.getAttribute('data-qr');
      document.querySelectorAll('[data-qr]').forEach(function(x){ x.classList.toggle('on', x === b) });
      var q = (BOOT.qr || {})[qrTab];
      var img = $('qrimg');
      if (img) img.innerHTML = q ? '<img alt="" src="' + q + '">' : '';
    });
  });
  function showManualQr(){
    var q = (BOOT.qr || {})[qrTab] || (BOOT.qr || {}).wechat || (BOOT.qr || {}).alipay || '';
    var img = $('qrimg');
    if (img) img.innerHTML = q ? '<img alt="" src="' + q + '">' : '<div style="color:#8b949e;font-size:12px;padding:20px;text-align:center">管理员未上传收款码</div>';
    show('paystate', '扫码转账 ¥' + (state.price || '') + '，然后点下方按钮提交');
  }
  var go=$('paygo');
  if(go) go.addEventListener('click',function(){
    if(!state.sku){ show('paystate','请先选择套餐'); return; }
    // 收款码在页面加载时就已经显示（见末尾 boot），这里点击**直接提交订单**。
    // 以前这里用 state.orderId='__showqr__' 做"第一次点显示图、第二次才提交"，
    // 结果是加载后图片区域一片空白，用户必须先点一下才看得到码。
    if (state.orderId) { show('paystate','订单已提交（' + state.orderId + '），请等待管理员确认'); return; }
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

  // ── 初始化：?sku= 预选套餐；autoOpen 时自动展开二维码 ──
  (function initFromQuery(){
    var want = String(BOOT.sku || '').trim().toLowerCase();
    if (!want) {
      try { want = String(new URLSearchParams(location.search).get('sku') || '').trim().toLowerCase() } catch(e){}
    }
    if (!want) return;
    // 解析周期（sub-personal / sub-personal-half / sub-personal-year）
    var per = 'month', base = want;
    if (want.slice(-5) === '-half') { per = 'half'; base = want.slice(0, -5) }
    else if (want.slice(-5) === '-year') { per = 'year'; base = want.slice(0, -5) }
    period = per;
    document.querySelectorAll('[data-period]').forEach(function(x){ x.classList.toggle('on', x.getAttribute('data-period') === per) });
    applyPeriod();
    // 选中对应卡片
    var card = document.querySelector('.plan[data-sku="' + base + '"]');
    if (!card) return;
    document.querySelectorAll('.plan').forEach(function(x){ x.classList.toggle('on', x === card) });
    state.sku = card.getAttribute('data-real') || want;
    var box = $('paybox'); if (box) box.style.display = 'block';
    var nm = card.querySelector('.n'), pr = card.querySelector('[data-price]'), un = card.querySelector('[data-unit]');
    if ($('paytitle') && nm) $('paytitle').textContent = nm.textContent + (pr && un ? ' · ' + pr.textContent + un.textContent : '');
    // 自动展开：手动模式直接显示收款码（不经过点击），
    // XORPAY 模式才需要点「生成二维码」去下单拿码。
    if (BOOT.mode === 'manual') {
      setTimeout(function(){ try { showManualQr() } catch (e) {} }, 30)
    } else if (BOOT.autoOpen) {
      var g = $('paygo');
      if (g) setTimeout(function(){ g.click() }, 60);
    } else if ($('paystate')) {
      show('paystate','点「生成二维码」开始支付');
    }
  })();
  // 兜底：没有 ?sku= 时也要把收款码显示出来（用户从控制台点进来直接看页面）
  if (BOOT.mode === 'manual') {
    setTimeout(function(){
      var img = $('qrimg')
      if (img && !img.innerHTML.trim()) {
        try {
          var q = (BOOT.qr || {}).wechat || (BOOT.qr || {}).alipay || ''
          img.innerHTML = q ? '<img alt="" src="' + q + '">' : '<div style="color:#8b949e;font-size:12px;padding:20px;text-align:center">管理员未上传收款码</div>'
        } catch (e) {}
      }
    }, 220)
  }
})();
`