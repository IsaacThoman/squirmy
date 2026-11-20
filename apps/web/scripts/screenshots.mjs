// Captures the main screens in both color schemes for design review and pull requests.
// Usage: SQUIRMY_USER=admin SQUIRMY_PASSWORD=… node scripts/screenshots.mjs [baseUrl] [outDir]
// Needs the dev server in front of a running server. On a server that is not set up yet it
// also captures the setup wizard, creating the admin from SQUIRMY_USER and SQUIRMY_PASSWORD.
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'

const base = process.argv[2] ?? 'http://localhost:5173'
const out = process.argv[3] ?? '.screenshots'
const credentials = { username: process.env.SQUIRMY_USER ?? 'admin', password: process.env.SQUIRMY_PASSWORD ?? 'correct horse battery' }
const album = '/album/00000000-0000-4000-8200-000000000001'
const artist = '/artist/00000000-0000-4000-8100-000000000001'
const headers = { 'X-Squirmy-Client': 'web', 'X-Squirmy-Request': '1' }

const shots = [
  { name: 'home', path: '/' },
  { name: 'album', path: album },
  { name: 'artist', path: artist },
  { name: 'search', path: '/search?q=soft', wait: 900 },
  { name: 'library-songs', path: '/library/songs' },
  { name: 'queue', path: album, click: 'Queue' },
  { name: 'now-playing', path: '/', click: 'Lyrics', wait: 600 },
  { name: 'playing-elsewhere', path: '/', devices: 'Living Room' },
  { name: 'settings', path: '/settings' },
  { name: 'app-password', path: '/settings', create: 'Car stereo' },
  { name: 'admin-users', path: '/admin/users' },
  { name: 'admin-invite', path: '/admin/users', click: 'Invite someone', then: 'Create invite' },
  { name: 'admin-settings', path: '/admin/settings', height: 1500 },
  { name: 'admin-jobs', path: '/admin/jobs' },
  { name: 'admin-library', path: '/admin/library' },
  { name: 'admin-add-folder', path: '/admin/library', click: 'Add folder' },
  { name: 'admin-reviews', path: '/admin/reviews', review: true, height: 1400 },
  { name: 'admin-fix-match', path: '/admin/library', click: 'Fix a match', find: 'Abbey Road', wait: 1000 },
  { name: 'admin-organize', path: '/admin/organize', height: 1300 },
  { name: 'admin-search-index', path: '/admin/search-index' },
  { name: 'kitchen-sink', path: '/dev/kitchen-sink', height: 6200 },
  { name: 'audio-blocked', path: '/dev/engine?autoplay=a', strict: true, wait: 1500 },
  { name: 'home', path: '/', width: 1024 },
  { name: 'album', path: album, width: 1024 },
  { name: 'admin-users', path: '/admin/users', width: 1024 },
  { name: 'admin-settings', path: '/admin/settings', width: 1024 },
  { name: 'admin-library', path: '/admin/library', width: 1024 },
  { name: 'admin-reviews', path: '/admin/reviews', review: true, width: 1024, height: 1300 },
  { name: 'admin-organize', path: '/admin/organize', width: 1024 },
  { name: 'home', path: '/', width: 390, height: 844 },
  { name: 'album', path: album, width: 390, height: 844 },
  { name: 'now-playing', path: '/', width: 390, height: 844, click: 'Open Now Playing, Night Swimming' },
  { name: 'settings', path: '/settings', width: 390, height: 844 },
  { name: 'admin-users', path: '/admin/users', width: 390, height: 844 },
  { name: 'admin-settings', path: '/admin/settings', width: 390, height: 844 },
  { name: 'admin-library', path: '/admin/library', width: 390, height: 844 },
  { name: 'admin-reviews', path: '/admin/reviews', review: true, width: 390, height: 844 },
  { name: 'admin-organize', path: '/admin/organize', width: 390, height: 844 },
  { name: 'admin-search-index', path: '/admin/search-index', width: 390, height: 844 },
]

