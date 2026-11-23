// Walks the single heart and the combined Library in real Chromium against a server that has
// not been set up yet: the old list addresses land on the combined view, no separate "Add to
// library" control is left, an album hearted from search shows under Albums and leaves when
// unhearted, and a hearted song shows in Liked Songs and under Songs. Each heart is its own
// confirmation: nothing floats over the page to say what it did. Then the Library's rows and
// cards: album cards carry the album page's menu (⋯ and right-click, its entries saying what they
// did), list rows keep their play buttons, a search under All lists the songs it matched, a
// removal offers no Undo and a save made again leads, a failed playlist list or library search
// says so and recovers, a search keeps to the genre chosen, a refused save goes back and says so
// beside its heart, and Home's hero leaves its rail. The failures are made in the browser (the
// server is never broken). The mock provider is
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

/** What is on screen now. */
async function shoot(name, { width = 1440, height = 900, scheme = 'light' } = {}) {
  if (!shots) return
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

/**
 * The server's answer to a heart's save or removal. A step that reloads the page right after a
 * heart waits for it, as a reload drops a request still on its way.
 */
const answered = (method, kind) => page.waitForResponse(response => response.request().method() === method && new URL(response.url()).pathname.startsWith(`/api/v1/me/likes/${kind}/`))

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
  check('the list view shows rows that keep their play buttons', await main().getByRole('list', { name: 'Library' }).getByRole('button', { name: 'Play Liked Songs' }).count() === 1)
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
  // Search is one ranked list (#117): an album's row links as "Title, Album · Artist".
  await main().getByRole('link', { name: new RegExp(`^${loosely(picked.title).source.slice(1, -1)}, `, 'i') }).first().click({ timeout: 30_000 })
  await heading(picked.title).waitFor()
  const saved = answered('PUT', 'album')
  await button('Save to library').click()
  check('the heart fills at once', await shows(button('Remove from library'), 2000))
  check('and nothing else says it was saved', !(await page.getByText(/^Saved to (your )?library$/).count()))
  await saved
  await openLibrary('albums')
  const albums = main().getByRole('list', { name: 'Albums' })
  await albums.getByRole('link', { name: loosely(picked.title) }).first().waitFor({ timeout: 15_000 })
  check('it shows in Library → Albums', true, picked.title)
})

