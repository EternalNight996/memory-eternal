const task = await taskSpaces.useOrCreate('probe heading cascade');
await browser.openOrReuseTab('http://127.0.0.1:7999/', { wait: true, timeout: 20000 });
await page.waitForTimeout(1500);
const res = await page.evaluate(() => {
  const host = document.createElement('div');
  host.setAttribute('data-skin','spider');
  host.innerHTML = '<div class="me-reader-dialog"><div class="me-dialog-body"><div class="md-doc">' +
    '<div class="md-h md-h-h1 md-c-info"><span class="md-ico">✨</span><span class="md-hx">问题一 注册入口失效</span></div>' +
    '<div class="md-h md-h-h2 md-c-warn"><span class="md-ico">✨</span><span class="md-hx">问题二 授权页</span></div>' +
  '</div></div></div>';
  document.body.appendChild(host);
  const out = Array.from(host.querySelectorAll('.md-h')).map(h => ({ cls: h.className, color: getComputedStyle(h).color, bg: getComputedStyle(h).backgroundColor }));
  host.remove();
  return out;
});
console.log(JSON.stringify(res));
await taskSpaces.complete(task.id, { keep: false });