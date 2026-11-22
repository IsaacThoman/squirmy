// Captures the main screens in both color schemes for design review and pull requests.
// Usage: SQUIRMY_USER=admin SQUIRMY_PASSWORD=… node scripts/screenshots.mjs [baseUrl] [outDir]
// Needs the dev server in front of a running server with the demo library
// (`npm run demo:library -w @squirmy/server`, prepared by `scripts/e2e-playback.mjs --prepare`).
// On a server that is not set up yet it also captures the setup wizard, creating the admin
// from SQUIRMY_USER and SQUIRMY_PASSWORD. It plays a few seconds of the quiet demo tones.
// SQUIRMY_SHOTS=home,album,… captures only the shots with those names.
// Each shot is taken in the light and the dark scheme. Shot options: `click` and `then` press
// buttons by name (`ifThere`: only when the button exists), `keys` presses a shortcut and `type` types into what has focus, `drawer`
// opens the phone sidebar, `folded` folds the desktop sidebar and `theme` picks a color theme
// (both kept in this browser, as a user's choice would be).
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

const missed = []

/**
 * Takes one shot, trying once more if it fails: the dev server reloads the page when a file
 * changes. A shot that fails twice is reported at the end and the others are still taken.
 */
async function capture(target, shot, scheme, storageState) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await captureOnce(target, shot, scheme, storageState)
    } catch (error) {
      const name = `${shot.name}-${shot.width ?? 1440}-${scheme}`
      if (attempt === 2) {
        missed.push(name)
        console.log(`missed ${name}: ${error.message.split('\n')[0]}`)
        return
      }
    }
  }
}

async function captureOnce(target, shot, scheme, storageState) {
  const width = shot.width ?? 1440
  const context = await target.newContext({ viewport: { width, height: shot.height ?? 900 }, colorScheme: scheme, deviceScaleFactor: 2, storageState })
  await context.addInitScript(({ folded, theme }) => {
    try {
      if (folded) localStorage.setItem('squirmy.sidebar.collapsed', '1')
      // The app adds the theme's stylesheet to what is kept once it starts.
      if (theme) localStorage.setItem('squirmy.appearance', JSON.stringify({ mode: 'system', theme }))
    } catch {
      // Storage is optional for the shots too.
    }
  }, { folded: shot.folded ?? false, theme: shot.theme ?? null })
  try {
    await shoot(await context.newPage(), shot, `${out}/${shot.name}-${width}-${scheme}.png`)
  } finally {
    await context.close()
  }
}

