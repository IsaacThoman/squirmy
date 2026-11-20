// Captures the main screens in both color schemes for design review and pull requests.
// Usage: SQUIRMY_USER=admin SQUIRMY_PASSWORD=… node scripts/screenshots.mjs [baseUrl] [outDir]
// Needs the dev server in front of a running server with the demo library
// (`npm run demo:library -w @squirmy/server`, prepared by `scripts/e2e-playback.mjs --prepare`).
// On a server that is not set up yet it also captures the setup wizard, creating the admin
// from SQUIRMY_USER and SQUIRMY_PASSWORD. It plays a few seconds of the quiet demo tones.
// SQUIRMY_SHOTS=home,album,… captures only the shots with those names.
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'

const base = process.argv[2] ?? 'http://localhost:5173'
const out = process.argv[3] ?? '.screenshots'
const credentials = { username: process.env.SQUIRMY_USER ?? 'admin', password: process.env.SQUIRMY_PASSWORD ?? 'correct horse battery' }
const headers = { 'X-Squirmy-Client': 'web', 'X-Squirmy-Request': '1' }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const only = process.env.SQUIRMY_SHOTS?.split(',')
const wanted = shot => !only || only.includes(shot.name)

const signedOutShots = [
  { name: 'login', path: '/login', width: 1024 },
  { name: 'login', path: '/login', width: 390, height: 844 },
  { name: 'register', path: '/register?invite=INVITE', width: 1024 },
]

await mkdir(out, { recursive: true })
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] })
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
  const click = name => page.getByRole('button', { name, exact: true }).filter({ visible: true }).first().click()
  if (shot.click) await click(shot.click)
  if (shot.find) {
    await page.getByRole('dialog').getByPlaceholder('Album or artist').fill(shot.find)
    await page.getByRole('list', { name: 'Albums' }).getByRole('button').first().click()
    await page.getByText('Track by track').waitFor({ timeout: 120_000 })
  }
  if (review) await page.getByText('Track by track').or(page.getByText('MusicBrainz offered nothing close')).first().waitFor()
  if (shot.then) await click(shot.then)
  if (shot.create) {
    // The settings rows load in and move the button; wait for the last of them.
    await page.getByRole('button', { name: /^(Connect|Disconnect)$/ }).first().waitFor()
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await page.getByLabel('Name', { exact: true }).fill(shot.create)
    await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click()
  }
  await page.mouse.move(0, 0)
  if (!shot.strict) await page.evaluate(() => document.activeElement?.blur())
  await page.waitForTimeout(shot.wait ?? 600)
  await page.screenshot({ path: `${out}/${shot.name}-${width}-${scheme}.png` })
  await context.close()
}

