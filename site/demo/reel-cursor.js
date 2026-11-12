(() => {
  if (document.getElementById('me-demo-cursor')) return
  const c = document.createElement('div')
  c.id = 'me-demo-cursor'
  Object.assign(c.style, {
    position: 'fixed', zIndex: '99999', left: '0px', top: '0px', width: '14px', height: '14px',
    borderRadius: '50%', background: '#ff7a45', pointerEvents: 'none',
    boxShadow: '0 0 0 5px rgba(255,122,69,.18), 0 5px 14px rgba(0,0,0,.45)',
    transform: 'translate(-50%, -50%) scale(1)',
    transition: 'left .42s cubic-bezier(.22,.61,.36,1), top .42s cubic-bezier(.22,.61,.36,1), transform .12s ease',
  })
  document.body.appendChild(c)
  window.__reelMove = (selector) => {
    const el = document.querySelector(selector)
    if (!el) return null
    const r = el.getBoundingClientRect()
    c.style.left = (r.left + r.width / 2) + 'px'
    c.style.top = (r.top + r.height / 2) + 'px'
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }
  window.__reelClick = (selector) => {
    const el = document.querySelector(selector)
    if (!el) return false
    c.style.transform = 'translate(-50%, -50%) scale(.68)'
    setTimeout(() => { c.style.transform = 'translate(-50%, -50%) scale(1)' }, 130)
    el.click()
    return true
  }
  window.__reelFindCard = (text) => {
    const cards = [...document.querySelectorAll('.card')]
    const hit = cards.find((el) => el.innerText.includes(text))
    if (!hit) return false
    const r = hit.getBoundingClientRect()
    c.style.left = (r.left + r.width / 2) + 'px'
    c.style.top = (r.top + Math.min(36, r.height / 2)) + 'px'
    setTimeout(() => {
      c.style.transform = 'translate(-50%, -50%) scale(.68)'
      setTimeout(() => { c.style.transform = 'translate(-50%, -50%) scale(1)' }, 130)
      hit.click()
    }, 420)
    return true
  }
})()