async function shoot(page, shot, file) {
  // The review queue opens on its first review, open or not.
  const review = shot.review && ((await reviews(page, 'open')) ?? (await reviews(page, 'resolved')))
  await page.goto(base + shot.path + (review ? `?status=${review.status}&review=${review.id}` : ''))
  await page.waitForLoadState('networkidle')
  const click = name => page.getByRole('button', { name, exact: true }).filter({ visible: true }).first().click()
  if (shot.drawer) {
    await click('Open sidebar')
    await page.waitForTimeout(300)
  }
  if (shot.keys) await page.keyboard.press(shot.keys)
  if (shot.type) {
    await page.waitForTimeout(200)
    await page.keyboard.type(shot.type, { delay: 30 })
  }
  if (shot.click) {
    // Some buttons exist only on some servers: Organize's Preview needs a managed folder.
    if (!shot.ifThere || await page.getByRole('button', { name: shot.click, exact: true }).filter({ visible: true }).count()) await click(shot.click)
  }
  if (shot.find) {
    await page.getByRole('dialog').getByPlaceholder('Album or artist').fill(shot.find)
    await page.getByRole('list', { name: 'Albums' }).getByRole('button').first().click()
    await page.getByText('Track by track').waitFor({ timeout: 120_000 })
  }
  if (review) await page.getByText('Track by track').or(page.getByText('MusicBrainz offered nothing close')).first().waitFor()
  if (shot.then) await click(shot.then)
  if (shot.create) {
    await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Create', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'New app password' })
    await dialog.getByLabel('Name', { exact: true }).fill(shot.create)
    await dialog.getByRole('button', { name: 'Create' }).click()
    await page.getByRole('dialog', { name: 'Copy your app password' }).waitFor()
  }
  await page.mouse.move(0, 0)
  // Focus stays where a shot puts it on purpose: in the search dialog, or on the page that holds audio back.
  if (!shot.strict && !shot.keys) await page.evaluate(() => document.activeElement?.blur())
  await page.waitForTimeout(shot.wait ?? 600)
  await page.screenshot({ path: file })
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
await prepare.getByRole('heading', { name: 'Blue Hour', level: 1 }).waitFor()
await prepare.waitForLoadState('networkidle')
// From the keyboard: the row's play button shows on focus.
await prepare.getByRole('button', { name: 'Play Night Swimming' }).focus()
await prepare.keyboard.press('Enter')
await prepare.getByRole('button', { name: 'Pause', exact: true }).first().waitFor()
await prepare.getByRole('slider', { name: 'Seek' }).first().focus()
await prepare.keyboard.press('Home')
for (let press = 0; press < 13; press += 1) await prepare.keyboard.press('ArrowRight')
await prepare.getByRole('button', { name: 'Pause', exact: true }).first().click()
await sleep(500)
await setup.close()
await sleep(21_000)

const settingsSections = ['playback', 'appearance', 'account', 'scrobbling', 'app-passwords', 'about']
const musicPages = { home: '/', library: '/library/albums', album, artist, playlist: `/playlist/${playlist.id}`, search: '/search?q=blue' }

const shots = [
  // The shell: the sidebar open and folded, and quick search.
  { name: 'home', path: '/' },
  { name: 'home-folded', path: '/', folded: true },
  { name: 'album-folded', path: album, folded: true },
  { name: 'quick-search', path: album, keys: 'ControlOrMeta+k', wait: 500 },
  { name: 'quick-search-results', path: album, keys: 'ControlOrMeta+k', type: 'blue', wait: 1200 },
  // Music.
  { name: 'library', path: '/library/albums' },
  { name: 'album', path: album },
  { name: 'artist', path: artist },
  { name: 'playlist', path: `/playlist/${playlist.id}` },
  { name: 'liked', path: '/liked' },
  { name: 'search', path: '/search?q=blue', wait: 1500, height: 1700 },
  { name: 'search-genres', path: '/search' },
  { name: 'library-songs', path: '/library/songs' },
  { name: 'library-artists', path: '/library/artists' },
  { name: 'library-playlists', path: '/library/playlists' },
  { name: 'wantlist', path: '/wantlist' },
  { name: 'add-music', path: '/imports' },
  // The player: the queue beside the page, Now Playing with its art and its lyrics.
  { name: 'queue', path: album, click: 'Queue' },
  { name: 'now-playing', path: '/', click: 'Open Now Playing', wait: 900 },
  { name: 'now-playing-lyrics', path: '/', click: 'Lyrics', wait: 900 },
  // Settings, every section; Appearance in the default and another color theme.
  ...settingsSections.map(section => ({ name: `settings-${section}`, path: `/settings/${section}` })),
  { name: 'settings-appearance-ocean', path: '/settings/appearance', theme: 'ocean' },
  { name: 'home-ocean', path: '/', theme: 'ocean' },
  { name: 'app-password', path: '/settings/app-passwords', create: 'Car stereo' },
  // Admin.
  { name: 'admin-library', path: '/admin/library' },
  { name: 'admin-add-folder', path: '/admin/library', click: 'Add folder' },
  { name: 'admin-reviews', path: '/admin/reviews', review: true, height: 1400 },
  { name: 'admin-fix-match', path: '/admin/library', click: 'Fix a match', find: 'Abbey Road', wait: 1000 },
  { name: 'admin-organize', path: '/admin/organize', click: 'Preview', ifThere: true, wait: 1500, height: 1300 },
  { name: 'admin-search-index', path: '/admin/search-index' },
  { name: 'admin-providers', path: '/admin/providers', height: 1300 },
  { name: 'admin-users', path: '/admin/users' },
  { name: 'admin-invite', path: '/admin/users', click: 'Invite someone', then: 'Create invite' },
  { name: 'admin-settings', path: '/admin/settings', height: 1500 },
  { name: 'admin-jobs', path: '/admin/jobs' },
  { name: 'kitchen-sink', path: '/dev/kitchen-sink', height: 6200 },
  { name: 'audio-blocked', path: '/dev/engine?autoplay=a', strict: true, wait: 1500 },
  // A small laptop.
  ...Object.entries(musicPages).map(([name, path]) => ({ name, path, width: 1024, height: 768, wait: 1200 })),
  { name: 'home-folded', path: '/', folded: true, width: 1024, height: 768 },
  { name: 'queue', path: album, click: 'Queue', width: 1024, height: 768 },
  { name: 'now-playing', path: '/', click: 'Open Now Playing', width: 1024, height: 768, wait: 900 },
  { name: 'now-playing-lyrics', path: '/', click: 'Lyrics', width: 1024, height: 768, wait: 900 },
  { name: 'settings-playback', path: '/settings/playback', width: 1024, height: 768 },
  { name: 'admin-users', path: '/admin/users', width: 1024 },
  { name: 'admin-settings', path: '/admin/settings', width: 1024 },
  { name: 'admin-library', path: '/admin/library', width: 1024 },
  { name: 'admin-reviews', path: '/admin/reviews', review: true, width: 1024, height: 1300 },
  { name: 'admin-organize', path: '/admin/organize', click: 'Preview', ifThere: true, wait: 1500, width: 1024 },
  // A phone: the drawer instead of the sidebar, the small player, settings and admin full width.
  ...Object.entries(musicPages).map(([name, path]) => ({ name, path, width: 390, height: 844, wait: 1200 })),
  { name: 'drawer', path: '/', width: 390, height: 844, drawer: true },
  { name: 'drawer', path: album, width: 390, height: 844, drawer: true },
  { name: 'quick-search-results', path: '/', width: 390, height: 844, keys: 'ControlOrMeta+k', type: 'blue', wait: 1200 },
  { name: 'now-playing', path: '/', width: 390, height: 844, click: 'Open Now Playing, Night Swimming', wait: 900 },
  { name: 'now-playing-lyrics', path: '/', width: 390, height: 844, click: 'Open Now Playing, Night Swimming', then: 'Show lyrics', wait: 900 },
  { name: 'queue', path: '/', width: 390, height: 844, click: 'Open Now Playing, Night Swimming', then: 'Show queue' },
  ...settingsSections.map(section => ({ name: `settings-${section}`, path: `/settings/${section}`, width: 390, height: 844 })),
  { name: 'add-music', path: '/imports', width: 390, height: 844 },
  { name: 'admin-users', path: '/admin/users', width: 390, height: 844 },
  { name: 'admin-settings', path: '/admin/settings', width: 390, height: 844 },
  { name: 'admin-library', path: '/admin/library', width: 390, height: 844 },
  { name: 'admin-reviews', path: '/admin/reviews', review: true, width: 390, height: 844 },
  { name: 'admin-organize', path: '/admin/organize', click: 'Preview', ifThere: true, wait: 1500, width: 390, height: 844 },
  { name: 'admin-search-index', path: '/admin/search-index', width: 390, height: 844 },
  { name: 'admin-providers', path: '/admin/providers', width: 390, height: 844 },
]

for (const scheme of ['light', 'dark']) {
  for (const shot of shots.filter(wanted)) await capture(shot.strict ? strict : browser, shot, scheme, session)
  for (const shot of signedOutShots.filter(wanted)) await capture(browser, shot, scheme)
}

// Another device plays: every page shows where, and the devices list offers to bring it here.
const speaker = await browser.newContext({ storageState: session, viewport: { width: 1024, height: 768 } })
const playing = await speaker.newPage()
await playing.goto(`${base}/settings/playback`)
await playing.getByLabel('This browser’s name').fill('Living Room')
await playing.getByLabel('This browser’s name').press('Enter')
// While the "Browser renamed" notice shows, the first Escape dismisses it rather than the dialog.
for (let press = 0; press < 3 && await playing.getByRole('dialog', { name: 'Settings' }).count(); press += 1) {
  await playing.keyboard.press('Escape')
  await sleep(400)
}
await playing.locator('main').focus()
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
if (missed.length) {
  console.log(`${missed.length} shots could not be taken: ${missed.join(', ')}`)
  process.exit(1)
}
