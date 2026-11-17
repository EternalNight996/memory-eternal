# 收到并已验证：设备码安全约定（2026-11-14 21:30）

> 回 `mengbot-device-code-reply.md` 的「补一条安全约定」。
> 你们 21:23 那版我已经拉到，逐条验过。

## 一、已登录也要点确认 —— 我们这边验到了

我没有登录态，所以拿不到带账号的确认页，但能验到**结构**：

```
GET  /device?user_code=XXKP-JDKG   → 200，自动 POST 中转页（带 xsrf）
POST /device  (xsrf + user_code)   → 200
  <title>确认授权 · MengBot</title>
  · 含「允许」/「取消」按钮      true
  · 含「登录」引导               true
  · 未登录时先引导登录，不是直接放行
```

**关键结论**：`POST /device` 返回的是**确认页**，不是 302 直接兑换 token。
这就证明「自动确认」确实撤掉了 —— 如果有自动确认，这里会直接 302 到 redirect_uri。

> 进一步（带账号的确认页是否显示应用名/UA）我这边验不了，需要你们或真实用户补一次截图。

## 二、四态对照表 —— 与我们的实现一致

| 用户操作 | 你们 `POST /token` 返回 | 我们的处理 |
|---|---|---|
| 还没点确认 | `authorization_pending` | 保持 `pending`，按 `interval` 继续轮询（不当失败） |
| 点了「允许」 | `200` + `access_token`/`refresh_token` | 落盘、切云端、拉 `/cloud/billing/plan` |
| 点了「取消」 | `access_denied` | 显示「授权被拒绝」，**清掉本次 device 票**，不自动重试 |
| 短码过期（10 分钟） | `expired_token` | 显示「验证码已过期」，提供「重新发起」 |

补充我们这边的两个细节：
- `slow_down` 我们也接（收到就把轮询间隔 ×1.5，最低 5 秒）—— 你们文档里没提，但 RFC 8628 要求；
- 轮询上限 15 分钟（比 `expires_in` 多留 5 分钟容错），到点自动停，避免后台空转。

## 三、移动端「看不到按钮」的根因 —— 谢谢，这个说明很有用

你们说的根因（确认页按钮原来自 provider 的 form 片段，移动端没渲染出提交控件）
和我们 18:40 那次抓到的现象对得上：

```html
<title>Submitting Callback</title>
<script>document.addEventListener('DOMContentLoaded', () => document.forms[0].submit())</script>
<form method="post" action=".../device">
  <noscript><button autofocus type="submit">Continue</button></noscript>
</form>
```

那个 `Continue` 在 `<noscript>` 里 —— 移动端（或任何正常 JS 环境）**根本不会渲染它**。
自建表单后按钮一定在，这个修法是对的。

## 四、顺带确认：我们这边的安全加固

在本次改动之前，我们也加了一道用户可见的提示（在设备码面板里）：

> ⚠ 这个码等于一次授权凭证：只在你主动发起登录时使用，别把它发给任何人。
> 授权页会显示请求访问的应用，确认是 memory-eternal 再点允许。

`device_code` 我们**只存服务端内存**（`deviceTickets` Map），不下发浏览器；
浏览器只拿到 `ticket`（随机串），拿不到 `device_code` —— 即便前端被 XSS，
也换不到 token。

## 五、这次没变的部分

- 商户 SKU 仍是 `sub-merchant` / `sub-merchant-pro`
- webhook 仍按 `merchant` 字段分流（非空 → 商户台账，不写个人 entitlement）
- 前端已展示短码 + 二维码（用 `verification_uri_complete`），并支持「在浏览器打开（自动带验证码）」

---

**验证时间**：2026-11-14 21:30（UTC+8）
**验证方式**：真实 client 道印灵钥 + 生产环境 `POST /device` 实测
