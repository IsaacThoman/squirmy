// Checks in real Chromium, on phones (320 × 640, 390 × 844) and a tablet (768 × 1024) with touch input and
// a coarse pointer, that every control a finger can press has at least 44 × 44 px to press. It
// walks Home, Search with results, each Library filter, an album, an artist, a playlist, Liked
// Songs, a track's menu, the sidebar drawer, Settings and its password dialog, Devices, Now
// Playing with its queue and lyrics, and the tablet's queue panel. On each it finds every visible
// control (buttons, links, fields, and anything with a control's role or in the Tab order) and
// presses 17 points of the 44 px circle centered on it with `elementFromPoint`: each must land on
// the control (a pseudo-element counts, it is part of its element), so a control made larger than
// it looks passes, and one whose larger area is covered by a neighbor or cut off by its container
// fails. The few controls that are not held to this are listed in `exceptions`, each with why.
// It also checks that no control floating over the page (one that stays put while the page
// scrolls, as the phone's drawer button does) sits on the page's words or controls, at the top
// and scrolled, on a 320 px phone too: what passes under it must be covered by a bar.
//
// Usage: node scripts/e2e-touch-targets.mjs <baseUrl> [--username <name>] [--password <password>] [--shots <dir>]
//   The server must be set up, with a library scanned (the demo library: `npm run demo:library -w
//   @squirmy/server -- <dir>`); the run signs in as the admin (`admin` / `correct horse battery`
//   unless given), saves a few songs and an album, and adds a playlist "Touch targets" it leaves
//   behind. It plays music, so start Chromium muted or turn the volume down.
//   --shots  also capture each screen there, with the controls that fail outlined
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

const args = process.argv.slice(2)
const option = name => (args.includes(name) ? args[args.indexOf(name) + 1] : null)
const base = args.find((arg, index) => !arg.startsWith('--') && !args[index - 1]?.startsWith('--')) ?? 'http://localhost:5173'
const credentials = { username: option('--username') ?? 'admin', password: option('--password') ?? 'correct horse battery' }
const shots = option('--shots')
const headers = { 'X-Squirmy-Client': 'web', 'X-Squirmy-Request': '1' }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let failed = 0
let total = 0

