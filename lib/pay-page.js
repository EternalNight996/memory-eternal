// 支付页（/pay）：套餐选择 → 下单 → 扫码 → 轮询到账。
// 视觉沿用登录页的双栏语言（左品牌 + 右内容），与 /console 一致。
import { shell } from './cloud-admin-ui.js'

const PAY_CSS = [
  '.pay{max-width:920px;margin:0 auto;padding:34px 20px 70px}',
  '.pay h1{font-size:22px;margin:0 0 4px}',
  '.pay .sub{margin:0 0 22px;opacity:.55;font-size:13px}',
  '.plans{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;margin-bottom:18px}',
  '.plan{background:#161b22;border:1px solid #232a33;border-radius:12px;padding:18px;cursor:pointer;transition:border-color .15s,transform .15s}',
  '.plan:hover{border-color:#2f6feb}',
  '.plan.on{border-color:#2f6feb;box-shadow:0 0 0 3px rgba(47,111,235,.15)}',
  '.plan .n{font-size:15px;margin-bottom:2px}',
  '.plan .p{font-size:26px;font-weight:600;margin:8px 0 2px}',
  '.plan .p small{font-size:12px;font-weight:400;opacity:.5}',
  '.plan ul{list-style:none;padding:0;margin:12px 0 0;font-size:12.5px;color:#a9b4c2;display:flex;flex-direction:column;gap:6px}',
  '.plan li:before{content:"·";color:#2f6feb;margin-right:8px;font-weight:700}',
  '.periods{display:flex;gap:6px;margin-bottom:16px}',
  '.periods button{padding:7px 14px;border-radius:8px;border:1px solid #2a323d;background:transparent;color:#8b949e;font-size:12.5px;cursor:pointer}',
  '.periods button.on{border-color:#2f6feb;color:#e6e9ef;background:#1f6feb22}',
  '.box{background:#161b22;border:1px solid #232a33;border-radius:12px;padding:20px;margin-top:16px}',
  '.qr{width:200px;height:200px;background:#fff;border-radius:10px;display:flex;align-items:center;justify-content:center;overflow:hidden}',
  '.qr img{width:100%;height:100%}',
  '.row{display:flex;gap:14px;align-items:center;flex-wrap:wrap}',
  '.tabs2{display:flex;gap:6px}',
  '.tabs2 button{padding:6px 12px;border-radius:8px;border:1px solid #2a323d;background:transparent;color:#8b949e;font-size:12px;cursor:pointer}',
  '.tabs2 button.on{border-color:#2f6feb;color:#e6e9ef}',
  '.foot{margin-top:20px;font-size:12px;color:#8b949e;text-align:center}',
].join('')

export function payPage(opts = {}) {
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>\"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  const plans = Array.isArray(opts.plans) ? opts.plans : []
  const user = opts.user || {}
  const ready = !!opts.payReady
  const note = ready ? '' : '<div class="box" style="border-color:#7a5c1a"><b style="color:#d29922">支付通道未配置</b><div class="sub" style="margin:6px 0 0">当前只能由管理员手动开通。配好 XORPAY_AID / XORPAY_SECRET / XORPAY_NOTIFY_URL 后即可自动收款。</div></div>'
  const cards = plans.map((p) => {
    const caps = p.caps || {}
    if (!p.open) {
      // 未开放的档位照样展示，但点不动 —— 让用户知道后面还有，而不是以为只有个人版
      return '<div class="plan" style="opacity:.45;cursor:not-allowed" data-locked="1">'
        + '<div class="n">' + esc(p.name) + ' <span style="font-size:11px;opacity:.7">即将开放</span></div>'
        + '<div class="p">¥' + esc(p.price) + '<small>/月</small></div>'
        + '<ul><li>卡片 ' + esc(caps.cards) + ' 张</li><li>速率 ' + esc(caps.rpm) + ' 次/分</li><li>记忆库 ' + esc(caps.vaults) + ' 个</li></ul>'
        + '</div>'
    }
    return '<div class="plan" data-sku="' + esc(p.sku) + '">'
      + '<div class="n">' + esc(p.name) + '</div>'
      + '<div class="p">¥' + esc(p.price) + '<small>/月</small></div>'
      + '<ul><li>卡片 ' + esc(caps.cards) + ' 张</li><li>速率 ' + esc(caps.rpm) + ' 次/分</li><li>记忆库 ' + esc(caps.vaults) + ' 个</li></ul>'
      + '</div>'
  }).join('')
  const body = [
    '<style>' + PAY_CSS + '</style>',
    '<div class="pay">',
    '<div class="row" style="justify-content:space-between">',
    '<div><h1>订阅记忆云</h1><div class="sub">' + esc(user.email || '') + (user.email ? ' · ' : '') + '按月订阅，随时可续；提前续费自动累加到现有到期日之后</div></div>',
    '<a href="/api/console">← 返回控制台</a>',
    '</div>',
    note,
    '<div class="periods"><button data-period="month" class="on">月付</button><button data-period="half">半年</button><button data-period="year">年付</button></div>',
    '<div class="plans">' + cards + '</div>',
    '<div class="box" id="paybox" style="display:none">',
    '<div class="row"><div class="qr" id="qrimg"></div>',
    '<div style="flex:1;min-width:220px">',
    '<div id="paytitle" style="font-size:15px;margin-bottom:6px"></div>',
    '<div class="sub" id="paystate" style="margin-bottom:10px">选择支付方式后扫码</div>',
    '<div class="tabs2" style="margin-bottom:10px"><button data-channel="native" class="on">微信扫码</button><button data-channel="alipay">支付宝</button></div>',
    '<button class="btn" id="paygo" type="button" style="width:auto;padding:9px 18px">生成二维码</button>',
    '</div></div></div>',
    '<div class="foot"><a href="/api/console">控制台</a> · <a href="/api/me">我的账号</a></div>',
    '</div>',
    '<script>window.__ME_PAY__=' + JSON.stringify({ ready, plans }) + ';</script>',
    '<script src="/api/pay.js"></script>',
  ].join('')
  return shell('记忆云 · 订阅', body)
}