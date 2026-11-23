// Walks adding music and acquisition providers in real Chromium against a server that has
// not been set up yet: uploads of a folder and a zip that end up filed on disk, a duplicate,
// a refused file, an album nobody can identify, pausing and cancelling, the inbox setting,
// and the state without a managed folder. Then providers: the mock provider is added and
// tested, the policy set, missing music plays on demand (the loading spinner, then playing), an album
// is fetched whole, the mock's failing, wrong-file and priced switches are flipped, a member
// without the permission is refused, and Fix match opens from an album page.
// Identification and catalog search talk to MusicBrainz and Deezer, so a run takes minutes.
//
// Usage: node scripts/e2e-imports-providers.mjs <baseUrl> --api <serverUrl> --demo <dir> --work <dir> [--mock-port <port>] [--shots <dir>]
//   --api   the server itself (the mock provider delivers to it), e.g. http://127.0.0.1:4747
//   --demo  a library made by `npm run demo:library -w @squirmy/server -- <dir>` (read, never changed)
//   --work  an empty scratch directory for the library folders, uploads and the inbox
//   --shots also capture screenshots there, light and dark, at 1440, 1024 and 390 wide
// The demo tones and the mock's deliveries are near-silent, and the volume is turned down besides.
import { spawnSync } from 'node:child_process'
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
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
if (!server || !demo || !work) throw new Error('Usage: node scripts/e2e-imports-providers.mjs <baseUrl> --api <serverUrl> --demo <dir> --work <dir> [--shots <dir>]')

const admin = { username: 'admin', password: 'correct horse battery' }
const member = { username: 'robin', password: 'listen closely' }
const headers = { 'X-Squirmy-Client': 'web', 'X-Squirmy-Request': '1' }
const library = path.resolve(work, 'library')
const managed = path.resolve(work, 'managed')
const uploads = path.resolve(work, 'uploads')
const inbox = path.resolve(work, 'inbox')
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

