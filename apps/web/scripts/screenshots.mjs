// Captures the main screens in both color schemes for design review and pull requests.
// Usage: node scripts/screenshots.mjs [baseUrl] [outDir]. Needs the dev server running.
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'

const base = process.argv[2] ?? 'http://localhost:5173'
const out = process.argv[3] ?? '.screenshots'
const album = '/album/00000000-0000-4000-8200-000000000001'
const artist = '/artist/00000000-0000-4000-8100-000000000001'

const shots = [
  { name: 'home', path: '/' },
  { name: 'album', path: album },
  { name: 'artist', path: artist },
  { name: 'search', path: '/search?q=soft', wait: 900 },
  { name: 'library-songs', path: '/library/songs' },
  { name: 'queue', path: album, click: 'Queue' },
  { name: 'now-playing', path: '/', click: 'Lyrics', wait: 600 },
  { name: 'playing-elsewhere', path: '/', devices: 'Living Room' },
  { name: 'admin', path: '/admin/library' },
  { name: 'kitchen-sink', path: '/dev/kitchen-sink', height: 6200 },
  { name: 'home', path: '/', width: 1024 },
  { name: 'album', path: album, width: 1024 },
  { name: 'home', path: '/', width: 390, height: 844 },
  { name: 'album', path: album, width: 390, height: 844 },
  { name: 'now-playing', path: '/', width: 390, height: 844, click: 'Open Now Playing, Night Swimming' },
  { name: 'login', path: '/login', width: 1024 },
]

await mkdir(out, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch())
for (const scheme of ['light', 'dark']) {
  for (const shot of shots) {
    const width = shot.width ?? 1440
    const page = await browser.newPage({ viewport: { width, height: shot.height ?? 900 }, colorScheme: scheme, deviceScaleFactor: 2 })
    await page.goto(base + shot.path)
    await page.waitForLoadState('networkidle')
    if (shot.click) await page.getByRole('button', { name: shot.click, exact: true }).first().click()
    if (shot.devices) {
      await page.getByRole('button', { name: 'Devices' }).first().click()
      await page.getByRole('button', { name: new RegExp(shot.devices) }).click()
    }
    await page.mouse.move(0, 0)
    await page.evaluate(() => document.activeElement?.blur())
    await page.waitForTimeout(shot.wait ?? 500)
    await page.screenshot({ path: `${out}/${shot.name}-${width}-${scheme}.png` })
    await page.close()
  }
}
await browser.close()
console.log(`Saved to ${out}`)
