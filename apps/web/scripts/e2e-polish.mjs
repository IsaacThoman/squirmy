// Checks the release polish in real Chromium against a server that has not been set up yet
// and was started the way the Docker image starts it, with the music folder in its
// configuration: the setup wizard starting from that folder, the version, a managed
// folder's naming template and Organize's mention of it, search leading with its best
// match (typing into the search page's field), the server's ListenBrainz key described as a lookup
// key, and the queue showing a fetch as loading on the current song only. Identification and
// catalog search talk to MusicBrainz and Deezer, so a run takes a few minutes.
//
// Usage: node scripts/e2e-polish.mjs <baseUrl> --api <serverUrl> --library <dir> [--mock-port <port>] [--shots <dir>]
//   --api      the server itself (the mock provider delivers to it), e.g. http://127.0.0.1:4747
//   --library  the folder in the server's SQUIRMY_LIBRARY_PATHS, a copy of the demo library
//              (`npm run demo:library -w @squirmy/server -- <dir>`). The run makes it managed
//              but applies no batch, so nothing in it moves.
//   --shots    also capture the changed screens there, light and dark, 1440 and 390 wide
// Leaves an admin `admin` / `correct horse battery` behind.
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { createMockProvider } from '@squirmy/adapter-mock'
import { chromium } from 'playwright'

const args = process.argv.slice(2)
const option = name => (args.includes(name) ? args[args.indexOf(name) + 1] : null)
const base = args.find((arg, index) => !arg.startsWith('--') && !args[index - 1]?.startsWith('--')) ?? 'http://localhost:5173'
const server = option('--api')
const library = option('--library') && path.resolve(option('--library'))
const shots = option('--shots')
const mockPort = Number(option('--mock-port') ?? 4802)
if (!server || !library) throw new Error('Usage: node scripts/e2e-polish.mjs <baseUrl> --api <serverUrl> --library <dir> [--mock-port <port>] [--shots <dir>]')

const admin = { username: 'admin', password: 'correct horse battery' }
const headers = { 'X-Squirmy-Client': 'web', 'X-Squirmy-Request': '1' }
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
const problems = []
page.on('pageerror', error => problems.push(error.message))
page.on('console', message => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) problems.push(message.text()) })
const heading = (name, scope = page) => scope.getByRole('heading', { name, exact: true })
const button = (name, scope = page) => scope.getByRole('button', { name, exact: true }).filter({ visible: true }).first()
const get = async route => (await context.request.get(`${base}/api/v1${route}`, { headers })).json()
const send = async (method, route, data) => (await context.request.fetch(`${base}/api/v1${route}`, { method, headers, data })).json()

/** The page as it is, light and dark, wide and narrow; `prepare` runs again after each change. */
async function shoot(name, prepare = async () => {}) {
  if (!shots) return
  await mkdir(shots, { recursive: true })
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme })
      await prepare()
      await page.mouse.move(0, 0)
      await page.waitForTimeout(400)
      await page.screenshot({ path: path.join(shots, `${name}-${width}-${colorScheme}.png`) })
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ colorScheme: 'light' })
}

const status = await get('/setup/status')
check('the server has not been set up yet', status.needsSetup === true, status.version)
const folderName = path.basename(library)