await step('unheart it', async () => {
  if (!picked) throw new Error('nothing was hearted')
  await page.goto(`${base}/album/${picked.id}`)
  await heading(picked.title).waitFor()
  const removed = answered('DELETE', 'album')
  await button('Remove from library').click()
  check('the heart empties at once', await shows(button('Save to library'), 2000))
  await removed
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
  // The ranked list's rows are listbox options.
  const row = main().getByRole('option').filter({ has: page.getByRole('button', { name }) }).first()
  await row.waitFor({ timeout: 30_000 })
  await row.hover()
  const liked = answered('PUT', 'track')
  await row.getByRole('button', { name }).click()
  check('its heart fills at once', await shows(main().getByRole('button', { name: new RegExp(`^Remove ${loosely(song.title).source.slice(1, -1)} from library$`, 'i') }).first()))
  await liked
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

const albumsByTitle = async () => new Map((await get('/library/albums?sort=title&limit=200')).items.map(album => [album.title, album]))
const menuItems = () => page.getByRole('menuitem').allTextContents()
const searchBox = () => page.getByRole('searchbox', { name: 'Find in your library' })
const busy = { status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unavailable', message: 'The server is busy. Try again in a moment.' } }) }
/** Answers 503 to the `method` requests for one API path, as an outage would; returns the undo. */
async function outage(pathname, method = 'GET') {
  const matches = url => url.pathname === pathname || (pathname.endsWith('/') && url.pathname.startsWith(pathname))
  const handler = route => (route.request().method() === method ? route.fulfill(busy) : route.fallback())
  await page.route(matches, handler)
  return () => page.unroute(matches, handler)
}
/** The heart in an album page's header, not the player's heart for the song playing. */
const albumHeart = (title, name) => page.locator('header').filter({ has: heading(title) }).getByRole('button', { name, exact: true })
/** Starts the page without what it kept from earlier visits, so what is asked now is all it has. */
async function forgetCache() {
  await page.evaluate(() => new Promise(resolve => {
    const request = indexedDB.deleteDatabase('squirmy-cache')
    request.onsuccess = request.onerror = request.onblocked = () => resolve()
  }))
}

/** Light, then dark, for the pages where both matter. */
async function shootBoth(name, options = {}) {
  await shoot(`${name}-light`, options)
  await shoot(`${name}-dark`, { ...options, scheme: 'dark' })
}

await step('album cards have the album page’s menu', async () => {
  await openLibrary('albums')
  const albums = main().getByRole('list', { name: 'Albums' })
  const card = albums.getByRole('listitem').filter({ has: page.getByRole('link', { name: 'Blue Hour', exact: true }) }).first()
  await card.hover()
  await card.getByRole('button', { name: 'More options for Blue Hour' }).click()
  // The one library entry waits for the album, which says whether it is saved.
  await page.getByRole('menuitem', { name: /^(Save to|Remove from) library$/, disabled: false }).waitFor()
  const items = await menuItems()
  check('⋯ on a card opens Play, Play next, Add to queue, Add to playlist, the library entry and Go to the artist',
    ['Play', 'Play next', 'Add to queue', 'Add to playlist'].every((item, index) => items[index] === item)
    && items.filter(item => /library/.test(item)).length === 1 && items.at(-1) === 'Go to Mira Vale', items.join(' | '))
  await shootBoth('library-card-menu')
  await page.getByRole('menuitem', { name: 'Add to queue' }).click()
  // The entry says it worked for a moment, then its menu closes.
  check('Add to queue from a card says so on the entry', await shows(page.getByRole('menuitem', { name: 'Added to queue' }), 2000))
  check('and its menu then closes', await page.getByRole('menu').waitFor({ state: 'detached', timeout: 3000 }).then(() => true, () => false))

  await albums.getByRole('link', { name: 'Slow Motion', exact: true }).first().click({ button: 'right' })
  const context = await until(menuItems, list => list.includes('Go to Lune Park'))
  check('a right-click on a card opens the same menu', context[0] === 'Play' && context.at(-1) === 'Go to Lune Park', context.join(' | '))
  await page.keyboard.press('Escape')

  await page.goto(`${base}/`)
  await page.getByRole('region', { name: 'Featured' }).waitFor()
  const more = main().getByRole('button', { name: /^More options for / }).first()
  check('Home’s album rails have it too', await shows(more))
})

await step('the list layout keeps one-click play', async () => {
  const blueHour = (await albumsByTitle()).get('Blue Hour')
  const first = (await get(`/albums/${blueHour.id}`)).discs[0].tracks[0]
  await openLibrary('all')
  await button('Show list view').click()
  const list = main().getByRole('list', { name: 'Library' })
  const row = list.getByRole('listitem').filter({ has: page.getByRole('link', { name: /^Blue Hour/ }) }).first()
  await row.hover()
  const play = row.getByRole('button', { name: 'Play Blue Hour' })
  await sleep(300)
  check('a hovered album row shows the card’s play button', Number(await play.evaluate(element => getComputedStyle(element).opacity)) > 0.9)
  check('Liked Songs keeps its play button as a row', await list.getByRole('button', { name: 'Play Liked Songs' }).count() === 1)
  await shootBoth('library-list-play')
  // The keyboard reaches it as on a card: focus it and press Enter.
  await play.focus()
  await page.keyboard.press('Enter')
  check('Enter on a row’s play button plays the album', await page.waitForFunction(title => document.title.startsWith(title), first.title, { timeout: 15_000 }).then(() => true, () => false), first.title)
  await button('Pause').click().catch(() => {})
  await button('Show grid view').click()
})

await step('a search under All lists the songs it matched', async () => {
  await openLibrary('all')
  await searchBox().fill('Soft Signal')
  const songs = main().getByRole('region', { name: 'Songs' })
  check('the song shows under All, in a Songs group', await shows(songs.getByText('Soft Signal', { exact: true }).first(), 10_000))
  check('and All does not say Nothing found', !(await heading('Nothing found').count()))
  await shootBoth('library-all-search-songs')
  await searchBox().fill('qqzzxxjj')
  check('Nothing found when nothing of any kind matched', await shows(heading('Nothing found'), 10_000))
  await searchBox().fill('')
})

await step('a removal offers no Undo, and a save made again leads', async () => {
  const titles = await albumsByTitle()
  const [older, newer] = [titles.get('Blue Hour'), titles.get('Slow Motion')]
  for (const album of [older, newer]) await api('DELETE', `/me/likes/album/${album.id}`)
  // Saved one after the other, from their pages' hearts, so the newer leads.
  for (const album of [older, newer]) {
    await page.goto(`${base}/album/${album.id}`)
    await heading(album.title).waitFor()
    await albumHeart(album.title, 'Save to library').click()
    await albumHeart(album.title, 'Remove from library').waitFor()
    await sleep(1100)
  }
  const order = async () => (await get('/me/likes/album?limit=50')).items.map(item => item.id)
  const before = await until(order, ids => ids.includes(older.id) && ids.includes(newer.id))
  check('the two saves are listed newest first', before.includes(older.id) && before.indexOf(newer.id) < before.indexOf(older.id), before.join(' | '))
  await page.goto(`${base}/album/${older.id}`)
  await heading(older.title).waitFor()
  await albumHeart(older.title, 'Remove from library').click()
  check('the heart empties at once', await shows(albumHeart(older.title, 'Save to library'), 2000))
  check('and nothing offers to undo it', !(await page.getByRole('button', { name: 'Undo' }).count()))
  const removed = await until(order, ids => !ids.includes(older.id), 10_000)
  check('the server no longer lists it', !removed.includes(older.id), removed.join(' | '))
  // The heart is the way back; the save is a new one, so it leads.
  await albumHeart(older.title, 'Save to library').click()
  const after = await until(order, ids => ids.includes(older.id), 10_000)
  check('saved again from its heart, it is the newest save', after[0] === older.id && after.includes(newer.id), after.join(' | '))
})

await step('a failed playlist list keeps the rest of the Library', async () => {
  const restore = await outage('/api/v1/playlists')
  await forgetCache()
  await openLibrary('playlists')
  const notice = page.getByText('Your playlists didn’t load.')
  check('Playlists says the playlists did not load', await shows(notice, 20_000))
  check('and still shows Liked Songs', await main().getByRole('list', { name: 'Playlists' }).getByRole('link', { name: 'Liked Songs' }).count() === 1)
  await shootBoth('library-playlists-failed')
  await forgetCache()
  await openLibrary('all')
  await notice.waitFor({ timeout: 20_000 })
  const titles = await titlesIn(main().getByRole('list', { name: 'Library' }))
  check('All keeps Liked Songs and the albums', titles[0] === 'Liked Songs' && titles.includes('Blue Hour'), titles.join(' | '))
  await shootBoth('library-all-playlists-failed')
  await restore()
  await button('Try again').click()
  check('Try again brings the playlists back', await notice.waitFor({ state: 'detached', timeout: 10_000 }).then(() => true, () => false))
  await openLibrary('playlists')
  check('the count includes Liked Songs, which is listed as a playlist', await shows(page.getByText('1 playlist', { exact: true })))
  await shoot('library-playlists-count')
})

await step('a failed library search says so and recovers', async () => {
  await openLibrary('albums')
  let restore = await outage('/api/v1/search/library')
  await searchBox().fill('Blue')
  const failed = heading('Couldn’t search your library')
  check('the search says it failed, though the list had loaded', await shows(failed, 20_000))
  await shootBoth('library-search-failed')
  await restore()
  await button('Try again').click()
  check('Try again shows the matches', await shows(main().getByRole('list', { name: 'Albums' }).getByRole('link', { name: 'Blue Hour', exact: true }), 10_000))
  restore = await outage('/api/v1/search/library')
  await searchBox().fill('Slow')
  await failed.waitFor({ timeout: 20_000 })
  await searchBox().fill('')
  check('clearing the query brings the list back', await shows(main().getByRole('list', { name: 'Albums' }).getByRole('link', { name: 'Slow Motion', exact: true })))
  await restore()
})

await step('a search keeps to the genre chosen', async () => {
  const titles = await albumsByTitle()
  const genre = (await get(`/albums/${titles.get('Blue Hour').id}`)).genres[0]
  if (!genre) throw new Error('Blue Hour has no genre')
  await page.goto(`${base}/library?${new URLSearchParams({ filter: 'albums', genre })}`)
  await heading('Library').waitFor()
  const asked = page.waitForRequest(request => request.url().includes('/search/library?') && new URL(request.url()).searchParams.get('genre') === genre)
  await searchBox().fill('Blue')
  check('the library search asks for the genre', await asked.then(() => true, () => false), genre)
  check('and finds the album of that genre', await shows(main().getByRole('list', { name: 'Albums' }).getByRole('link', { name: 'Blue Hour', exact: true }), 10_000))
  await shoot('library-genre-search')
  await searchBox().fill('Slow Motion')
  const others = (await get(`/albums/${titles.get('Slow Motion').id}`)).genres
  if (!others.includes(genre)) check('an album of another genre is not found', await shows(heading('Nothing found'), 10_000), others.join(', '))
})

await step('a refused save goes back and says so beside its heart', async () => {
  const album = (await albumsByTitle()).get('OK Computer')
  await api('DELETE', `/me/likes/album/${album.id}`)
  const restore = await outage('/api/v1/me/likes/album/', 'PUT')
  await page.goto(`${base}/album/${album.id}`)
  await heading(album.title).waitFor()
  await albumHeart(album.title, 'Save to library').click()
  // The heart's tooltip holds the refusal open, in the error color.
  const refusal = page.locator('[data-tone="error"]').filter({ hasText: 'Couldn’t save. Try again.' })
  check('the refusal shows beside the heart', await shows(refusal))
  const [tip, heart] = [await refusal.boundingBox(), await albumHeart(album.title, 'Save to library').boundingBox()]
  // Above it, or below where the page's edge leaves no room, and over it side to side.
  const gap = tip && heart ? Math.min(Math.abs(tip.y + tip.height - heart.y), Math.abs(heart.y + heart.height - tip.y)) : Infinity
  check('right by it', gap < 24 && tip.x < heart.x + heart.width && tip.x + tip.width > heart.x, JSON.stringify({ tip, heart }))
  check('the heart is back', await shows(albumHeart(album.title, 'Save to library')))
  check('a screen reader hears which album it was', await shows(page.getByRole('status').filter({ hasText: `Couldn’t save “${album.title}” to your library. Try again.` })))
  check('and nothing says it was saved', !(await page.getByText(/^Saved to (your )?library$/).count()))
  await shootBoth('album-save-refused')
  await restore()
  await albumHeart(album.title, 'Save to library').click()
  check('pressing the heart again saves it', await shows(albumHeart(album.title, 'Remove from library')))
  check('and the refusal goes', await refusal.waitFor({ state: 'detached', timeout: 3000 }).then(() => true, () => false))
  await api('DELETE', `/me/likes/album/${album.id}`)
})

await step('Home’s hero leaves the rail it leads', async () => {
  await page.goto(`${base}/`)
  const featured = page.getByRole('region', { name: 'Featured' })
  await featured.waitFor()
  const home = await get('/home')
  // The page may draw what it kept from an earlier visit first: the steps before saved and
  // removed albums, so it waits for the server's lead before it is compared.
  const leads = home.sections.filter(section => ['recently-played', 'recently-added'].includes(section.id)).map(section => section.albums[0]?.title)
  const title = await until(() => featured.getByRole('heading', { level: 2 }).textContent(), text => leads.includes(text), 10_000)
  const label = await featured.locator('p').first().textContent()
  const source = home.sections.find(section => section.id === (/jump back/i.test(label) ? 'recently-played' : 'recently-added'))
  const rail = page.getByRole('region', { name: source.title, exact: true })
  const inRail = (await rail.count()) ? await rail.getByRole('link', { name: title, exact: true }).count() : 0
  check('the featured album is not repeated in its rail', source.albums[0]?.title === title && inRail === 0, `${label}: ${title}`)
  const order = await main().getByRole('heading', { level: 2 }).allTextContents()
  const sent = home.sections.map(section => section.title).filter(name => order.includes(name))
  check('the sections keep the server’s order', JSON.stringify(order.filter(name => sent.includes(name))) === JSON.stringify(sent), sent.join(' | '))
  await shootBoth('home')
})

await mock.close()
await browser.close()
console.log(`${total - failed} of ${total} checks passed`)
process.exit(failed ? 1 : 0)