async function api(context, method, path, data) {
  const response = await context.request.fetch(`${base}/api/v1${path}`, { method, headers, data })
  if (!response.ok()) throw new Error(`${method} ${path}: ${response.status()}`)
  return response.json()
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

// The music the shots show: the demo library's Blue Hour, its artist, and a playlist.
const setup = await browser.newContext({ storageState: session, viewport: { width: 1440, height: 900 } })
const albums = await api(setup, 'GET', '/library/albums?sort=title&limit=200')
const blueHour = albums.items.find(album => album.title === 'Blue Hour')
const album = `/album/${blueHour.id}`
const artist = `/artist/${blueHour.artists[0].id}`
const detail = await api(setup, 'GET', `/albums/${blueHour.id}`)
const playlists = await api(setup, 'GET', '/playlists')
let playlist = playlists.items.find(item => item.name === 'Late Night')
if (!playlist) {
  playlist = await api(setup, 'POST', '/playlists', { name: 'Late Night', description: 'Slow songs for the drive home.', isPublic: true })
  const others = (await api(setup, 'GET', '/library/tracks?sort=title&limit=40')).items.filter(track => track.album?.id !== blueHour.id).slice(0, 6)
  await api(setup, 'POST', `/playlists/${playlist.id}/items`, { tracks: [...detail.discs[0].tracks.slice(0, 3), ...others].map(track => ({ trackId: track.id, albumId: track.album?.id })) })
}

// A paused session on Night Swimming, a line of its lyrics in: play it here, then leave, so
// that no device is active (after the server's 20 second grace period).
const prepare = await setup.newPage()
await prepare.goto(base + album)
await prepare.getByRole('button', { name: 'Play Night Swimming' }).click()
await prepare.getByRole('slider', { name: 'Seek' }).first().focus()
await prepare.keyboard.press('Home')
for (let press = 0; press < 13; press += 1) await prepare.keyboard.press('ArrowRight')
await prepare.getByRole('button', { name: 'Pause', exact: true }).first().click()
await sleep(500)
await setup.close()
await sleep(21_000)

const shots = [
  { name: 'home', path: '/' },
  { name: 'library', path: '/library/albums' },
  { name: 'album', path: album },
  { name: 'artist', path: artist },
  { name: 'playlist', path: `/playlist/${playlist.id}` },
  { name: 'search', path: '/search?q=blue', wait: 1500, height: 1700 },
  { name: 'library-songs', path: '/library/songs' },
  { name: 'queue', path: album, click: 'Queue' },
  { name: 'now-playing', path: '/', click: 'Lyrics', wait: 900 },
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
  { name: 'admin-organize', path: '/admin/organize', click: 'Preview', wait: 1500, height: 1300 },
  { name: 'admin-search-index', path: '/admin/search-index' },
  { name: 'kitchen-sink', path: '/dev/kitchen-sink', height: 6200 },
  { name: 'audio-blocked', path: '/dev/engine?autoplay=a', strict: true, wait: 1500 },
  ...['home', 'library', 'album', 'artist', 'playlist', 'search'].map(name => ({ name, path: { home: '/', library: '/library/albums', album, artist, playlist: `/playlist/${playlist.id}`, search: '/search?q=blue' }[name], width: 1024, height: 768, wait: 1200 })),
  { name: 'queue', path: album, click: 'Queue', width: 1024, height: 768 },
  { name: 'now-playing', path: '/', click: 'Lyrics', width: 1024, height: 768, wait: 900 },
  { name: 'admin-users', path: '/admin/users', width: 1024 },
  { name: 'admin-settings', path: '/admin/settings', width: 1024 },
  { name: 'admin-library', path: '/admin/library', width: 1024 },
  { name: 'admin-reviews', path: '/admin/reviews', review: true, width: 1024, height: 1300 },
  { name: 'admin-organize', path: '/admin/organize', click: 'Preview', wait: 1500, width: 1024 },
  ...['home', 'library', 'album', 'artist', 'playlist', 'search'].map(name => ({ name, path: { home: '/', library: '/library/albums', album, artist, playlist: `/playlist/${playlist.id}`, search: '/search?q=blue' }[name], width: 390, height: 844, wait: 1200 })),
  { name: 'now-playing', path: '/', width: 390, height: 844, click: 'Open Now Playing, Night Swimming', then: 'Show lyrics', wait: 900 },
  { name: 'queue', path: '/', width: 390, height: 844, click: 'Open Now Playing, Night Swimming', then: 'Show queue' },
  { name: 'settings', path: '/settings', width: 390, height: 844 },
  { name: 'admin-users', path: '/admin/users', width: 390, height: 844 },
  { name: 'admin-settings', path: '/admin/settings', width: 390, height: 844 },
  { name: 'admin-library', path: '/admin/library', width: 390, height: 844 },
  { name: 'admin-reviews', path: '/admin/reviews', review: true, width: 390, height: 844 },
  { name: 'admin-organize', path: '/admin/organize', click: 'Preview', wait: 1500, width: 390, height: 844 },
  { name: 'admin-search-index', path: '/admin/search-index', width: 390, height: 844 },
]

for (const scheme of ['light', 'dark']) {
  for (const shot of shots.filter(wanted)) await capture(shot.strict ? strict : browser, shot, scheme, session)
  for (const shot of signedOutShots.filter(wanted)) await capture(browser, shot, scheme)
}

// Another device plays: every page shows where, and the devices list offers to bring it here.
const speaker = await browser.newContext({ storageState: session, viewport: { width: 1024, height: 768 } })
const playing = await speaker.newPage()
await playing.goto(`${base}/settings`)
await playing.getByLabel('This browser’s name').fill('Living Room')
await playing.getByLabel('This browser’s name').press('Enter')
await playing.locator('body').click({ position: { x: 5, y: 5 } })
for (let press = 0; press < 16; press += 1) await playing.keyboard.press('ArrowDown')
await playing.getByRole('button', { name: 'Play', exact: true }).first().click()
await sleep(1500)
const elsewhere = [
  { name: 'playing-elsewhere', path: album },
  { name: 'devices', path: album, click: 'Devices', wait: 900 },
  { name: 'playing-elsewhere', path: album, width: 1024, height: 768 },
  { name: 'devices', path: album, click: 'Devices', width: 1024, height: 768, wait: 900 },
  { name: 'playing-elsewhere', path: '/', width: 390, height: 844, click: 'Open Now Playing, Night Swimming' },
  { name: 'devices', path: '/', width: 390, height: 844, click: 'Devices', wait: 900 },
]
for (const scheme of ['light', 'dark']) {
  for (const shot of elsewhere.filter(wanted)) await capture(browser, shot, scheme, session)
}
await playing.getByRole('button', { name: 'Pause', exact: true }).first().click()
await sleep(500)
await speaker.close()

await strict.close()
await browser.close()
console.log(`Saved to ${out}`)
