const task = await taskSpaces.useOrCreate('open reader and inspect heading');
await browser.openOrReuseTab('http://127.0.0.1:7999/', { wait: true, timeout: 20000 });
await page.evaluate(() => { localStorage.setItem('me-onboarded-v2','1'); localStorage.setItem('me-skin','spider'); });
await page.reload(); await page.waitForTimeout(2500);
const dom = await page.evaluate(() => ({
  cards: Array.from(document.querySelectorAll('[class*=card]')).slice(0,8).map(e=>e.className),
  skin: document.querySelector('[data-skin]') ? document.querySelector('[data-skin]').getAttribute('data-skin') : null,
  dark: window.matchMedia('(prefers-color-scheme: dark)').matches,
}));
console.log(JSON.stringify(dom));
const cardSel = '.mc-card, .mc-cardrow, .mc-v5-card';
const n = await page.locator(cardSel).count();
console.log('card count', n);
if (n) { await page.locator(cardSel).first().click(); await page.waitForTimeout(1500); }
const hasDlg = await page.locator('.me-reader-dialog').count();
console.log('dialog', hasDlg);
if (!hasDlg && n) { await page.locator(cardSel).first().dblclick(); await page.waitForTimeout(1500); }
const hasDlg2 = await page.locator('.me-reader-dialog').count();
const heads = await page.evaluate(() => Array.from(document.querySelectorAll('.md-h')).slice(0,6).map(h => ({ cls: h.className, color: getComputedStyle(h).color, bg: getComputedStyle(h).backgroundColor })));
console.log(JSON.stringify({ hasDlg2, heads }));
await taskSpaces.complete(task.id, { keep: false });