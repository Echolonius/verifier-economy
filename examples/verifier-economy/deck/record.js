/**
 * Demo recorder — captures the live dashboard while `npm run demo` runs, for the 3-minute video.
 * Run from ~/.config/agent-wallet (where playwright is installed):
 *   node ~/solana_coralOS/examples/verifier-economy/deck/record.js
 * Produces deck/raw-dashboard.webm; assemble the final cut with ffmpeg (captions + trims).
 * Assumes: dashboard served on :3021 (npm run web) and the demo about to start / running.
 */
const { chromium } = require('playwright')
const path = require('path')

const OUT = path.join(__dirname)
const DURATION_MS = Number(process.env.RECORD_MS || 150_000)

;(async () => {
  const browser = await chromium.launch()
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: OUT, size: { width: 1280, height: 720 } },
  })
  const page = await ctx.newPage()
  await page.goto('http://localhost:3021')
  console.log(`recording ${DURATION_MS / 1000}s of the dashboard…`)
  await page.waitForTimeout(DURATION_MS)
  await ctx.close() // flushes the video
  const video = await page.video().path()
  console.log('raw video:', video)
  await browser.close()
})().catch((e) => { console.error(e); process.exit(1) })