const tree = async dir => (await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []))
  .filter(entry => entry.isFile()).map(entry => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')).sort()

// Uploads: Discovery as a folder (with a text file the server refuses), Abbey Road as a zip,
// Blue Hour again (the library has it), Slow Motion (nobody can identify it), and a single for the inbox.
async function prepare() {
  await mkdir(library, { recursive: true })
  for (const album of ['Radiohead/OK Computer', 'Mira Vale/Blue Hour']) await cp(path.join(demo, album), path.join(library, album), { recursive: true })
  await mkdir(managed, { recursive: true })
  await mkdir(inbox, { recursive: true })
  await cp(path.join(demo, 'Daft Punk', 'Discovery'), path.join(uploads, 'Discovery'), { recursive: true })
  await writeFile(path.join(uploads, 'Discovery', 'notes.txt'), 'ripped on a tuesday\n')
  await cp(path.join(demo, 'Mira Vale', 'Blue Hour'), path.join(uploads, 'Blue Hour'), { recursive: true })
  await cp(path.join(demo, 'Lune Park', 'Slow Motion'), path.join(uploads, 'Slow Motion'), { recursive: true })
  await cp(path.join(demo, 'The Beatles', 'Abbey Road'), path.join(uploads, 'zip', 'Abbey Road'), { recursive: true })
  const zipped = spawnSync('zip', ['-qr', path.join(uploads, 'Abbey Road.zip'), 'Abbey Road'], { cwd: path.join(uploads, 'zip') })
  if (zipped.status !== 0) throw new Error(`zip failed: ${zipped.stderr}`)
  await cp(path.join(demo, 'Singles', 'bad guy.m4a'), path.join(uploads, 'bad guy.m4a'))
}

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
page.setDefaultTimeout(20_000)
page.on('pageerror', error => console.log(`page error: ${error.message}`))
await context.addInitScript(instrumentAudio)
const heading = (name, scope = page) => scope.getByRole('heading', { name, exact: true })
const button = (name, scope = page) => scope.getByRole('button', { name, exact: true }).filter({ visible: true }).first()
const playerBar = (on = page) => on.getByRole('region', { name: 'Player', exact: true })

async function api(method, route, data, on = context) {
  const response = await on.request.fetch(`${base}/api/v1${route}`, { method, headers, data })
  const body = await response.json().catch(() => null)
  return { status: response.status(), body }
}
const get = async route => (await api('GET', route)).body

/**
 * Records every audio element the page creates, so the checks can tell whether the page is
 * really making sound and where it is.
 */
function instrumentAudio() {
  const Native = window.Audio
  window.__audio = []
  window.Audio = function Audio(...rest) {
    const element = new Native(...rest)
    window.__audio.push(element)
    return element
  }
  window.Audio.prototype = Native.prototype
}

/** Whether one audio element plays and moves on with time. */
async function advancing(on = page) {
  const sounding = () => on.evaluate(() => {
    const element = window.__audio.find(audio => !audio.paused && !audio.ended && audio.currentSrc)
    return element ? { src: element.currentSrc, ms: Math.round(element.currentTime * 1000) } : null
  })
  const end = Date.now() + 15_000
  while (Date.now() < end) {
    const first = await sounding()
    await sleep(1000)
    const second = await sounding()
    if (first && second && first.src === second.src && second.ms - first.ms > 600) return true
  }
  return false
}

const widths = [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]

/** Captures what is on screen now in both schemes at every width, then puts the page back. */
async function shoot(name, { height, on = page } = {}) {
  if (!shots) return
  await on.mouse.move(0, 0)
  for (const scheme of ['light', 'dark']) {
    await on.emulateMedia({ colorScheme: scheme })
    for (const size of widths) {
      await on.setViewportSize({ width: size.width, height: height && size.width > 400 ? height : size.height })
      await sleep(350)
      await on.screenshot({ path: path.join(shots, `${name}-${size.width}-${scheme}.png`) })
    }
  }
  await on.emulateMedia({ colorScheme: 'light' })
  await on.setViewportSize(widths[0])
}

const newestImport = async () => (await get('/imports?limit=1')).items[0]
/** Waits for an import to finish; identification goes at MusicBrainz's pace. */
const finished = id => until(() => get(`/imports/${id}`), item => item.status === 'completed' || item.status === 'failed', minutes(6), 1000)
const uploadSection = () => page.getByRole('region', { name: 'Upload', exact: true })

/** Uploads one folder through the folder picker and waits for the import to end. */
async function uploadFolder(folder) {
  await page.goto(`${base}/imports`)
  await heading('Drop music here').waitFor()
  await page.getByLabel('Music folder').setInputFiles(folder)
  await heading('Ready to upload').waitFor()
  await button('Upload').click()
  await uploadSection().waitFor({ timeout: minutes(2) })
  const created = await newestImport()
  return { created, done: await finished(created.id) }
}

await step('prepare', async () => {
  await prepare()
  check('the library, the uploads and the inbox are ready', (await tree(uploads)).includes('Abbey Road.zip'), work)
})

await step('set up the server', async () => {
  check('the admin is created', (await api('POST', '/setup', admin)).status === 200)
  await api('POST', '/admin/library/roots', { name: 'Music', path: library, mode: 'read_only', watch: false })
  const stats = await until(() => get('/admin/library/stats'), value => value.tracks > 0 && value.pending === 0, minutes(5), 2000)
  check('the read-only library is scanned and identified', stats.pending === 0, `${stats.albums} albums, ${stats.tracks} tracks`)
})

await step('no managed folder', async () => {
  await page.goto(`${base}/imports`)
  await heading('Uploads have nowhere to go yet').waitFor()
  const link = page.getByRole('link', { name: 'Library settings' })
  check('without a managed folder, Add music says what an admin must do', await link.isVisible() && !(await heading('Drop music here').isVisible()), await link.getAttribute('href'))
  check('the main navigation offers Add music', await page.getByRole('navigation', { name: 'Main' }).first().getByRole('link', { name: 'Add music' }).isVisible())
  await shoot('add-music-no-folder')
  await api('POST', '/admin/library/roots', { name: 'Managed', path: managed, mode: 'managed', watch: false })
})

await step('upload a folder', async () => {
  await page.goto(`${base}/imports`)
  await heading('Drop music here').waitFor()
  await shoot('add-music')
  await page.getByLabel('Music folder').setInputFiles(path.join(uploads, 'Discovery'))
  await heading('Ready to upload').waitFor()
  const rows = page.getByRole('list', { name: 'Files to upload' }).getByRole('listitem')
  check('the folder is listed with its paths, in order, before anything is sent', (await rows.first().textContent()).startsWith('Discovery/01 One More Time.mp3'), await rows.first().textContent())
  await shoot('upload-ready', { height: 1200 })
  // The first request waits a moment, so progress and Pause can be seen.
  let held = 0
  await page.route('**/api/v1/imports/*/files', async route => {
    held += 1
    if (held === 1) await sleep(1500)
    await route.continue().catch(() => {})
  })
  await button('Upload').click()
  await page.getByRole('progressbar', { name: 'Upload progress' }).waitFor()
  check('overall progress shows while sending', true)
  await button('Pause').click()
  await heading('Paused').waitFor()
  await shoot('upload-paused', { height: 1200 })
  await page.unroute('**/api/v1/imports/*/files')
  await button('Resume').click()
  await uploadSection().waitFor({ timeout: minutes(2) })
  check('after resuming every file is sent and the import is committed', true)
  await shoot('upload-processing', { height: 1200 })
  const created = await newestImport()
  const done = await finished(created.id)
  await uploadSection().getByText('Done', { exact: true }).waitFor({ timeout: 30_000 })
  check('the page follows the import to its end', done.status === 'completed', `${done.counts.filesReceived} received, ${done.counts.albumsFiled} filed`)
  check('a paused file the server already had is not sent twice', done.counts.filesRejected === 1, `${done.counts.filesRejected} refused`)
  const refused = uploadSection().getByText('Not a music file')
  check('the refused text file says why', await refused.isVisible())
  const album = uploadSection().getByRole('link', { name: /Discovery/ })
  await album.waitFor()
  check('the filed album links to its page', /^\/album\//.test(await album.getAttribute('href')))
  const onDisk = await tree(managed)
  check('its files are filed on disk under the artist and album', onDisk.filter(file => file.startsWith('Daft Punk/Discovery')).length === 14, onDisk.find(file => file.startsWith('Daft Punk/')))
  await shoot('upload-done', { height: 1300 })
})

await step('upload a zip by dropping it', async () => {
  await page.goto(`${base}/imports`)
  await heading('Drop music here').waitFor()
  const bytes = (await readFile(path.join(uploads, 'Abbey Road.zip'))).toString('base64')
  const transfer = await page.evaluateHandle(data => {
    const binary = Uint8Array.from(atob(data), char => char.charCodeAt(0))
    const dropped = new DataTransfer()
    dropped.items.add(new File([binary], 'Abbey Road.zip', { type: 'application/zip' }))
    return dropped
  }, bytes)
  // The drop zone is the dashed box around "Drop music here"; the empty imports list is dashed too.
  await page.locator('div.border-dashed').filter({ has: heading('Drop music here') }).dispatchEvent('drop', { dataTransfer: transfer })
  await heading('Ready to upload').waitFor()
  await button('Upload').click()
  await uploadSection().waitFor({ timeout: minutes(2) })
  const done = await finished((await newestImport()).id)
  check('the zip is unpacked and filed', done.status === 'completed' && done.counts.filesExtracted > 0 && done.counts.albumsFiled === 1, `${done.counts.filesExtracted} unpacked, ${done.counts.albumsFiled} filed`)
  const onDisk = await tree(managed)
  check('its files are on disk under the artist and album', onDisk.some(file => file.startsWith('The Beatles/Abbey Road')), onDisk.find(file => file.startsWith('The Beatles/')))
})

await step('upload a duplicate', async () => {
  const { done } = await uploadFolder(path.join(uploads, 'Blue Hour'))
  await uploadSection().getByText('Done', { exact: true }).waitFor({ timeout: 30_000 })
  const stat = uploadSection().getByText('Duplicates skipped').locator('..')
  check('music the library already has is reported as skipped', done.counts.duplicatesSkipped === 5 && (await stat.textContent()).includes('5'), await stat.textContent())
})

await step('upload an album nobody can identify', async () => {
  const { done } = await uploadFolder(path.join(uploads, 'Slow Motion'))
  await uploadSection().getByText('Done', { exact: true }).waitFor({ timeout: 30_000 })
  const link = uploadSection().getByRole('link', { name: 'Open the review queue' })
  check('it is left for review, with a link to the review queue', done.counts.filesLeftForReview > 0 && await link.isVisible(), `${done.counts.filesLeftForReview} left`)
  check('its album says it is in review', await uploadSection().getByText('In review').first().isVisible())
  await shoot('upload-review', { height: 1300 })
})

await step('cancel an upload', async () => {
  await page.goto(`${base}/imports`)
  await page.getByLabel('Music folder').setInputFiles(path.join(uploads, 'Discovery'))
  await heading('Ready to upload').waitFor()
  await page.route('**/api/v1/imports/*/files', async route => {
    await sleep(10_000)
    await route.continue().catch(() => {})
  })
  await button('Upload').click()
  await page.getByRole('progressbar', { name: 'Upload progress' }).waitFor()
  const created = await until(newestImport, item => item.status === 'receiving', 5000)
  await shoot('upload-sending', { height: 1200 })
  await button('Cancel').click()
  // The drop zone that takes the panel's place says what became of the upload.
  const dropZone = page.locator('div.border-dashed').filter({ has: heading('Drop music here') })
  const note = dropZone.getByRole('status').filter({ hasText: 'Upload cancelled. Nothing from it was kept.' })
  check('the upload panel says it was cancelled', await note.waitFor().then(() => true, () => false))
  await shoot('upload-cancelled', { height: 1200 })
  const cancelled = await until(() => get(`/imports/${created.id}`), item => item.status === 'failed', 5000)
  check('cancelling ends the import on the server', cancelled.status === 'failed' && cancelled.error === 'Cancelled', cancelled.error)
  await page.unroute('**/api/v1/imports/*/files')
  await heading('Drop music here').waitFor()
  check('and the page is ready for the next upload', true)
})

await step('imports list and detail', async () => {
  await page.goto(`${base}/imports`)
  const list = page.getByRole('list', { name: 'Recent imports' })
  await list.waitFor()
  const items = await list.getByRole('listitem').allTextContents()
  check('recent imports list every upload with its state', items.length >= 5 && items.some(text => text.includes('Cancelled')) && items.some(text => text.includes('Done')), `${items.length} imports`)
  await shoot('imports-list', { height: 1500 })
  await list.getByRole('link', { name: 'Discovery' }).first().click()
  await heading('Import').waitFor()
  check('an import opens on its own page', /\/imports\/[0-9a-f-]+$/.test(page.url()))
  await shoot('import-detail', { height: 1200 })
})

await step('import settings', async () => {
  await page.goto(`${base}/admin/settings`)
  const field = page.getByLabel('Inbox folder')
  await field.fill(path.join(work, 'nowhere'))
  await field.press('Enter')
  const error = page.getByText('The inbox folder does not exist')
  await error.waitFor()
  check('the server’s reason shows under the inbox field', await error.isVisible())
  await page.getByRole('heading', { name: 'Imports' }).evaluate(element => element.scrollIntoView({ block: 'start' }))
  await shoot('admin-import-settings')
  await field.fill(inbox)
  await field.press('Enter')
  await error.waitFor({ state: 'detached' })
  const settings = await until(() => get('/admin/settings'), value => value.inboxPath !== null, 5000)
  check('a real folder is saved as the inbox', settings.inboxPath?.endsWith('inbox'), settings.inboxPath)
  check('the size limits are shown', await page.getByLabel('Largest file').inputValue() === '4' && await page.getByLabel('Largest import').inputValue() === '64')
  await cp(path.join(uploads, 'bad guy.m4a'), path.join(inbox, 'bad guy.m4a'))
  const taken = await until(newestImport, item => item.kind === 'inbox', minutes(1), 1000)
  check('music dropped in the inbox becomes an inbox import', taken.kind === 'inbox', taken.label)
  await page.goto(`${base}/imports`)
  await page.getByRole('list', { name: 'Recent imports' }).getByText(/^Inbox · /).first().waitFor()
  check('it shows in the imports list as Inbox', true)
})

// Providers ------------------------------------------------------------------

const mock = createMockProvider({ secret: 'mock-provider-secret', delayMs: 2500 })
await mock.listen(mockPort, '127.0.0.1')
const mockUrl = `http://127.0.0.1:${mockPort}`

/** Catalog results for a query, as the server rates them for this user. */
const catalog = async q => get(`/search/catalog?q=${encodeURIComponent(q)}&limit=20`)
/** A track of the catalog the library does not have, on demand, among the few the search page shows. */
const asked = new Set()
const shown = results => results?.tracks?.slice(0, 6) ?? []
async function missingTrack(q) {
  const results = await until(() => catalog(q), value => shown(value).some(track => track.availability === 'on_demand' && !asked.has(track.id)), 20_000, 1000)
  const found = shown(results).find(track => track.availability === 'on_demand' && !asked.has(track.id) && track.durationMs && track.durationMs < 600_000)
  if (!found) throw new Error(`no on-demand track for ${q}`)
  asked.add(found.id)
  return found
}
/** The search page's row for a song, in its one list of results: not an album or single of the same name. */
const resultRow = (on, title) => on.getByRole('listbox', { name: /^Results for / }).getByRole('option').filter({ hasText: title }).filter({ hasText: 'Song · ' }).first()
/**
 * Searches songs in the app (the Songs filter, `type=track`: the mixed list shows only the best
 * few) and plays a track from the results; returns its row.
 */
async function playFromSearch(q, track) {
  await page.goto(`${base}/search?q=${encodeURIComponent(q)}&type=track`)
  const row = resultRow(page, track.title)
  await row.waitFor({ timeout: 30_000 })
  await row.hover()
  await row.getByRole('button', { name: `Play ${track.title}` }).click()
  return row
}
const jobsFor = async trackId => (await get('/admin/acquisition/jobs?limit=50')).items.filter(job => job.trackId === trackId)

await step('providers page and adding the mock', async () => {
  await page.goto(`${base}/admin/providers`)
  await heading('No providers').waitFor()
  check('with no provider, fetching is said to be off', await page.getByText('On-demand fetching is off.', { exact: false }).isVisible())
  await shoot('admin-providers-empty', { height: 1300 })
  await button('Add provider').click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Name').fill('Shelf')
  await dialog.getByLabel('Address').fill(mockUrl)
  await dialog.getByLabel('Shared secret').fill('mock-provider-secret')
  await shoot('admin-provider-add')
  await dialog.getByLabel('Shared secret').fill('short')
  await button('Add provider', dialog).click()
  check('a short secret is refused in the form', await dialog.getByText('At least 8 characters').first().isVisible())
  await dialog.getByLabel('Shared secret').fill('mock-provider-secret')
  await button('Add provider', dialog).click()
  await dialog.waitFor({ state: 'detached' })
  const card = page.getByRole('listitem', { name: 'Shelf' })
  await card.waitFor()
  check('the provider is listed as enabled, with what it reports', await card.getByText('Enabled').isVisible() && await card.getByText('Mock tones').isVisible(), (await card.textContent()).slice(0, 120))
  await button('Test connection', card).click()
  const result = card.getByRole('status').filter({ hasText: 'Connected' })
  await result.waitFor()
  check('Test connection shows the capabilities it reports', (await card.textContent()).includes('whole albums'), await result.textContent())
  const provider = (await get('/admin/acquisition/providers')).items[0]
  check('the secret is never returned', !('secret' in provider))
})

await step('policy', async () => {
  const delivery = page.getByLabel('Delivery address')
  await delivery.fill('not an address')
  await delivery.press('Enter')
  check('a delivery address that is not a URL is refused', await page.getByText('Invalid URL').isVisible())
  await delivery.fill(server)
  await delivery.press('Enter')
  await page.getByLabel('Give up after').fill('3')
  await page.getByLabel('Give up after').press('Enter')
  const policy = await until(() => get('/admin/acquisition/policy'), value => value.timeoutSeconds === 180 && value.deliveryBaseUrl !== null, 5000)
  check('the policy is saved', policy.deliveryBaseUrl === server && policy.timeoutSeconds === 180, JSON.stringify(policy))
  check('priced offers are said to be ignored', await page.getByText('Offers that come with a price are ignored in this version', { exact: false }).isVisible())
  await shoot('admin-providers', { height: 1700 })
})

const query = 'Boards of Canada'

await step('play missing music on demand', async () => {
  const track = await missingTrack(query)
  check('a track the library lacks shows on demand', track.availability === 'on_demand', `${track.title} · ${track.artistCredit}`)
  const row = await playFromSearch(query, track)
  // The row's spinner sits over its cover and is hidden from assistive tech (the player bar's says it).
  await row.locator('svg.spinner').waitFor({ timeout: 10_000 })
  check('the track shows the loading spinner in the list', true)
  check('and in the player bar, under its artist as always', await playerBar().getByRole('status', { name: 'Loading' }).isVisible() && await playerBar().getByText(track.artistCredit).first().isVisible())
  check('nothing says it is being fetched', !(await page.getByText(/Preparing|on demand/).count()))
  for (let press = 0; press < 3; press++) await page.locator('body').press('ArrowDown')
  await shoot('on-demand-loading')
  await button('Queue').click()
  await page.getByRole('complementary', { name: 'Queue' }).getByRole('status', { name: 'Loading' }).waitFor()
  await shoot('on-demand-queue')
  await button('Hide queue').click()
  await until(() => jobsFor(track.id), jobs => jobs[0]?.status === 'completed', minutes(4), 1000)
  check('then it plays', await advancing(), track.title)
  const owned = await get(`/tracks/${track.id}`)
  check('and is in the library now', owned.availability === 'server')
  await button('Pause').click()
})

await step('add an album to the library', async () => {
  // Catalog albums know their tracks once opened; the smallest kind keeps the run short.
  const results = await until(() => catalog(query), value => value?.albums?.length > 0, 20_000, 1000)
  const unowned = results.albums.filter(album => album.availability === 'none' || album.availability === 'on_demand')
  const pick = unowned.find(album => ['single', 'ep'].includes(album.type)) ?? unowned[0]
  if (!pick) throw new Error('no album the library lacks')
  await page.goto(`${base}/album/${pick.id}`)
  // The heart is the one way into the library. The album's is the only "Save to library" on the
  // page: the player's, for the song still playing from the step before, is named after that song.
  const add = button('Save to library')
  await add.waitFor({ timeout: minutes(1) })
  check('the album page says nothing of where its music is', !(await page.getByText(/on demand|Get this album|library yet/i).count()), pick.title)
  await shoot('album-on-demand')
  await add.click()
  check('the heart fills at once', await button('Remove from library').waitFor({ timeout: 2000 }).then(() => true, () => false))
  await shoot('album-added')
  const detail = await until(() => get(`/albums/${pick.id}`), value => value.availability === 'full' || value.availability === 'partial', minutes(6), 2000)
  check('the server fetches its songs behind it', detail.availability === 'full', `${detail.ownedTrackCount} of ${detail.trackCount}`)
  check('and it is in the library', (await get('/library/albums?sort=recent&limit=50')).items.some(album => album.id === pick.id))
})

/**
 * How a run of songs the provider cannot supply ends (#119): paused on the fifth in a row
 * with one notice, or stopped when nothing after it plays.
 */
const runStopNotice = () => page.getByText(/^(Several songs in a row aren’t available|None of the remaining songs are available)$/).first()
/**
 * A skipped song's notice (one, which counts the run as it grows, #119), or the stop notice that
 * takes its place once the run ends.
 */
const runNotice = () => page.getByText(/^(Skipped (“.+”|\d+ songs) — not available|Several songs in a row aren’t available|None of the remaining songs are available)$/).first()
/** Playback is paused or stopped: the player bar offers Play. */
const paused = async () => (await button('Play', playerBar()).count()) > 0 && !(await button('Pause', playerBar()).count())

/**
 * A provider that fails every job is down, not short of a song (#119): playback pauses on the
 * first one with one notice that says so, and nothing is said per song.
 */
const outageNotice = () => page.getByText('Can’t load music right now', { exact: true }).first()

await step('a provider that fails', async () => {
  mock.settings.fail = true
  const track = await missingTrack('Aphex Twin')
  try {
    await playFromSearch('Aphex Twin', track)
    await outageNotice().waitFor({ timeout: minutes(3) })
    check('a provider that fails pauses playback with one notice', await paused(), track.title)
    check('and says nothing per song', !(await page.getByText(/^Couldn’t play “/).count()) && !(await page.getByText(/^Skipped /).count()))
    const providers = await get('/admin/acquisition/providers')
    const shelf = (providers.items ?? providers).find(provider => provider.name === 'Shelf')
    check('the provider is reported failing, not the songs missing', Boolean(shelf?.failingSince), shelf?.failingSince)
    await shoot('on-demand-failed')
  } finally {
    mock.settings.fail = false
  }
  await page.goto(`${base}/admin/providers?status=failed`)
  const failedRow = page.getByRole('list', { name: 'Requests' }).getByRole('listitem').filter({ has: page.getByText(`${track.title} — ${track.artistCredit}`, { exact: true }) }).first()
  await failedRow.waitFor()
  check('its job is listed as failed, with the error', (await failedRow.textContent()).includes('The provider failed'), await failedRow.textContent())
  await shoot('admin-provider-jobs-failed', { height: 1700 })
})

await step('a provider that delivers the wrong file', async () => {
  mock.settings.wrongFile = true
  const track = await missingTrack('Autechre')
  try {
    await playFromSearch('Autechre', track)
    // A delivery that is not the song asked for is a song the provider cannot supply: skipped, the same way.
    await runNotice().waitFor({ timeout: minutes(4) })
    check('a wrong delivery is skipped with the same notice', true, await runNotice().textContent())
    await runStopNotice().waitFor({ timeout: minutes(8) })
    check('and a run of them stops playback too', await paused(), await runStopNotice().textContent())
  } finally {
    mock.settings.wrongFile = false
  }
  const [job] = await until(() => jobsFor(track.id), jobs => jobs[0]?.status === 'failed', 10_000)
  check('and fails its job', job?.status === 'failed', job?.error)
})

await step('a member without the permission', async () => {
  await api('POST', '/admin/users', { ...member, role: 'member' })
  const memberContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await memberContext.request.post(`${base}/api/v1/auth/login`, { headers, data: member })
  const memberPage = await memberContext.newPage()
  const track = await missingTrack('Burial')
  await memberPage.goto(`${base}/search?q=${encodeURIComponent('Burial')}&type=track`)
  const row = resultRow(memberPage, track.title)
  await row.waitFor({ timeout: 30_000 })
  const title = await row.getAttribute('title')
  check('on-demand tracks show as unavailable, in the one word every surface uses', title === 'Not available', title)
  check('with nothing to play', await row.getByRole('button', { name: `Play ${track.title}` }).count() === 0)
  await shoot('on-demand-not-allowed', { on: memberPage })
  const refused = await api('POST', `/tracks/${track.id}/acquire`, undefined, memberContext)
  check('and the server refuses a request', refused.status === 403 && refused.body.error.code === 'acquire_not_allowed', refused.body?.error?.code)
  check('Add music is not offered', await memberPage.getByRole('link', { name: 'Add music' }).count() === 0)
  await memberContext.close()
})

await step('priced offers', async () => {
  mock.settings.priced = true
  mock.settings.coverage = 'must_resolve'
  await page.goto(`${base}/admin/providers`)
  const card = page.getByRole('listitem', { name: 'Shelf' })
  await button('Test connection', card).click()
  await card.getByText('Checks each track').waitFor()
  check('testing again picks up the new coverage', true)
  const priced = 'Four Tet'
  const first = await catalog(priced)
  await until(() => mock.resolved.length, count => count > 0, 20_000)
  await sleep(2000)
  const after = await catalog(priced)
  const tracks = after.tracks.filter(track => !asked.has(track.id))
  check('a track only priced offers could supply stays unavailable', mock.resolved.length > 0 && tracks.length > 0 && tracks.every(track => track.availability === 'none'), `${first.tracks.length} tracks, ${mock.resolved.length} asked`)
  mock.settings.priced = false
})

await step('fix match from the album page', async () => {
  const album = (await get('/search/library?q=OK%20Computer&limit=5')).albums.find(item => item.title === 'OK Computer')
  await page.goto(`${base}/album/${album.id}`)
  await page.getByRole('button', { name: 'More options', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Fix match…' }).click()
  const dialog = page.getByRole('dialog')
  await heading('Fix match', dialog).waitFor()
  await dialog.getByText('Track by track').waitFor({ timeout: minutes(1) })
  check('Fix match opens from the album page with candidates', true)
  await shoot('album-fix-match', { height: 1100 })
  await page.keyboard.press('Escape')
})

await mock.close()
await browser.close()
console.log(`${total - failed} of ${total} checks passed`)
process.exit(failed ? 1 : 0)