await step('setup wizard starts from the configured folder', async () => {
  await page.goto(`${base}/`)
  await heading('Welcome to Squirmy').waitFor()
  await page.getByLabel('Username').fill(admin.username)
  await page.getByLabel('Password').fill(admin.password)
  await button('Continue').click()
  await heading('Where is your music?').waitFor()
  const folder = page.getByRole('listitem', { name: folderName, exact: true })
  await folder.waitFor()
  check('the configured folder is listed with its path and mode', await folder.getByText(library).isVisible() && await folder.getByText('Read-only').isVisible())
  const scan = await folder.locator('p').last().textContent()
  check('with its scan state', /Scanning|files · scanned|Not scanned yet/.test(scan), scan)
  check('the step does not ask to add it again', await button('Continue').isVisible() && !(await page.getByRole('button', { name: 'Add and scan' }).isVisible()))
  await shoot('setup-folders')

  await button('Add another').click()
  const field = page.getByLabel('Folder path')
  await field.fill(library)
  const listed = page.waitForResponse(response => response.url().includes('/api/v1/admin/fs'))
  await field.press('Enter')
  await listed
  await page.waitForFunction(folder => document.querySelector('input[aria-label="Folder path"]')?.value === folder, library)
  await button('Add and scan').click()
  await folder.getByText('Already added').waitFor()
  check('adding it again says it is already added, not an error', !(await page.getByRole('alert').isVisible()) && !(await page.getByRole('button', { name: 'Add and scan' }).isVisible()))
  await shoot('setup-already-added')

  await button('Let Squirmy organize it…', folder).click()
  const dialog = page.getByRole('dialog')
  check('making it managed asks first, as the Library page does', await heading(`Let Squirmy manage ${folderName}?`, dialog).isVisible())
  await shoot('setup-make-managed')
  await button('Make managed', dialog).click()
  await dialog.waitFor({ state: 'detached' })
  await folder.getByText('Managed', { exact: true }).waitFor()
  const roots = (await get('/admin/library/roots')).items
  check('the folder is managed, and still the only one', roots.length === 1 && roots[0].mode === 'managed', roots.map(root => `${root.path} ${root.mode}`).join(', '))

  await button('Continue').click()
  await heading('You’re all set').waitFor()
  check('the last step names the folder', await page.getByText(library, { exact: true }).isVisible())
  await button('Start listening').click()
  await heading('Listen now').waitFor()
})

await step('version', async () => {
  const { version } = await get('/setup/status')
  await page.goto(`${base}/admin/users`)
  await heading('Users & invites').waitFor()
  check('admin shows the server version', await page.getByText(`Squirmy ${version}`).filter({ visible: true }).first().isVisible(), version)
  const signedOut = await browser.newContext()
  const login = await signedOut.newPage()
  await login.goto(`${base}/login`)
  await login.getByRole('heading', { name: 'Sign in to Squirmy' }).waitFor()
  check('the sign-in page shows it in its footer', await login.getByText(`Squirmy ${version}`).isVisible())
  await signedOut.close()
})

const root = (await get('/admin/library/roots')).items?.[0]
const info = await get('/admin/organize/template')

await step('naming template', async () => {
  await page.goto(`${base}/admin/library`)
  await button(`More options for ${root.name}`).click()
  await page.getByRole('menuitem', { name: 'Edit…' }).click()
  const dialog = page.getByRole('dialog')
  const field = dialog.getByLabel('Naming template')
  check('a managed folder shows its template, the default', await field.inputValue() === info.defaultTemplate && await dialog.getByText('Default', { exact: true }).isVisible())
  const example = await dialog.locator('#root-template-message span').textContent()
  check('with an example path for a sample track', example === 'Mira Vale/Blue Hour (2019)/2-03 Paper Boats.flac', example)
  await dialog.getByText('Tokens').click()
  const listed = await dialog.locator('dt').allTextContents()
  check('and every token the server lists, with its description', listed.join() === info.tokens.map(token => `{${token.token}}`).join() && await dialog.getByText(info.tokens[0].description).isVisible(), listed.join(' '))
  await shoot('template-default', async () => {
    if (!(await dialog.isVisible())) return
    await field.scrollIntoViewIfNeeded()
  })

  await field.fill('{albumartist}/{album}/{title}')
  await button('Save', dialog).click()
  const refused = await (await context.request.fetch(`${base}/api/v1/admin/library/roots/${root.id}`, { method: 'PATCH', headers, data: { template: '{albumartist}/{album}/{title}' } })).json()
  await dialog.getByText(refused.error.message, { exact: true }).waitFor()
  check('a template the server refuses shows its reason under the field', refused.error.code === 'invalid_request', refused.error.message)
  await shoot('template-refused', () => field.scrollIntoViewIfNeeded())

  const custom = '{albumartist}/{year} - {album}/{track} {title}.{ext}'
  await field.fill(custom)
  check('the example follows the template as it is typed', await dialog.getByText('Mira Vale/2019 - Blue Hour/03 Paper Boats.flac').isVisible())
  await button('Save', dialog).click()
  await dialog.waitFor({ state: 'detached' })
  check('a valid template is saved', (await get('/admin/library/roots')).items[0].template === custom)

  await button(`More options for ${root.name}`).click()
  await page.getByRole('menuitem', { name: 'Edit…' }).click()
  check('the folder now shows its own template', await field.inputValue() === custom && await button('Reset to default', dialog).isVisible())
  await shoot('template-custom', () => field.scrollIntoViewIfNeeded())
  await button('Reset to default', dialog).click()
  await button('Save', dialog).click()
  await dialog.waitFor({ state: 'detached' })
  check('Reset to default goes back to the default', (await get('/admin/library/roots')).items[0].template === null)
})

