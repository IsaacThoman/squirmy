// Walks playback in real Chromium against a real server with the demo library: albums,
// transport, the queue, likes, the search page, quick search (Cmd/Ctrl+K), playlists, lyrics,
// gapless track ends, then two devices of one user and a second user who must see none of it.
//
// 1. node scripts/e2e-playback.mjs --prepare <music dir>
//    Writes a synced .lrc next to "Mira Vale/Blue Hour/01 Night Swimming.flac" from
//    `npm run demo:library -w @squirmy/server -- <music dir>`.
// 2. Start a server on a fresh database with SQUIRMY_LIBRARY_PATHS=<music dir>, and the
//    Vite dev server in front of it (SQUIRMY_API_URL).
// 3. node scripts/e2e-playback.mjs <baseUrl>
//
// The demo tracks are very quiet tones, and this run keeps the volume low besides.
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

const args = process.argv.slice(2)
const lyrics = [
  'The day goes quiet', 'Blue on the water', 'No one around us', 'Just a little farther', 'Hold your breath and count to ten',
  'Come up looking for the morning', 'Every light along the shore', 'Turns into a place we’ve been', 'I could stay here all night',
  'Until the blue hour ends',
]

if (args[0] === '--prepare') {
  const file = path.join(args[1], 'Mira Vale', 'Blue Hour', '01 Night Swimming.lrc')
  await writeFile(file, lyrics.map((line, index) => `[00:${String(4 * (index + 1)).padStart(2, '0')}.00]${line}`).join('\n'))
  console.log(`Wrote ${file}`)
  process.exit(0)
}

const base = args[0] ?? 'http://localhost:5173'
const admin = { username: 'admin', password: 'correct horse battery' }
const member = { username: 'robin', password: 'listen closely' }
const headers = { 'X-Squirmy-Client': 'web', 'X-Squirmy-Request': '1' }
let failed = 0
let total = 0

