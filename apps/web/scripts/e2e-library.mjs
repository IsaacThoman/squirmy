// Walks the single heart and the combined Library in real Chromium against a server that has
// not been set up yet: the old list addresses land on the combined view, no separate "Add to
// library" control is left, an album hearted from search shows under Albums and leaves when
// unhearted, and a hearted song shows in Liked Songs and under Songs. The mock provider is
// registered so saving behaves as it does for someone the server fetches music for; it answers
// slowly, so nothing it delivers lands while the checks run.
// Catalog search talks to MusicBrainz and Deezer, so a run takes a few minutes.
//
// Usage: node scripts/e2e-library.mjs <baseUrl> --api <serverUrl> --demo <dir> --work <dir> [--mock-port <port>] [--shots <dir>]
//   --api   the server itself (the mock provider delivers to it), e.g. http://127.0.0.1:4747
//   --demo  a library made by `npm run demo:library -w @squirmy/server -- <dir>` (read, never changed)
//   --work  an empty scratch directory for the library folder
//   --shots also capture screenshots there
import { cp, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { createMockProvider } from '@squirmy/adapter-mock'
import { chromium } from 'playwright'

const args = process.argv.slice(2)
const option = name => (args.includes(name) ? args[args.indexOf(name) + 1] : null)
const base = args.find((arg, index) => !arg.startsWith('--') && !args[index - 1]?.startsWith('--')) ?? 'http://localhost:5173'
const server = option('--api')
const demo = option('--demo')
const work = option('--work')
const shots = option('--shots')
const mockPort = Number(option('--mock-port') ?? 4801)
if (!server || !demo || !work) throw new Error('Usage: node scripts/e2e-library.mjs <baseUrl> --api <serverUrl> --demo <dir> --work <dir> [--mock-port <port>] [--shots <dir>]')

const admin = { username: 'admin', password: 'correct horse battery' }
const headers = { 'X-Squirmy-Client': 'web', 'X-Squirmy-Request': '1' }
const library = path.resolve(work, 'library')
const minutes = n => n * 60_000
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
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

/** Polls `read` until `test` passes or `timeoutMs` runs out; returns the last value read. */
async function until(read, test, timeoutMs = 5000, everyMs = 250) {
  const end = Date.now() + timeoutMs
  let value = await read()
  while (!test(value) && Date.now() < end) {
    await sleep(everyMs)
    value = await read()
  }
  return value
}

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
page.setDefaultTimeout(20_000)
page.on('pageerror', error => console.log(`page error: ${error.message}`))
const heading = (name, scope = page) => scope.getByRole('heading', { name, exact: true })
const button = (name, scope = page) => scope.getByRole('button', { name, exact: true }).filter({ visible: true }).first()
const main = () => page.getByRole('main')
const toastText = text => page.getByText(text, { exact: true }).first()
/** Whether `locator` shows within a few seconds: pages draw a preview header before the real one. */
const shows = (locator, timeout = 5000) => locator.waitFor({ timeout }).then(() => true, () => false)
/** Titles as the catalog and the library spell them can differ in case ("At" and "at"). */
const loosely = title => new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')
const chosenFilter = () => page.getByRole('navigation', { name: 'Library filters' }).locator('[aria-current="page"]').textContent()

async function api(method, route, data) {
  const response = await context.request.fetch(`${base}/api/v1${route}`, { method, headers, data })
  const body = await response.json().catch(() => null)
  return { status: response.status(), body }
}
const get = async route => (await api('GET', route)).body

/** What is on screen now, toasts and the pointer out of the way unless asked. */
async function shoot(name, { toasts = false, width = 1440, height = 900, scheme = 'light' } = {}) {
  if (!shots) return
  if (!toasts) for (const close of await page.getByRole('button', { name: 'Dismiss' }).all()) await close.click().catch(() => {})
  await page.emulateMedia({ colorScheme: scheme })
  await page.setViewportSize({ width, height })
  await sleep(400)
  await page.screenshot({ path: path.join(shots, `${name}.png`) })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize({ width: 1440, height: 900 })
}

/** The Library under `filter`, once its first tiles or rows are in. */
async function openLibrary(filter) {
  await page.goto(`${base}/library?filter=${filter}`)
  await heading('Library').waitFor()
  await main().getByRole('list').first().waitFor()
}

const titlesIn = list => list.getByRole('listitem').evaluateAll(items => items.map(item => item.querySelector('a')?.textContent ?? ''))

await step('prepare and set up the server', async () => {
  await mkdir(library, { recursive: true })
  for (const album of ['Mira Vale/Blue Hour', 'Lune Park/Slow Motion', 'Radiohead/OK Computer']) await cp(path.join(demo, album), path.join(library, album), { recursive: true })
  check('the admin is created', (await api('POST', '/setup', admin)).status === 200)
  await api('POST', '/admin/library/roots', { name: 'Music', path: library, mode: 'read_only', watch: false })
  const stats = await until(() => get('/admin/library/stats'), value => value.tracks > 0 && value.pending === 0, minutes(5), 2000)
  check('the library on disk is scanned', stats.pending === 0 && stats.albums > 0, `${stats.albums} albums, ${stats.tracks} tracks`)
})

const mock = createMockProvider({ secret: 'mock-provider-secret', delayMs: minutes(10) })
await mock.listen(mockPort, '127.0.0.1')

await step('the mock provider', async () => {
  const created = await api('POST', '/admin/acquisition/providers', { name: 'Shelf', baseUrl: `http://127.0.0.1:${mockPort}`, secret: 'mock-provider-secret' })
  await api('PATCH', '/admin/acquisition/policy', { deliveryBaseUrl: server })
  check('the mock provider is registered', created.status === 200 || created.status === 201, String(created.status))
})

await step('old addresses', async () => {
  for (const [old, filter, chip] of [['albums', 'albums', 'Albums'], ['artists', 'artists', 'Artists'], ['songs', 'songs', 'Songs'], ['playlists', 'playlists', 'Playlists']]) {
    await page.goto(`${base}/library/${old}`)
    await page.waitForURL(url => url.pathname === '/library' && url.searchParams.get('filter') === filter)
    await heading('Library').waitFor()
    check(`/library/${old} lands on the combined view with ${chip} chosen`, (await chosenFilter()) === chip, page.url())
  }
  await page.goto(`${base}/liked`)
  await heading('Liked Songs').waitFor()
  check('Liked Songs keeps its own page', new URL(page.url()).pathname === '/liked')
})

await step('the sidebar and the combined view', async () => {
  const nav = page.getByRole('navigation', { name: 'Main' }).first()
  const links = await nav.getByRole('link').allTextContents()
  check('the sidebar has one Library entry and no Albums, Artists or Songs', links.some(text => text.startsWith('Library')) && !links.some(text => /^(Albums|Artists|Songs)$/.test(text.trim())), links.join(' | '))
  await nav.getByRole('link', { name: 'Library' }).click()
  await heading('Library').waitFor()
  check('it opens the Library on the filter last chosen', (await chosenFilter()) === 'Playlists', page.url())
  await openLibrary('all')
  const all = main().getByRole('list', { name: 'Library' })
  const titles = await titlesIn(all)
  check('All starts with Liked Songs, then the albums', titles[0] === 'Liked Songs' && titles.length > 1, titles.slice(0, 4).join(' | '))
  check('there is no genre menu', !(await page.getByRole('combobox', { name: 'Genre' }).count()))
  await shoot('library-all-grid')
  await shoot('library-all-dark', { scheme: 'dark' })
  await shoot('library-all-phone', { width: 390, height: 844 })
  await button('Show list view').click()
  await main().getByRole('list', { name: 'Library' }).getByRole('link', { name: /Liked Songs/ }).waitFor()
  check('the list view shows rows', !(await main().getByRole('button', { name: /^Play / }).count()))
  await shoot('library-all-list')
  await page.reload()
  await heading('Library').waitFor()
  check('the list view is remembered', await button('Show grid view').isVisible())
  await button('Show grid view').click()
  await openLibrary('albums')
  await shoot('library-albums')
})

await step('no separate library button is left', async () => {
  const blueHour = (await get('/library/albums?sort=title&limit=200')).items.find(album => album.title === 'Blue Hour')
  if (!blueHour) throw new Error('Blue Hour is not in the library')
  await page.goto(`${base}/album/${blueHour.id}`)
  await heading('Blue Hour').waitFor()
  const header = page.locator('header').filter({ has: heading('Blue Hour') })
  check('a collection album has the heart', await shows(header.getByRole('button', { name: /^(Save to|Remove from) library$/ })))
  check('and no Add to library or On this server', !(await page.getByRole('button', { name: /Add to library/ }).count()) && !(await page.getByRole('img', { name: 'On this server' }).count()))
  await shoot('album-header-heart')
  await button('More options').click()
  const albumMenu = await page.getByRole('menuitem').allTextContents()
  check('the album menu has one entry worded like the heart', albumMenu.filter(item => /library|like/i.test(item)).length === 1, albumMenu.join(' | '))
  await page.keyboard.press('Escape')
  const row = main().getByRole('listitem').filter({ hasText: 'Soft Signal' }).first()
  await row.hover()
  await row.getByRole('button', { name: 'More options for Soft Signal' }).click()
  const trackMenu = await page.getByRole('menuitem').allTextContents()
  check('a song’s menu has Save to library and nothing about Liked Songs or Add', trackMenu.includes('Save to library') && !trackMenu.some(item => /Add to library|Liked Songs/.test(item)), trackMenu.join(' | '))
  await shoot('track-menu-save')
  await page.keyboard.press('Escape')
})

/** Catalog results for a query, as the server rates them for this user. */
const catalog = async q => get(`/search/catalog?q=${encodeURIComponent(q)}&limit=20`)
const query = 'Boards of Canada'
let picked = null

await step('heart an album from search', async () => {
  const results = await until(() => catalog(query), value => value?.albums?.length > 0, 30_000, 1000)
  picked = results.albums.find(album => album.availability === 'none' || album.availability === 'on_demand')
  if (!picked) throw new Error('no album the library lacks')
  await page.goto(`${base}/search?q=${encodeURIComponent(query)}`)
  await main().getByRole('link', { name: picked.title, exact: true }).first().click({ timeout: 30_000 })
  await heading(picked.title).waitFor()
  await button('Save to library').click()
  await toastText('Saved to your library').waitFor()
  check('the heart fills at once, with a toast', await shows(button('Remove from library')))
  await openLibrary('albums')
  const albums = main().getByRole('list', { name: 'Albums' })
  await albums.getByRole('link', { name: loosely(picked.title) }).first().waitFor({ timeout: 15_000 })
  check('it shows in Library → Albums', true, picked.title)
})

await step('unheart it', async () => {
  if (!picked) throw new Error('nothing was hearted')
  await page.goto(`${base}/album/${picked.id}`)
  await heading(picked.title).waitFor()
  await button('Remove from library').click()
  await toastText('Removed from your library').waitFor()
  await openLibrary('albums')
  await sleep(1000)
  const titles = await titlesIn(main().getByRole('list', { name: 'Albums' }))
  check('it leaves Library → Albums', !titles.some(title => loosely(picked.title).test(title)), titles.join(' | '))
})

await step('heart a song', async () => {
  const results = await until(() => catalog(query), value => value?.tracks?.some(track => track.availability !== 'server'), 30_000, 1000)
  const song = results.tracks.slice(0, 6).find(track => track.availability !== 'server' && !track.liked)
  if (!song) throw new Error('no song the library lacks')
  await page.goto(`${base}/search?q=${encodeURIComponent(query)}`)
  const name = new RegExp(`^Save ${loosely(song.title).source.slice(1, -1)} to library$`, 'i')
  const row = main().getByRole('listitem').filter({ has: page.getByRole('button', { name }) }).first()
  await row.waitFor({ timeout: 30_000 })
  await row.hover()
  await row.getByRole('button', { name }).click()
  await toastText('Saved to your library').waitFor()
  check('its heart fills at once', await shows(main().getByRole('button', { name: new RegExp(`^Remove ${loosely(song.title).source.slice(1, -1)} from library$`, 'i') }).first()))
  await page.goto(`${base}/liked`)
  await page.getByRole('list', { name: 'Liked Songs tracks' }).getByText(loosely(song.title)).first().waitFor()
  check('it shows in Liked Songs', true, song.title)
  // Saved last, it leads the songs in their default order.
  await openLibrary('songs')
  check('and under Songs', await shows(main().getByRole('list', { name: 'Songs' }).getByText(loosely(song.title)).first(), 15_000))
  await shoot('library-songs')
  const saved = await get('/library/tracks?sort=recent&limit=200')
  check('the server lists it among the library’s songs', saved.items.some(track => track.id === song.id))
})

await mock.close()
await browser.close()
console.log(`${total - failed} of ${total} checks passed`)
process.exit(failed ? 1 : 0)
