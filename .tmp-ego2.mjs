const task = await taskSpaces.useOrCreate('inspect heading color');
await browser.openOrReuseTab('http://127.0.0.1:7999/', { wait: true, timeout: 20000 });
await page.evaluate(() => { localStorage.setItem('me-onboarded-v2','1'); localStorage.setItem('me-skin','spider'); });
await page.reload(); await page.waitForTimeout(3000);
const hasCards = await page.locator('article, .mc-card, .mc-v5-card, .mc-cardrow').count();
console.log('cards:', hasCards);
if (hasCards > 0) { await page.locator('article, .mc-card, .mc-v5-card, .mc-cardrow').first().click(); }
await page.waitForTimeout(2000);
const info = await page.evaluate(() => {
  const dlg = document.querySelector('.me-reader-dialog') || document.body;
  const h = dlg.querySelector('.md-doc .md-h');
  if (!h) return { none: true, html: (document.querySelector('.md-doc')||{}).outerHTML ? document.querySelector('.md-doc').outerHTML.slice(0,300) : '' };
  const st = getComputedStyle(h);
  const hx = h.querySelector('.md-hx');
  return { cls: h.className, color: st.color, bg: st.backgroundColor, skin: (document.querySelector('[data-skin]')||{}).getAttribute ? document.querySelector('[data-skin]').getAttribute('data-skin') : '', hxColor: hx ? getComputedStyle(hx).color : null };
});
console.log(JSON.stringify(info));
await taskSpaces.complete(task.id, { keep: false });