// 支付页（/pay）：配置驱动（照 MengBot 的 subscribe-views.json 结构）。
//   views[active] = { title, subtitle, hint, plans[], periodPlans{half,year}, periods[] }
// 页面只负责渲染，改文案/开放档位改 JSON 即可。
import { shell } from './cloud-admin-ui.js'

const PAY_CSS = [
  '.pay{max-width:1000px;margin:0 auto;padding:34px 20px 70px}',
  '.pay .head{text-align:center;margin-bottom:26px}',
  '.pay h1{font-size:26px;margin:0 0 8px;letter-spacing:.01em}',
  '.pay .subtitle{color:#a9b4c2;font-size:13.5px;margin:0 0 8px}',
  '.pay .hint{color:#8b949e;font-size:12.5px;margin:0}',
  '.periods{display:flex;justify-content:center;gap:8px;margin-bottom:22px}',
  '.periods button{padding:8px 18px;border-radius:9px;border:1px solid #2a323d;background:transparent;color:#8b949e;font-size:13px;cursor:pointer;transition:.15s}',
  '.periods button.on{border-color:#2f6feb;color:#e6e9ef;background:#1f6feb22}',
  '.plans{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}',
  '.plan{position:relative;background:#161b22;border:1px solid #232a33;border-radius:14px;padding:22px;cursor:pointer;transition:border-color .15s,transform .15s}',
  '.plan:hover{border-color:#3b7bf5;transform:translateY(-1px)}',
  '.plan.on{border-color:#2f6feb;box-shadow:0 0 0 3px rgba(47,111,235,.16)}',
  '.plan.locked{opacity:.42;cursor:not-allowed}',
  '.plan.locked:hover{border-color:#232a33;transform:none}',
  '.plan .badge{position:absolute;top:14px;right:14px;font-size:11px;padding:2px 8px;border-radius:20px;background:#2f6feb22;color:#6ea8fe}',
  '.plan .n{font-size:15px;margin-bottom:4px}',
  '.plan .p{display:flex;align-items:baseline;gap:4px;margin:12px 0 4px}',
  '.plan .p b{font-size:30px;font-weight:600}',
  '.plan .p small{font-size:12px;color:#8b949e}',
  '.plan .permonth{font-size:11.5px;color:#8b949e;margin-bottom:14px}',
  '.plan ul{list-style:none;padding:0;margin:0;font-size:12.5px;color:#a9b4c2;display:flex;flex-direction:column;gap:8px}',
  '.plan li{display:flex;align-items:center;gap:8px}',
  '.plan li:before{content:"✓";color:#3fb950;font-size:11px}',
  '.box{background:#161b22;border:1px solid #232a33;border-radius:14px;padding:22px;margin-top:18px}',
  '.qrwrap{display:flex;gap:20px;align-items:center;flex-wrap:wrap}',
  '.qr{width:196px;height:196px;background:#fff;border-radius:12px;display:flex;align-items:center;justify-content:center;overflow:hidden;flex:none}',
  '.qr img{width:100%;height:100%}',
  '.qrside{flex:1;min-width:220px}',
  '.tabs2{display:flex;gap:6px;margin:10px 0 12px}',
  '.tabs2 button{padding:7px 14px;border-radius:8px;border:1px solid #2a323d;background:transparent;color:#8b949e;font-size:12.5px;cursor:pointer}',
  '.tabs2 button.on{border-color:#2f6feb;color:#e6e9ef}',
  '.warn{background:#7a5c1a22;border:1px solid #7a5c1a;color:#d29922;border-radius:10px;padding:12px 14px;font-size:12.5px;margin-bottom:16px}',
  '.foot{margin-top:24px;font-size:12px;color:#8b949e;text-align:center}',
].join('')