const signedOutShots = [
  { name: 'login', path: '/login', width: 1024 },
  { name: 'login', path: '/login', width: 390, height: 844 },
  { name: 'register', path: '/register?invite=INVITE', width: 1024 },
]

await mkdir(out, { recursive: true })
const browser = await chromium.launch()
// Without a gesture this browser refuses to start audio, which is what the blocked shot shows.
const strict = await chromium.launch({ args: ['--autoplay-policy=user-gesture-required'] })

async function capture(target, shot, scheme, storageState) {
  const width = shot.width ?? 1440
  const context = await target.newContext({ viewport: { width, height: shot.height ?? 900 }, colorScheme: scheme, deviceScaleFactor: 2, storageState })
  const page = await context.newPage()
  // The review queue opens on its first review, open or not.
  const review = shot.review && ((await reviews(page, 'open')) ?? (await reviews(page, 'resolved')))
  await page.goto(base + shot.path + (review ? `?status=${review.status}&review=${review.id}` : ''))
  await page.waitForLoadState('networkidle')
  if (shot.click) await page.getByRole('button', { name: shot.click, exact: true }).first().click()
  if (shot.find) {
    await page.getByRole('dialog').getByPlaceholder('Album or artist').fill(shot.find)
    await page.getByRole('list', { name: 'Albums' }).getByRole('button').first().click()
    await page.getByText('Track by track').waitFor({ timeout: 120_000 })
  }
  if (shot.review) await page.getByText('Track by track').or(page.getByText('MusicBrainz offered nothing close')).first().waitFor()
  if (shot.then) await page.getByRole('button', { name: shot.then, exact: true }).click()
  if (shot.create) {
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await page.getByLabel('Name').fill(shot.create)
    await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click()
  }
  if (shot.devices) {
    await page.getByRole('button', { name: 'Devices' }).first().click()
    await page.getByRole('button', { name: new RegExp(shot.devices) }).click()
  }
  await page.mouse.move(0, 0)
  if (!shot.strict) await page.evaluate(() => document.activeElement?.blur())
  await page.waitForTimeout(shot.wait ?? 600)
  await page.screenshot({ path: `${out}/${shot.name}-${width}-${scheme}.png` })
  await context.close()
}

async function reviews(page, status) {
  const response = await page.request.get(`${base}/api/v1/admin/reviews?status=${status}&limit=1`, { headers })
  return response.ok() ? (await response.json()).items[0] : undefined
}

/** Signs in once (sign-in is rate limited) and returns the cookies for every later context. */
async function signIn() {
  const context = await browser.newContext()
  const response = await context.request.post(`${base}/api/v1/auth/login`, { headers, data: credentials })
  if (!response.ok()) throw new Error(`Sign-in failed: ${response.status()}`)
  const state = await context.storageState()
  await context.close()
  return state
}

const status = await (await fetch(`${base}/api/v1/setup/status`)).json()
if (status.needsSetup) {
  for (const scheme of ['light', 'dark']) await capture(browser, { name: 'setup', path: '/setup' }, scheme)
  const setup = await fetch(`${base}/api/v1/setup`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) })
  if (!setup.ok) throw new Error(`Setup failed: ${setup.status}`)
}
const session = await signIn()
if (status.needsSetup) {
  for (const scheme of ['light', 'dark']) {
    await capture(browser, { name: 'setup-library', path: '/setup/library', wait: 900 }, scheme, session)
    await capture(browser, { name: 'setup-library', path: '/setup/library', width: 390, height: 844, wait: 900 }, scheme, session)
  }
}

for (const scheme of ['light', 'dark']) {
  for (const shot of shots) await capture(shot.strict ? strict : browser, shot, scheme, session)
  for (const shot of signedOutShots) await capture(browser, shot, scheme)
}
await strict.close()
await browser.close()
console.log(`Saved to ${out}`)
