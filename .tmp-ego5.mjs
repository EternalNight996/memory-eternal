const task = await taskSpaces.useOrCreate('probe heading inside root');
await browser.openOrReuseTab('http://127.0.0.1:7999/', { wait: true, timeout: 20000 });
await page.evaluate(() => { localStorage.setItem('me-skin','spider') });
await page.reload(); await page.waitForTimeout(2500);
const res = await page.evaluate(() => {
  const root = document.querySelector('.memory-eternal-root') || document.body;
  const host = document.createElement('div');
  host.className = 'me-reader-dialog';
  host.innerHTML = '<div class="me-dialog-body"><div class="md-doc">' +
    '<div class="md-h md-h-h1 md-c-info"><span class="md-ico">✨</span><span class="md-hx">问题一 注册入口失效</span></div>' +
    '<div class="md-h md-h-h2 md-c-warn"><span class="md-ico">✨</span><span class="md-hx">问题二 授权页缺 cookie</span></div>' +
    '<div class="md-h md-h-h1"><span class="md-ico">✨</span><span class="md-hx">无 tone 的 h1</span></div>' +
  '</div></div>';
  root.appendChild(host);
  const out = Array.from(host.querySelectorAll('.md-h')).map(h => { const s = getComputedStyle(h); const hx = h.querySelector('.md-hx'); return { cls: h.className, color: s.color, bg: s.backgroundColor, hx: getComputedStyle(hx).color }; });
  host.remove();
  return { skin: root.getAttribute('data-skin'), out };
});
console.log(JSON.stringify(res));
await taskSpaces.complete(task.id, { keep: false });