export function payPage(opts = {}) {
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>\"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  const view = opts.view || {}
  const plans = Array.isArray(opts.plans) ? opts.plans : []
  const periods = Array.isArray(view.periods) && view.periods.length
    ? view.periods
    : [{ key: 'month', label: '月付', suffix: '' }, { key: 'half', label: '半年', suffix: '-half' }, { key: 'year', label: '年付', suffix: '-year' }]
  const user = opts.user || {}
  const ready = !!opts.payReady
  const periodBtn = (p, i) => '<button data-period="' + esc(p.key) + '"' + (i === 0 ? ' class="on"' : '') + '>' + esc(p.label) + '</button>'
  const cards = plans.map((p) => {
    const caps = p.caps || {}
    const locked = !p.open
    return '<div class="plan' + (locked ? ' locked' : '') + '" ' + (locked ? 'data-locked="1"' : ('data-sku="' + esc(p.sku) + '"')) + '>'
      + (locked ? '<span class="badge">即将开放</span>' : '')
      + '<div class="n">' + esc(p.name) + '</div>'
      + '<div class="p"><b data-price>¥' + esc(p.price) + '</b><small data-unit>/月</small></div>'
      + '<div class="permonth" data-permonth>按月付费，随时可停</div>'
      + '<ul>'
      + '<li>卡片 ' + esc(caps.cards) + ' 张</li>'
      + '<li>请求速率 ' + esc(caps.rpm) + ' 次/分</li>'
      + '<li>记忆库 ' + esc(caps.vaults) + ' 个</li>'
      + '<li>' + (p.tier === 'personal' ? '单账号使用' : '团队协作') + '</li>'
      + '</ul></div>'
  }).join('')
  const body = [
    '<style>' + PAY_CSS + '</style>',
    '<div class="pay">',
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">',
    '<a href="/api/console">← 返回控制台</a>',
    '<span style="font-size:12.5px;color:#8b949e">' + esc(user.email || '') + '</span>',
    '</div>',
    '<div class="head">',
    '<h1>' + esc(view.title || '订阅记忆云') + '</h1>',
    '<p class="subtitle">' + esc(view.subtitle || '') + '</p>',
    '<p class="hint">' + esc(view.hint || '') + '</p>',
    '</div>',
    ready ? '' : '<div class="warn"><b>支付通道未配置</b> · 下单后会先生成订单，由管理员在 <a href="/api/admin/orders">订单管理</a> 里确认收款后立即生效。</div>',
    '<div class="periods">' + periods.map(periodBtn).join('') + '</div>',
    '<div class="plans">' + cards + '</div>',
    // 支付通道没配置时**不要渲染二维码区**：一个空白白框 + 点了就报错的按钮，
    // 比没有更糟。改成一条明确的「下单后由管理员确认收款」的说明。
    ready
      ? '<div class="box" id="paybox" style="display:none">'
        + '<div class="qrwrap"><div class="qr" id="qrimg"></div><div class="qrside">'
        + '<div id="paytitle" style="font-size:16px;margin-bottom:6px"></div>'
        + '<div class="sub" id="paystate" style="color:#8b949e;font-size:12.5px;margin-bottom:12px">选择支付方式后生成二维码</div>'
        + '<div class="tabs2"><button data-channel="native" class="on">微信扫码</button><button data-channel="alipay">支付宝</button></div>'
        + '<button class="btn" id="paygo" type="button" style="width:auto;padding:10px 20px">生成二维码</button>'
        + '</div></div></div>'
      : '<div class="box" id="paybox" style="display:none">'
        + '<div id="paytitle" style="font-size:16px;margin-bottom:6px"></div>'
        + '<div class="sub" id="paystate" style="color:#8b949e;font-size:12.5px;margin-bottom:12px"></div>'
        + '<button class="btn" id="paygo" type="button" style="width:auto;padding:10px 20px">提交开通申请</button>'
        + '<div class="sub" style="margin-top:10px;color:#8b949e;font-size:12px">提交后会生成一笔订单，管理员在「订单管理」里确认收款后订阅立即生效。</div>'
        + '</div>',
    '<div class="foot"><a href="/api/console">控制台</a> · <a href="/api/me">我的账号</a> · <a href="/api/orders">我的订单</a></div>',
    '</div>',
    '<script>window.__ME_PAY__=' + JSON.stringify({ ready, periods, plans }) + ';</script>',
    '<script src="/api/pay.js"></script>',
  ].join('')
  return shell(view.title || '记忆云 · 订阅', body)
}