await step('Organize names the template a preview used', async () => {
  await page.goto(`${base}/admin/organize`)
  await button('Preview').click()
  const note = page.getByText('Default template', { exact: true })
  await note.waitFor({ timeout: minutes(1) })
  check('a preview says it used the default template', await page.getByText(info.defaultTemplate, { exact: true }).isVisible())
  await shoot('organize-template', () => note.evaluate(element => element.scrollIntoView({ block: 'center' })))
  await page.getByRole('link', { name: 'Change it in Library' }).click()
  await page.getByRole('dialog', { name: `Edit ${root.name}` }).waitFor()
  check('its link opens the folder\'s editor', page.url().endsWith(`/admin/library?edit=${root.id}`))
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !location.search.includes('edit='))
  check('closing the editor leaves the link', true)
})

await step('search leads with the best match', async () => {
  // The scan must have read the album's tags before the library can find it.
  await until(() => get('/search/library?q=OK%20Computer&limit=20'), results => results.top?.type === 'album', minutes(2), 1000)
  const expected = await get('/search/library?q=OK%20Computer&limit=20')
  await page.goto(`${base}/search`)
  await heading('Search').waitFor()
  const search = page.getByRole('searchbox', { name: 'Search' })
  check('the search page\'s field takes focus', await search.evaluate(element => element === document.activeElement))
  // Fast typing, a mistake and its correction: nothing may be dropped or arrive out of order.
  await search.pressSequentially('OK Computr', { delay: 15 })
  await search.press('Backspace')
  await search.pressSequentially('er', { delay: 15 })
  await page.waitForFunction(() => new URL(location.href).searchParams.get('q') === 'OK Computer')
  check('the search field keeps every letter', await search.inputValue() === 'OK Computer', page.url())
  // One ranked list, the library's and the catalog's merged, once both have answered.
  // A plain list: each row's link or button is a control of its own.
  const results = page.getByRole('list', { name: /^Results for / })
  await results.waitFor()
  await page.waitForFunction(() => !document.querySelector('main [aria-busy]'), null, { timeout: 30_000 })
  const first = results.getByRole('listitem').first()
  check('the best match leads, the server\'s top result', await first.getByRole('link', { name: /^OK Computer, Album · / }).getAttribute('href') === `/album/${expected.top.id}`, await first.textContent())
  await first.hover()
  await first.getByRole('button', { name: 'More options for OK Computer' }).click()
  check('an owned album can be played from its menu', await page.getByRole('menuitem', { name: 'Play', exact: true }).isEnabled())
  await page.keyboard.press('Escape')
  const headings = await page.getByRole('main').getByRole('heading', { level: 2 }).allTextContents()
  check('no sections, none named for the library or the catalog', headings.length === 0, headings.join(' · '))
  await shoot('search-top')

  /** Opens the search page for `q` and waits for its list to settle: the catalog's answer ranks it too. */
  const settled = async q => {
    await page.goto(`${base}/search?q=${encodeURIComponent(q)}`)
    await results.getByRole('listitem').first().waitFor()
    await page.waitForFunction(() => !document.querySelector('main [aria-busy]'), null, { timeout: 30_000 })
    return results.getByRole('listitem').first()
  }
  const artist = await settled('Radiohead')
  // By its link's name: an artist without a picture yet shows its initial, which the text would include.
  check('an artist leads when it is named', await artist.getByRole('link', { name: 'Radiohead, Artist', exact: true }).count() === 1, await artist.textContent())
  const song = await settled('Airbag')
  check('and a song, with play for an owned one', (await song.textContent()).startsWith('AirbagSong · ') && await song.getByRole('button', { name: 'Play Airbag' }).count() === 1, await song.textContent())
})

