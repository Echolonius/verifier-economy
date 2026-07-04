/**
 * Render deck.html → deck.pdf (one 1280x720 page per slide) + per-slide PNGs for the video.
 *   NODE_PATH=~/.config/agent-wallet/node_modules node deck/render.cjs [outdir-for-pngs]
 */
const { chromium } = require('playwright')
const path = require('path')

const HERE = __dirname
const PNG_DIR = process.argv[2] || HERE

;(async () => {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  await page.goto('file://' + path.join(HERE, 'deck.html'))
  await page.waitForTimeout(500)

  const slides = page.locator('section.slide')
  const n = await slides.count()
  for (let i = 0; i < n; i++) {
    const out = path.join(PNG_DIR, `slide${i + 1}.png`)
    await slides.nth(i).screenshot({ path: out })
    console.log('png:', out)
  }

  await page.pdf({
    path: path.join(HERE, 'deck.pdf'),
    width: '1280px',
    height: '720px',
    printBackground: true,
    pageRanges: `1-${n}`,
  })
  console.log('pdf:', path.join(HERE, 'deck.pdf'), `(${n} slides)`)
  await browser.close()
})().catch((e) => { console.error(e); process.exit(1) })