function check(name, ok, detail = '') {
  total += 1
  if (!ok) failed += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail === '' ? '' : `\n${detail}`}`)
}

/** Runs a step; a thrown error fails it and the run carries on with the next one. */
async function step(name, body) {
  try {
    await body()
  } catch (error) {
    check(name, false, `      ${error.message.split('\n')[0]}`)
  }
}

/**
 * Controls that need not be 44 px, and why. Each is a CSS selector matched against the control.
 * Keep this short: a control a finger presses on its own belongs in the check.
 */
const exceptions = [
  // Credits and album names inside a song's row are words in a 44 px row, not buttons beside it:
  // a tap on the row plays the song, and the row's menu (44 px items) goes to the album and each
  // artist. Growing them would cover the row they sit in.
  { selector: '[data-slot="track-row"] a', reason: 'credit links inside a song row' },
  // On a touch screen a tap anywhere on a song's row plays it; the play button over the number
  // or artwork is for the keyboard and the mouse, and the row around it is the finger's target.
  { selector: '[data-slot="track-row"] [data-slot="row-play"]', reason: 'a song row plays on a tap anywhere' },
  // Links inside running text (a credit line under a title, a biography) are words in a sentence (WCAG 2.5.8's inline exception).
  { selector: '[data-inline-links] a', reason: 'links in a line of text' },
  // A card's own words under its artwork: the artwork above is the card's large target and leads to the same page.
  { selector: '[data-slot="card"] [data-slot="card-text"] a', reason: 'a card’s title and credit under its artwork' },
  // Text the Tab order reaches so its words can be scrolled with the keyboard (lyrics), not pressed.
  { selector: '[data-slot="lyrics"]', reason: 'scrollable text' },
  // The sidebar's edge, dragged by a pointer or moved with the arrow keys. A finger-wide handle
  // would cover the sidebar's links on one side and the page's on the other.
  { selector: '[role=separator][aria-label="Resize sidebar"]', reason: 'a drag handle on the sidebar’s edge' },
]

/** In the page: every visible control and whether a finger has 44 × 44 px of it to press. */
function audit({ exceptions, size, scope }) {
  const selector = [
    'button', 'a[href]', 'input:not([type=hidden])', 'select', 'textarea', 'summary',
    '[role=button]', '[role=tab]', '[role=switch]', '[role=slider]', '[role=menuitem]', '[role=menuitemradio]', '[role=menuitemcheckbox]',
    '[role=option]', '[role=checkbox]', '[role=radio]', '[tabindex]:not([tabindex="-1"])',
  ].join(', ')
  const describe = element => {
    if (!element) return 'nothing'
    const label = element.getAttribute('aria-label') ?? element.textContent?.trim().replace(/\s+/g, ' ').slice(0, 40) ?? ''
    return `<${element.tagName.toLowerCase()}${element.getAttribute('role') ? ` role=${element.getAttribute('role')}` : ''}> "${label}"`
  }
  // The center and two rings of eight within the 44 px circle around it: a round 44 px button
  // passes (Chromium does not count presses outside a rounded corner), and so does a square one.
  // The outer ring is a pixel inside the edge: hit testing rounds a box at a half pixel.
  const radius = size / 2 - 1
  const points = [[0, 0], ...[radius, radius / 2].flatMap(r => Array.from({ length: 8 }, (_, i) => [r * Math.cos(i * Math.PI / 4), r * Math.sin(i * Math.PI / 4)]))]
  const results = []
  // Over a popover, only what it holds: the page beside it is not covered by a scrim, but under it.
  const root = scope ? [...document.querySelectorAll(scope)].at(-1) : document
  for (const element of root.querySelectorAll(selector)) {
    // Out of reach: behind a modal (hidden and inert), disabled, or not drawn.
    if (element.closest('[inert], [aria-hidden="true"]')) continue
    if (element.matches(':disabled, [aria-disabled="true"], [data-disabled]')) continue
    if (!element.checkVisibility({ visibilityProperty: true })) continue
    if (getComputedStyle(element).pointerEvents === 'none') continue
    let rect = element.getBoundingClientRect()
    // Visually hidden until focused, as a skip link is.
    if (rect.width < 3 || rect.height < 3) continue
    const exception = exceptions.find(entry => element.matches(entry.selector))
    if (exception) continue
    // A slider's thumb follows a press anywhere on its slider; a field's label presses it too.
    const slider = element.getAttribute('role') === 'slider' ? element.parentElement?.closest('[data-orientation]') : null
    const owners = [slider ?? element, ...(element.labels ?? [])]
    const owns = hit => owners.some(owner => owner.contains(hit))

    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    rect = element.getBoundingClientRect()
    let cx = rect.left + rect.width / 2
    let cy = rect.top + rect.height / 2
    // A slider is pressed anywhere along it: its thumb at either end does not make it smaller.
    if (slider) {
      const band = slider.getBoundingClientRect()
      cx = Math.min(Math.max(cx, band.left + size / 2), band.right - size / 2)
      cy = band.top + band.height / 2
    }
    const inView = (x, y) => x >= 0 && y >= 0 && x < innerWidth && y < innerHeight
    if (!inView(cx, cy)) continue
    let misses = 0
    let missedOn = null
    for (const [dx, dy] of points) {
      const x = cx + dx
      const y = cy + dy
      // The screen's edge stops a finger as well as a target's edge does.
      if (!inView(x, y)) continue
      const hit = document.elementFromPoint(x, y)
      if (!owns(hit)) {
        misses += 1
        missedOn ??= hit
      }
    }
    if (!misses) continue
    // How far a press still lands on it from its center, for the report.
    const reach = (dx, dy) => {
      let n = 0
      while (n < size && inView(cx + dx * (n + 1), cy + dy * (n + 1)) && owns(document.elementFromPoint(cx + dx * (n + 1), cy + dy * (n + 1)))) n += 1
      return n
    }
    const width = reach(-1, 0) + reach(1, 0) + 1
    const height = reach(0, -1) + reach(0, 1) + 1
    element.setAttribute('data-touch-fail', '')
    results.push(`${describe(element)} has ${width}×${height} px (drawn ${Math.round(rect.width)}×${Math.round(rect.height)}); ${misses}/${points.length} presses land on ${describe(missedOn)}`)
  }
  return results
}

/**
 * In the page: controls outside the page's scroll container that lie over it, with what of the
 * page shows under them. Under a control, the page's words, pictures or controls must be covered
 * (by a bar with a background) or absent.
 */
function floatingOverlaps() {
  const main = document.querySelector('main')
  if (!main) return []
  const area = main.getBoundingClientRect()
  const controls = [...document.querySelectorAll('button, a[href], [role=button]')].filter(control => {
    if (main.contains(control) || control.closest('[inert], [aria-hidden="true"], [role=dialog]')) return false
    const box = control.getBoundingClientRect()
    return box.width > 2 && box.height > 2 && control.checkVisibility({ visibilityProperty: true })
      && box.left < area.right && box.right > area.left && box.top < area.bottom && box.bottom > area.top
  })
  const ownText = element => [...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim())
  const isContent = element => ownText(element) || element.matches('img, svg, video, canvas, button, a[href], input, select, textarea, [role=button]')
  const opaque = element => {
    const style = getComputedStyle(element)
    const alpha = Number(/rgba?\(([^)]+)\)/.exec(style.backgroundColor)?.[1].split(',')[3] ?? 1)
    return (style.backgroundColor !== 'rgba(0, 0, 0, 0)' && alpha >= 0.5) || style.backdropFilter !== 'none'
  }
  const found = []
  for (const control of controls) {
    const box = control.getBoundingClientRect()
    const points = [[0.5, 0.5], [0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8]].map(([x, y]) => [box.left + box.width * x, box.top + box.height * y])
    for (const [x, y] of points) {
      for (const element of document.elementsFromPoint(x, y)) {
        if (control.contains(element) || element.contains(control)) continue
        if (main.contains(element) && isContent(element)) {
          found.push(`"${control.getAttribute('aria-label') ?? control.textContent.trim()}" lies over <${element.tagName.toLowerCase()}> "${(element.textContent ?? '').trim().slice(0, 30)}"`)
          break
        }
        if (opaque(element)) break
      }
    }
  }
  return [...new Set(found)]
}

/** A floating control lies over nothing of the page, at its top and scrolled down. */
async function noOverlap(page, name, viewport) {
  const results = []
  for (const offset of [0, 240, 600]) {
    await page.evaluate(top => document.querySelector('main')?.scrollTo({ top, behavior: 'instant' }), offset)
    await sleep(150)
    results.push(...(await page.evaluate(floatingOverlaps)).map(line => `at ${offset} px: ${line}`))
  }
  await page.evaluate(() => document.querySelector('main')?.scrollTo({ top: 0, behavior: 'instant' }))
  check(`${viewport}: ${name}: nothing floats over the page`, results.length === 0, results.map(line => `      ${line}`).join('\n'))
}

let shotIndex = 0
async function audited(page, name, viewport, scope = null) {
  // Let entering animations and lazy images settle.
  await sleep(500)
  if (!scope) await noOverlap(page, name, viewport)
  const failures = await page.evaluate(audit, { exceptions, size: 44, scope })
  check(`${viewport}: ${name}`, failures.length === 0, failures.map(line => `      ${line}`).join('\n'))
  if (shots) {
    await page.addStyleTag({ content: '[data-touch-fail] { outline: 2px solid red !important; outline-offset: 0 !important; }' })
    await page.screenshot({ path: path.join(shots, `${String(++shotIndex).padStart(2, '0')}-${viewport}-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`) })
  }
  await page.evaluate(() => document.querySelectorAll('[data-touch-fail]').forEach(element => element.removeAttribute('data-touch-fail')))
}

async function api(context, method, url, data) {
  const response = await context.request.fetch(`${base}/api/v1${url}`, { method, headers, data })
  if (!response.ok()) throw new Error(`${method} ${url}: ${response.status()} ${await response.text()}`)
  return response.status() === 204 ? null : response.json()
}

if (shots) await mkdir(shots, { recursive: true })
const browser = await chromium.launch({ args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'] })

// What the pages show: an album with featured artists, its lead artist, a playlist, saved songs.
const seed = await browser.newContext()
await api(seed, 'POST', '/auth/login', credentials)
const albums = (await api(seed, 'GET', '/library/albums?limit=100')).items
const album = [...albums].sort((a, b) => b.trackCount - a.trackCount).find(candidate => candidate.artists.length === 1 && candidate.artists[0].name !== 'Various Artists') ?? albums[0]
const detail = await api(seed, 'GET', `/albums/${album.id}`)
const songs = detail.discs.flatMap(disc => disc.tracks)
await api(seed, 'PUT', `/me/likes/album/${album.id}`)
for (const song of songs.slice(0, 3)) await api(seed, 'PUT', `/me/likes/track/${song.id}`)
const playlists = await api(seed, 'GET', '/playlists')
let playlist = (playlists.items ?? playlists).find(candidate => candidate.name === 'Touch targets')
playlist ??= await api(seed, 'POST', '/playlists', { name: 'Touch targets', description: 'Songs for the touch target check.' })
if (!(await api(seed, 'GET', `/playlists/${playlist.id}`)).items.length) {
  await api(seed, 'POST', `/playlists/${playlist.id}/items`, { tracks: songs.slice(0, 5).map(song => ({ trackId: song.id })) })
}
await seed.close()

for (const [viewport, size] of [['small phone', { width: 320, height: 640 }], ['phone', { width: 390, height: 844 }], ['tablet', { width: 768, height: 1024 }]]) {
  const context = await browser.newContext({ viewport: size, hasTouch: true, isMobile: true, deviceScaleFactor: 2 })
  await api(context, 'POST', '/auth/login', credentials)
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  page.on('pageerror', error => console.log(`page error: ${error.message}`))
  const visit = async (route, ready) => {
    await page.goto(`${base}${route}`)
    await ready()
  }
  const main = page.locator('main')
  const tapButton = (name, scope = page) => scope.getByRole('button', { name, exact: true }).filter({ visible: true }).first().tap()

  await page.goto(base)
  check(`${viewport}: the pointer is coarse`, await page.evaluate(() => matchMedia('(pointer: coarse)').matches))

  await step(`${viewport}: Home`, async () => {
    await visit('/', () => main.getByRole('heading').first().waitFor())
    await audited(page, 'Home', viewport)
  })
  await step(`${viewport}: Search`, async () => {
    await visit(`/search?q=${encodeURIComponent(album.artistCredit)}`, () => main.getByText(album.title).first().waitFor())
    await audited(page, 'Search with results', viewport)
  })
  for (const filter of ['all', 'albums', 'artists', 'songs', 'playlists']) {
    await step(`${viewport}: Library ${filter}`, async () => {
      await visit(`/library?filter=${filter}`, () => main.getByRole('heading', { name: 'Library' }).waitFor())
      await sleep(500)
      await audited(page, `Library ${filter}`, viewport)
    })
  }
  await step(`${viewport}: album`, async () => {
    await visit(`/album/${album.id}`, () => main.getByRole('list', { name: `${album.title} tracks` }).waitFor())
    await audited(page, 'album', viewport)
  })
  await step(`${viewport}: track menu`, async () => {
    // The album's first row by its place, not by its song's name: an album can list two songs of one name.
    const first = main.getByRole('list', { name: `${album.title} tracks` }).getByRole('listitem').first()
    await first.getByRole('button', { name: /^More options for / }).tap()
    await page.getByRole('menu').waitFor()
    await audited(page, 'track menu', viewport)
    await page.keyboard.press('Escape')
  })
  await step(`${viewport}: artist`, async () => {
    await visit(`/artist/${album.artists[0].id}`, () => main.getByRole('heading', { name: album.artists[0].name }).waitFor())
    await audited(page, 'artist', viewport)
  })
  await step(`${viewport}: playlist`, async () => {
    await visit(`/playlist/${playlist.id}`, () => main.getByRole('list').first().waitFor())
    await audited(page, 'playlist', viewport)
  })
  await step(`${viewport}: Liked Songs`, async () => {
    await visit('/liked', () => main.getByRole('list').first().waitFor())
    await audited(page, 'Liked Songs', viewport)
  })
  await step(`${viewport}: Settings`, async () => {
    for (const section of ['playback', 'appearance', 'account', 'scrobbling', 'app-passwords', 'about']) {
      await visit(`/settings/${section}`, () => page.getByRole('dialog').waitFor())
      await audited(page, `Settings ${section}`, viewport)
    }
    await visit('/settings/account', () => page.getByRole('dialog').waitFor())
    await tapButton('Change password', page.getByRole('dialog'))
    await page.getByRole('dialog', { name: 'Change password' }).waitFor()
    await audited(page, 'Change password', viewport)
  })
  if (viewport !== 'tablet') {
    await step(`${viewport}: sidebar drawer`, async () => {
      await visit('/', () => main.getByRole('heading').first().waitFor())
      await tapButton('Open sidebar')
      await page.getByRole('button', { name: 'Close sidebar' }).waitFor()
      await audited(page, 'sidebar drawer', viewport)
      await page.keyboard.press('Escape')
    })
  }

  // Playing: the player, Devices, Now Playing with its queue and lyrics.
  await step(`${viewport}: player`, async () => {
    await visit(`/album/${album.id}`, () => main.getByRole('list', { name: `${album.title} tracks` }).waitFor())
    await tapButton(`Play ${album.title}`, main)
    await page.getByRole('button', { name: /^Pause/ }).first().waitFor()
    await audited(page, 'playing', viewport)
    await tapButton('Devices')
    await page.getByRole('dialog').waitFor()
    await audited(page, 'Devices', viewport, '[role=dialog]')
    await page.keyboard.press('Escape')
    if (viewport === 'tablet') {
      await tapButton('Queue')
      await page.getByRole('heading', { name: 'Queue' }).first().waitFor()
      await audited(page, 'queue panel', viewport, 'aside[aria-label="Queue"]')
      await page.keyboard.press('Escape')
    }
    await page.getByRole('button', { name: 'Open Now Playing' }).or(page.getByRole('button', { name: 'Now Playing', exact: true })).first().tap()
    await page.getByRole('dialog', { name: /Now Playing/ }).waitFor()
    await audited(page, 'Now Playing', viewport)
    await tapButton('Show queue')
    await sleep(300)
    await audited(page, 'Now Playing queue', viewport)
    await tapButton('Show lyrics')
    await sleep(300)
    await audited(page, 'Now Playing lyrics', viewport)
    await page.keyboard.press('Escape')
    await tapButton('Pause').catch(() => {})
  })
  await context.close()
}

await browser.close()
console.log(`\n${total - failed}/${total} passed`)
process.exit(failed ? 1 : 0)