await step('ListenBrainz setting', async () => {
  await page.goto(`${base}/admin/settings`)
  const row = page.getByText('Top songs and popularity on artist pages', { exact: false })
  await row.waitFor()
  check('the server\'s ListenBrainz key is described as a lookup key', await page.getByText('Not used for scrobbling', { exact: false }).isVisible())
  check('and nothing says it scrobbles', !(await page.getByText('similar artists and scrobbling', { exact: false }).count()))
  await shoot('settings-listenbrainz', () => row.evaluate(element => element.scrollIntoView({ block: 'center' })))
})

// The mock is slow on purpose, so fetches are still running while the queue is looked at.
const mock = createMockProvider({ secret: 'mock-provider-secret', delayMs: minutes(5) })
await mock.listen(mockPort, '127.0.0.1')

await step('the queue shows fetching as loading, on the current song only', async () => {
  await send('POST', '/admin/acquisition/providers', { name: 'Shelf', baseUrl: `http://127.0.0.1:${mockPort}`, secret: 'mock-provider-secret' })
  await send('PATCH', '/admin/acquisition/policy', { deliveryBaseUrl: server })
  const results = await until(() => get('/search/catalog?q=Boards%20of%20Canada&limit=20'), value => value.albums?.length > 0, 30_000, 1000)
  // An album with at least five tracks, none of them owned. Catalog albums learn their tracks once opened.
  let album = null
  for (const candidate of results.albums.filter(item => item.availability === 'none' || item.availability === 'on_demand')) {
    const detail = await until(() => get(`/albums/${candidate.id}`), value => value.discs?.length > 0, 30_000, 1000)
    const tracks = detail.discs?.flatMap(disc => disc.tracks) ?? []
    if (tracks.length >= 5 && tracks.every(track => track.availability === 'on_demand')) {
      album = { ...detail, tracks }
      break
    }
  }
  if (!album) throw new Error('no on-demand album with five tracks')
  await page.goto(`${base}/album/${album.id}`)
  // The album as a whole plays from its ⋯ menu.
  await button('More options', page.getByRole('main')).click()
  await page.getByRole('menuitem', { name: 'Play', exact: true }).click()
  await button('Queue').click()
  const queue = page.getByRole('complementary', { name: 'Queue' })
  const upNext = queue.getByRole('region', { name: /^(Continue Playing|Up Next)$/ })
  await queue.getByRole('region', { name: 'Now playing' }).getByRole('status', { name: 'Loading' }).waitFor({ timeout: 30_000 })
  const rows = await upNext.getByRole('listitem').count()
  check('the current song shows the loading spinner', true)
  check('upcoming songs show nothing special', !(await upNext.getByRole('status').count()) && !(await upNext.getByText(/Preparing|on demand/).count()), `${rows} rows`)
  // The server fetches the current song and the next five.
  const ahead = album.tracks.slice(0, 6)
  const jobs = await until(async () => (await get('/admin/acquisition/jobs?limit=50')).items, items => items.filter(job => ahead.some(track => track.id === job.trackId)).length === ahead.length, 30_000, 1000)
  check('and those are being fetched behind it', true, `${jobs.length} jobs`)
  // On a phone the queue is a pane of Now Playing.
  await shoot('queue-loading', async () => {
    const phone = page.viewportSize().width < 768
    if (phone && !(await button('Hide queue').isVisible())) {
      await page.getByRole('button', { name: /^Open Now Playing, / }).click()
      await button('Show queue').click()
    }
    if (!phone && !(await queue.isVisible())) {
      if (await button('Close Now Playing').isVisible()) await button('Close Now Playing').click()
      await button('Queue').click()
    }
  })
})

await mock.close()
check('no errors in the page', problems.length === 0, problems.slice(0, 3).join(' | '))
await browser.close()
console.log(`\n${total - failed} of ${total} checks passed`)
process.exit(failed ? 1 : 0)