function check(name, ok, detail = '') {
  total += 1
  if (!ok) failed += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail === '' ? '' : `  (${detail})`}`)
}

/** Runs a step; a thrown error fails it and the run carries on with the next one. */
async function step(name, body) {
  try {
    await body()
  } catch (error) {
    check(name, false, error.message.split('\n')[0])
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Polls `read` until `test` passes or `timeoutMs` runs out; returns the last value read. */
async function until(read, test, timeoutMs = 5000, everyMs = 100) {
  const end = Date.now() + timeoutMs
  let value = await read()
  while (!test(value) && Date.now() < end) {
    await sleep(everyMs)
    value = await read()
  }
  return value
}

/**
 * Records every audio element the page creates and what it does, so the checks can tell
 * whether this page is really making sound, where it is, and how long a track change took.
 */
function instrumentAudio() {
  const Native = window.Audio
  const record = { elements: [], events: [] }
  window.__audio = record
  window.Audio = function Audio(...rest) {
    const element = new Native(...rest)
    record.elements.push(element)
    for (const type of ['playing', 'pause', 'ended', 'seeked', 'error']) {
      element.addEventListener(type, () => record.events.push({ type, at: performance.now(), src: element.currentSrc, time: element.currentTime }))
    }
    return element
  }
  window.Audio.prototype = Native.prototype
}

/** The element that is playing, with its position in ms, or null when the page is silent. */
const sounding = page => page.evaluate(() => {
  const element = window.__audio.elements.find(audio => !audio.paused && !audio.ended && audio.currentSrc)
  return element ? { src: element.currentSrc, ms: Math.round(element.currentTime * 1000) } : null
})

/**
 * Whether the page plays one source that moves on with time. Waits a few seconds for it to
 * start: right after a change the previous track can still be playing for a moment.
 */
async function advancing(page) {
  const end = Date.now() + 8000
  while (Date.now() < end) {
    const first = await sounding(page)
    await sleep(1000)
    const second = await sounding(page)
    if (first && second && first.src === second.src && second.ms - first.ms > 600) return true
  }
  return false
}

/** The tab title is "<track> · <artist>" while something plays, on every device. */
const nowPlayingTitle = async page => (await page.title()).split(' · ')[0]
const seekValue = async page => Number(await page.getByRole('slider', { name: 'Seek' }).first().getAttribute('aria-valuenow'))
const transport = (page, name) => page.getByRole('button', { name, exact: true }).first()
/** The user's playlists, Liked Songs first, in the sidebar. */
const sidebarPlaylists = page => page.getByRole('complementary', { name: 'Sidebar' }).getByRole('list', { name: 'Playlists' })

/** Seeks by clicking the seek bar at `fraction` of its width. */
async function seekTo(page, fraction) {
  const box = await page.getByRole('slider', { name: 'Seek' }).first().locator('xpath=ancestor::*[contains(@class, "touch-none")][1]').boundingBox()
  await page.mouse.click(box.x + box.width * fraction, box.y + box.height / 2)
}

async function api(context, method, url, data) {
  const response = await context.request.fetch(`${base}/api/v1${url}`, { method, headers, data })
  if (!response.ok()) throw new Error(`${method} ${url}: ${response.status()} ${await response.text()}`)
  return response.status() === 204 ? null : response.json()
}

async function signedIn(browser, credentials, viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ viewport })
  await context.addInitScript(instrumentAudio)
  await api(context, 'POST', '/auth/login', credentials)
  const page = await context.newPage()
  page.on('pageerror', error => console.log(`page error: ${error.message}`))
  return { context, page }
}

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] })

// Setup: the admin, local metadata only (no outside lookups while the run checks ids), the scan.
const status = await (await fetch(`${base}/api/v1/setup/status`)).json()
if (status.needsSetup) {
  const response = await fetch(`${base}/api/v1/setup`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(admin) })
  check('the admin is created', response.ok, response.status)
}
const a = await signedIn(browser, admin)
await api(a.context, 'PATCH', '/admin/settings', { musicBrainzEnabled: false, deezerEnabled: false, coverArtArchiveEnabled: false, wikidataEnabled: false, lrclibEnabled: false })
const scanned = await until(() => api(a.context, 'GET', '/admin/library/stats'), stats => stats.tracks >= 117 && stats.pending === 0, 180_000, 1000)
check('the demo library is scanned', scanned.tracks >= 117, `${scanned.albums} albums, ${scanned.tracks} tracks`)
const blueHour = (await api(a.context, 'GET', '/library/albums?sort=title&limit=200')).items.find(album => album.title === 'Blue Hour')
const page = a.page

await step('album playback', async () => {
  await page.goto(`${base}/album/${blueHour.id}`)
  await page.getByRole('heading', { name: 'Blue Hour', level: 1 }).waitFor()
  // Quiet: the tones are near silent already; the volume goes down to 20% as well.
  await page.locator('body').click({ position: { x: 5, y: 5 } })
  for (let press = 0; press < 16; press += 1) await page.keyboard.press('ArrowDown')
  // Until the first sound the player's button spins: never a plain Pause over silence.
  const watched = page.evaluate(() => new Promise(resolve => {
    const start = performance.now()
    const bare = []
    const tick = () => {
      const at = Math.round(performance.now() - start)
      if (window.__audio.elements.some(audio => !audio.paused && audio.currentTime > 0)) return resolve({ bare, at })
      const button = document.querySelector('section[aria-label="Player"] button[aria-label="Pause"]')
      if (button && button.getAttribute('aria-busy') !== 'true') bare.push(at)
      if (at > 8000) return resolve({ bare, at: null })
      requestAnimationFrame(tick)
    }
    tick()
  }))
  await page.getByRole('button', { name: 'Play Blue Hour' }).click()
  await page.getByRole('link', { name: 'Night Swimming', exact: true }).waitFor()
  check('playing an album starts its first track', true, await page.title())
  const start = await watched
  check('the play button spins until the first sound', start.at !== null && start.bare.length === 0, `sound after ${start.at} ms${start.bare.length ? `, a bare Pause at ${start.bare[0]} ms` : ''}`)
  check('the audio element is advancing', await advancing(page))
  const session = await api(a.context, 'GET', '/me/session')
  check('this browser became the active device', session.state.activeDeviceId !== null && session.state.playing)
  check('the volume went down', session.state.volumes[session.state.activeDeviceId] <= 0.25, session.state.volumes[session.state.activeDeviceId])
})

await step('transport', async () => {
  await transport(page, 'Pause').click()
  const paused = await until(() => sounding(page), value => value === null, 2000)
  check('pause stops the audio', paused === null)
  await seekTo(page, 0.5)
  const target = await until(() => seekValue(page), value => value > 100_000, 2000)
  const element = await page.evaluate(() => Math.round(window.__audio.elements.find(audio => audio.currentSrc && audio.currentTime > 0)?.currentTime * 1000))
  check('seeking moves the audio', Math.abs(element - target) < 1500, `${target} ms, audio at ${element} ms`)
  await transport(page, 'Play').click()
  check('play resumes', await advancing(page))
  await transport(page, 'Next').click()
  await page.getByRole('link', { name: 'Soft Signal', exact: true }).waitFor()
  check('next moves on', await advancing(page))
  await transport(page, 'Previous').click()
  await page.getByRole('link', { name: 'Night Swimming', exact: true }).waitFor()
  check('previous goes back', await advancing(page))
})

await step('queue', async () => {
  await transport(page, 'Queue').click()
  const queue = page.getByRole('complementary', { name: 'Queue' })
  const order = () => queue.getByRole('button', { name: /^Reorder / }).evaluateAll(handles => handles.map(handle => handle.getAttribute('aria-label').replace(/^Reorder (.*), position.*$/, '$1')))
  check('up next lists the rest of the album', (await order()).join(' / ') === 'Soft Signal / Blue in the Dark / Underwater Light / Stay Until Morning', (await order()).join(' / '))
  await queue.getByRole('button', { name: /^Reorder Underwater Light/ }).press('ArrowUp')
  const moved = await until(order, value => value[1] === 'Underwater Light')
  const server = await until(() => api(a.context, 'GET', '/me/session'), snapshot => snapshot.queue.queue.length === 4 && snapshot.queue.queue[1].trackId !== snapshot.queue.queue[2].trackId)
  check('reordering moves the entry', moved.join(' / ') === 'Soft Signal / Underwater Light / Blue in the Dark / Stay Until Morning', moved.join(' / '))
  await queue.getByRole('button', { name: 'Remove Blue in the Dark from queue' }).click()
  const removed = await until(order, value => value.length === 3)
  const after = await until(() => api(a.context, 'GET', '/me/session'), snapshot => snapshot.queue.queue.length === 3)
  check('removing takes it out, here and on the server', removed.join(' / ') === 'Soft Signal / Underwater Light / Stay Until Morning' && after.queue.queue.length === 3 && server.version > 0)
  await queue.getByRole('button', { name: 'Close queue' }).click()
})

await step('likes', async () => {
  // The playing song's heart, in the player, named after the song: the album page's is "Save to library".
  await page.getByRole('region', { name: 'Player' }).getByRole('button', { name: /^Save .+ to library$/ }).first().click()
  await page.getByRole('link', { name: /Liked Songs/ }).first().click()
  await page.getByRole('heading', { name: 'Liked Songs', level: 1 }).waitFor()
  const row = page.getByRole('list', { name: 'Liked Songs tracks' }).getByText('Night Swimming', { exact: true })
  await row.waitFor({ timeout: 5000 })
  check('a liked track is in Liked Songs', true)
  check('the sidebar counts it', await sidebarPlaylists(page).getByRole('link', { name: /Liked Songs/ }).getByText('1 song', { exact: true }).isVisible())
})

await step('search', async () => {
  const asked = []
  const listen = request => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/v1/search/')) asked.push(`${url.pathname.split('/').pop()}:${url.searchParams.get('q')}`)
  }
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Search' }).click()
  await page.getByRole('heading', { name: 'Search', level: 1 }).waitFor()
  page.on('request', listen)
  await page.getByRole('searchbox', { name: 'Search' }).pressSequentially('blue hour', { delay: 40 })
  // The ranked list is a plain list: each row's link or button is a control of its own.
  const results = page.getByRole('list', { name: 'Results for blue hour' })
  await results.getByRole('listitem').filter({ hasText: 'Blue Hour' }).first().waitFor()
  await sleep(500)
  page.off('request', listen)
  check('library results come from the server', true)
  // The library search waits 60 ms for typing to pause, so a slow keystroke on a loaded machine
  // may send an earlier prefix; what must hold is that the last library request and the one
  // catalog request are for the settled query, and nothing else is asked.
  const library = asked.filter(request => request.startsWith('library:'))
  const catalog = asked.filter(request => request.startsWith('catalog:'))
  check('typing settles on the whole query, in both searches',
    library.at(-1) === 'library:blue hour' && library.every(request => 'blue hour'.startsWith(request.slice('library:'.length)))
      && catalog.length === 1 && catalog[0] === 'catalog:blue hour' && library.length + catalog.length === asked.length,
    asked.join(', '))
  // One ranked list, every kind mixed, each row saying what it is: no sections, none named for the library.
  const rows = await results.getByRole('listitem').allTextContents()
  check('one list, the album named first, each row saying what it is', /^Blue Hour(Album|EP|Single) · Mira Vale/.test(rows[0] ?? '') && rows.every(row => / · |Artist|Playlist/.test(row)), rows.slice(0, 4).join(' / '))
  const headings = await page.getByRole('main').getByRole('heading', { level: 2 }).allTextContents()
  check('no sections', headings.length === 0, headings.join(' / '))
})

await step('quick search', async () => {
  const dialog = page.getByRole('dialog', { name: 'Search' })
  const field = dialog.getByRole('combobox', { name: 'Search' })
  const options = dialog.getByRole('option')
  const selected = () => dialog.locator('[role="option"][aria-selected="true"]').textContent()
  /** Moves the highlight with the arrow keys to the first option matching `pattern`. */
  async function arrowTo(pattern) {
    const texts = await options.allTextContents()
    const index = texts.findIndex(text => pattern.test(text))
    if (index < 0) throw new Error(`no option like ${pattern}: ${texts.join(' | ')}`)
    for (let press = 0; press < index; press += 1) await field.press('ArrowDown')
    return selected()
  }

  await page.goto(`${base}/library/artists`)
  await page.getByRole('heading', { name: 'Library', level: 1 }).waitFor()
  await page.keyboard.press('ControlOrMeta+k')
  await field.waitFor()
  check('Ctrl/Cmd+K opens quick search with the field focused', await field.evaluate(element => element === document.activeElement))
  check('with nothing typed it offers places to go', (await dialog.getByRole('listbox', { name: 'Go to' }).getByRole('option').allTextContents()).includes('Albums'))
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached' })
  check('Escape closes it', true)

  await page.keyboard.press('ControlOrMeta+k')
  await field.pressSequentially('blue hour', { delay: 30 })
  await dialog.getByRole('listbox', { name: 'Results' }).getByRole('option', { name: /Blue Hour/ }).first().waitFor()
  await sleep(400)
  const albumOption = await arrowTo(/^Blue Hour(Album|EP|Single)/)
  check('the arrow keys move the highlight', albumOption.startsWith('Blue Hour'), albumOption)
  await field.press('Enter')
  await page.waitForURL(`**/album/${blueHour.id}`)
  await dialog.waitFor({ state: 'detached' })
  check('Enter opens the album and closes the dialog', true)

  await page.keyboard.press('ControlOrMeta+k')
  await field.pressSequentially('underwater light', { delay: 30 })
  await dialog.getByRole('option', { name: /Underwater Light/ }).first().waitFor()
  await sleep(400)
  const songOption = await arrowTo(/^Underwater LightSong/)
  check('a song offers to play', songOption.includes('Play'), songOption)
  await field.press('Enter')
  await dialog.waitFor({ state: 'detached' })
  await page.getByRole('link', { name: 'Underwater Light', exact: true }).first().waitFor()
  check('Enter on a song plays it', await nowPlayingTitle(page) === 'Underwater Light' && await advancing(page), await page.title())

  await page.keyboard.press('ControlOrMeta+k')
  await field.pressSequentially('mira', { delay: 30 })
  await dialog.getByRole('option', { name: /See all results for/ }).waitFor()
  await sleep(400)
  await arrowTo(/^See all results for/)
  await field.press('Enter')
  await page.waitForURL(url => url.pathname === '/search' && url.searchParams.get('q') === 'mira')
  check('the last option opens the search page for the query', await page.getByRole('searchbox', { name: 'Search' }).inputValue() === 'mira')
  await transport(page, 'Pause').click()
})

await step('playlists', async () => {
  await page.getByRole('button', { name: 'New playlist' }).first().click()
  await page.getByLabel('Name', { exact: true }).fill('E2E Mix')
  await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click()
  await page.getByRole('heading', { name: 'E2E Mix', level: 1 }).waitFor()
  check('a new playlist opens', true)
  await page.goto(`${base}/album/${blueHour.id}`)
  for (const title of ['Soft Signal', 'Underwater Light']) {
    await page.getByRole('button', { name: `More options for ${title}` }).click()
    await page.getByRole('menuitem', { name: 'Add to playlist' }).click()
    await page.getByRole('menuitem', { name: 'E2E Mix' }).click()
    // The menu item says it worked for a moment before its menu closes.
    await page.getByRole('menuitem', { name: 'Added to E2E Mix' }).waitFor()
  }
  const sidebarLink = sidebarPlaylists(page).getByRole('link', { name: /E2E Mix/ })
  await page.getByRole('list', { name: 'Blue Hour tracks' }).getByRole('listitem').filter({ hasText: 'Stay Until Morning' }).dragTo(sidebarLink)
  // The playlist the songs were dropped on says Added beside its name.
  await sidebarLink.getByText('Added', { exact: true }).waitFor()
  await sidebarLink.click()
  const rows = () => page.getByRole('list', { name: 'E2E Mix tracks' }).getByRole('listitem').evaluateAll(items => items.map(item => item.querySelector('span.truncate')?.textContent))
  const added = await until(rows, value => value.length === 3)
  check('tracks are added from the menu and by dragging to the sidebar', added.join(' / ') === 'Soft Signal / Underwater Light / Stay Until Morning', added.join(' / '))
  await page.getByRole('button', { name: 'More options for Underwater Light' }).click()
  await page.getByRole('menuitem', { name: 'Move up' }).click()
  const moved = await until(rows, value => value[0] === 'Underwater Light')
  const saved = await until(() => api(a.context, 'GET', `/playlists/${page.url().split('/').pop()}`), detail => detail.items[0].track.title === 'Underwater Light')
  check('reordering sticks', moved[0] === 'Underwater Light' && saved.items[0].track.title === 'Underwater Light', moved.join(' / '))
  await page.getByRole('button', { name: 'Play E2E Mix' }).click()
  await page.getByRole('link', { name: 'Underwater Light', exact: true }).waitFor()
  const playing = await advancing(page)
  const session = await api(a.context, 'GET', '/me/session')
  check('playing the playlist starts it', session.state.context?.type === 'playlist' && playing)
})

await step('lyrics', async () => {
  await page.goto(`${base}/album/${blueHour.id}`)
  // A pointer click where the hover play button shows, as a user does, not a click Playwright aims at the button.
  const tracks = page.getByRole('list', { name: 'Blue Hour tracks' })
  await tracks.getByRole('listitem').filter({ hasText: 'Night Swimming' }).first().hover()
  const box = await page.getByRole('button', { name: 'Play Night Swimming' }).boundingBox()
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  const started = await until(() => nowPlayingTitle(page), title => title === 'Night Swimming', 3000)
  const onTop = await page.evaluate(([x, y]) => {
    const element = document.elementFromPoint(x, y)
    return `${element.tagName.toLowerCase()} “${element.getAttribute('aria-label') ?? element.textContent}”`
  }, [box.x + box.width / 2, box.y + box.height / 2])
  check('clicking a track row\'s play button plays it', started === 'Night Swimming', `${onTop} is on top; playing ${started}`)
  // Double clicking the row plays it too, so the walk carries on that way if the button failed.
  if (started !== 'Night Swimming') await tracks.getByText('Night Swimming', { exact: true }).dblclick()
  await page.getByRole('link', { name: 'Night Swimming', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Lyrics', exact: true }).click()
  // The lines are one list for Tab, each an option; the one sung now is selected.
  const lines = page.getByRole('listbox', { name: 'Lyrics' })
  await lines.getByRole('option', { name: 'Blue on the water' }).click()
  const active = () => lines.locator('[role="option"][aria-selected="true"]').textContent()
  const line = await until(active, text => text === 'Blue on the water')
  check('clicking a line seeks to it', line === 'Blue on the water', line)
  const later = await until(active, text => text === 'No one around us', 6000)
  check('the lines follow the position', later === 'No one around us', later)
  await page.getByRole('button', { name: 'Close Now Playing' }).click()
  await page.getByRole('dialog').waitFor({ state: 'detached' })
})

await step('natural end', async () => {
  await seekTo(page, 0.985)
  await page.getByRole('link', { name: 'Soft Signal', exact: true }).waitFor({ timeout: 15_000 })
  check('the next track follows at the end', await advancing(page))
  // As scripts/e2e-engine.mjs measures it: time since the end, less what the next track has played.
  const gap = await page.evaluate(() => {
    const { events, elements } = window.__audio
    const end = events.findLast(event => event.type === 'ended')
    const next = elements.find(audio => !audio.paused && audio.currentSrc && audio.currentSrc !== end?.src)
    return end && next ? Math.round(performance.now() - end.at - next.currentTime * 1000) : null
  })
  check('without a gap', gap !== null && gap < 120, `${gap} ms lost between the tracks`)
  const errors = await page.evaluate(() => window.__audio.events.filter(event => event.type === 'error').length)
  check('and no audio errors', errors === 0, errors)
})

// Two devices of one user.
const b = await signedIn(browser, admin)
await step('a second device', async () => {
  await a.page.getByRole('button', { name: /^Account/ }).click()
  await a.page.getByRole('menuitem', { name: 'Settings' }).click()
  await a.page.getByLabel('This browser’s name').fill('E2E Speaker')
  await a.page.getByLabel('This browser’s name').press('Enter')
  const settings = a.page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('status').filter({ hasText: /^Saved$/ }).waitFor({ timeout: 5000 }).catch(() => { throw new Error('no “Saved” beside the browser’s name') })
  await a.page.keyboard.press('Escape')
  const closed = await settings.waitFor({ state: 'detached', timeout: 2000 }).then(() => true, () => false)
  check('Escape closes Settings at once while “Saved” shows', closed, closed ? '' : 'the first Escape did not close it')
  // A user presses it again.
  if (!closed) await a.page.keyboard.press('Escape')
  await settings.waitFor({ state: 'detached', timeout: 5000 }).catch(() => { throw new Error('Escape did not close Settings') })
  await b.page.goto(`${base}/`)
  await b.page.getByText('Playing on E2E Speaker').filter({ visible: true }).waitFor({ timeout: 8000 }).catch(async () => {
    const session = await api(a.context, 'GET', '/me/session')
    throw new Error(`the second device does not say “Playing on E2E Speaker” (session ${session.state.playing ? 'playing' : 'paused'}, first device ${(await sounding(a.page)) ? 'sounding' : 'silent'})`)
  })
  check('it shows where the music plays, by the renamed device', true)
  const playing = await nowPlayingTitle(a.page)
  const shown = await until(() => nowPlayingTitle(b.page), title => title === playing)
  check('it shows the same track', shown === playing, shown)
  await sleep(300)
  const [remote, local] = [await seekValue(b.page), (await sounding(a.page))?.ms]
  check('at a matching position', Math.abs(remote - local) < 1000, `${remote} ms there, ${local} ms here`)
  check('without playing sound', (await sounding(b.page)) === null)
})

await step('remote control', async () => {
  await transport(b.page, 'Pause').click()
  const paused = await until(() => sounding(a.page), value => value === null, 1000)
  check('pausing from the second device pauses the first within a second', paused === null)
  await seekTo(b.page, 0.25)
  const target = await until(() => seekValue(b.page), value => value > 30_000 && value < 70_000, 1000)
  const there = await until(() => a.page.evaluate(() => Math.round(window.__audio.elements.find(audio => audio.currentSrc && audio.currentTime > 1)?.currentTime * 1000)), ms => Math.abs(ms - target) < 1000, 1000)
  check('seeking from it moves the first within a second', Math.abs(there - target) < 1000, `${target} ms asked, ${there} ms there`)
  await transport(b.page, 'Play').click()
  const resumed = await until(() => sounding(a.page), value => value !== null, 1000)
  check('play resumes on the first', resumed !== null)
})

await step('play here', async () => {
  await sleep(1500)
  // A pointer on the button gets the music ready, as a user's does on the way to pressing it.
  await b.page.getByRole('button', { name: 'Play here' }).first().hover()
  await sleep(400)
  const before = (await sounding(a.page))?.ms ?? 0
  const pressed = Date.now()
  await b.page.getByRole('button', { name: 'Play here' }).first().click()
  const silent = await until(() => sounding(a.page), value => value === null, 2000)
  check('the first device stops', silent === null)
  const here = await until(() => sounding(b.page), value => value !== null, 4000, 20)
  const gap = Date.now() - pressed
  check('the second starts where the first was', here !== null && Math.abs(here.ms - before) < 2500, `${before} ms there, ${here?.ms} ms here`)
  check('within a second of the press', here !== null && gap < 1000, `${gap} ms`)
  check('and is advancing', await advancing(b.page))
  await a.page.getByText('Playing on Chrome on macOS').filter({ visible: true }).waitFor({ timeout: 3000 })
  check('the first now shows the second playing', true)
})

await step('the active device goes away', async () => {
  await b.context.close()
  // The player says "Reconnecting to …" as soon as the device leaves; the session itself pauses
  // only once the server's grace period (20 s) is over, so that is what is waited for.
  const session = await until(() => api(a.context, 'GET', '/me/session'), snapshot => !snapshot.state.playing && snapshot.state.activeDeviceId === null, 40_000, 500)
  check('after the grace period the session is paused with no active device', !session.state.playing && session.state.activeDeviceId === null, JSON.stringify({ playing: session.state.playing, active: session.state.activeDeviceId }))
  check('this browser shows it paused', await transport(a.page, 'Play').waitFor({ timeout: 5000 }).then(() => true, () => false))
  await transport(a.page, 'Play').click()
  check('the first play here makes this browser active', await advancing(a.page))
})

await step('transfer to a browser that holds audio back', async () => {
  // This browser refuses to start audio without a gesture, as far as Chromium enforces it:
  // a reopened tab that is the active device is sometimes allowed and sometimes refused.
  // Either way it must never sit there silent: it plays, or it offers "Enable audio".
  // Anything Playwright evaluates counts as a gesture for the site, so nothing is evaluated
  // in it until one of the two shows.
  const strict = await chromium.launch({ args: ['--autoplay-policy=user-gesture-required'] })
  const d = await signedIn(strict, admin)
  await d.page.goto(`${base}/`)
  await d.page.getByRole('heading', { name: 'Listen now' }).waitFor()
  await a.page.getByRole('button', { name: 'Devices' }).first().click()
  await a.page.getByRole('dialog', { name: 'Playback devices' }).getByRole('button', { name: /Chrome on macOS/ }).click()
  const silent = await until(() => sounding(a.page), value => value === null, 2000)
  const moved = await until(() => api(d.context, 'GET', '/me/session'), session => session.state.activeDeviceId !== null && session.state.playing)
  const devices = await api(d.context, 'GET', '/me/devices')
  const target = devices.items.find(device => device.id === moved.state.activeDeviceId)
  check('transferring from the devices list moves the music', silent === null && target?.name === 'Chrome on macOS', target?.name)
  await d.page.goto(`${base}/`)
  const notice = d.page.getByRole('button', { name: 'Enable audio' })
  const stalled = async () => (await api(d.context, 'GET', '/me/session')).state.stalled
  // The engine reports a refused play to the server, which marks the session stalled; a
  // play that went through clears it. The reopened page gets a moment to try first.
  await sleep(3000)
  const settled = await until(async () => (await notice.isVisible()) || !(await stalled()) ? 'settled' : null, Boolean, 8000)
  const offered = await notice.isVisible()
  check('reopened as the active device, the tab plays or offers to enable audio', settled !== null, offered ? 'offered "Enable audio"' : 'allowed to play')
  if (offered) {
    // Held back, nothing plays, so the player says Play, and pressing it starts the music.
    check('while held back the player shows Play, not Pause', await transport(d.page, 'Play').isVisible() && !(await transport(d.page, 'Pause').isVisible()))
    await transport(d.page, 'Play').click()
  }
  check('and the music plays there', await advancing(d.page))
  check('as the same device it was', (await api(d.context, 'GET', '/me/session')).state.activeDeviceId === target?.id)
  await strict.close()
})

await step('another user', async () => {
  const invite = await api(a.context, 'POST', '/admin/invites', {})
  const c = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await c.addInitScript(instrumentAudio)
  await c.request.post(`${base}/api/v1/auth/register`, { headers, data: { ...member, inviteCode: invite.code } })
  const page = await c.newPage()
  await page.goto(`${base}/`)
  await page.getByRole('heading', { name: 'Listen now' }).waitFor()
  await sleep(1500)
  check('sees nothing playing', !(await page.getByRole('button', { name: 'Open Now Playing' }).isVisible()))
  check('hears nothing', (await sounding(page)) === null)
  await page.getByRole('button', { name: 'Devices' }).first().click()
  const devices = await page.getByRole('dialog', { name: 'Playback devices' }).textContent()
  check('and lists only its own device', !devices.includes('E2E Speaker') && devices.includes('Nothing right now'), devices)
  await page.goto(`${base}/liked`)
  await page.getByText('Songs you like appear here').waitFor()
  check('with likes of its own', true)
  await c.close()
})

await browser.close()
console.log(`${total - failed} of ${total} checks passed`)
process.exit(failed ? 1 : 0)
