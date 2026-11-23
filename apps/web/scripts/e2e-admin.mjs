// Walks the admin flows in real Chromium against a server that has not been set up yet:
// setup with a real folder, live scan progress and library statistics, adding and removing
// folders, the review queue, Fix match, Organize (checking the files on disk) and the local
// search index. Each result is checked where the app says it: the review queue's note, the Fix
// match dialog, the batch in Organize. Identification talks to MusicBrainz, so a run takes a few minutes.
//
// Usage: node scripts/e2e-admin.mjs <baseUrl> --demo <dir> --work <dir>
//   --demo  a library made by `npm run demo:library -w @squirmy/server -- <dir>` (read, never changed)
//   --work  an empty scratch directory: the script builds the library folders and the dump there
// Leaves an admin `admin` / `correct horse battery` behind.
import { spawnSync } from 'node:child_process'
import { cp, mkdir, readdir, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const args = process.argv.slice(2)
const option = name => (args.includes(name) ? args[args.indexOf(name) + 1] : null)
const base = args.find((arg, index) => !arg.startsWith('--') && !args[index - 1]?.startsWith('--')) ?? 'http://localhost:5173'
const demo = option('--demo')
const work = option('--work')
if (!demo || !work) throw new Error('Usage: node scripts/e2e-admin.mjs <baseUrl> --demo <dir> --work <dir>')

const admin = { username: 'admin', password: 'correct horse battery' }
const library = path.resolve(work, 'library')
const inbox = path.resolve(work, 'inbox')
const spare = path.resolve(work, 'spare')
const dump = path.resolve(work, 'dump', 'musicbrainz-canonical-dump.tar.zst')
const server = fileURLToPath(new URL('../../server/', import.meta.url))
const minutes = n => n * 60_000
let failed = 0
let total = 0

function check(name, ok, detail = '') {
  total += 1
  if (!ok) failed += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

/** Runs a step; a thrown error fails it and the run carries on with the next one. */
async function step(name, body) {
  try {
    await body()
  } catch (error) {
    check(name, false, error.message.split('\n')[0])
  }
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { encoding: 'utf8', ...options })
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`)
}

// The library: the demo albums, plus a copy of OK Computer whose titles say nothing, which
// the matcher cannot be sure about. The managed folder: two albums under untidy names.
async function prepare() {
  await cp(demo, library, { recursive: true })
  const messy = path.join(library, 'Downloads', 'okc')
  await mkdir(messy, { recursive: true })
  const source = path.join(demo, 'Radiohead', 'OK Computer')
  const files = (await readdir(source)).filter(name => name.endsWith('.flac')).sort()
  files.forEach((name, index) => {
    const number = String(index + 1).padStart(2, '0')
    run('ffmpeg', ['-loglevel', 'error', '-y', '-i', path.join(source, name), '-c', 'copy', '-map_metadata', '0', '-metadata', `title=Track ${number}`, path.join(messy, `track${number}.flac`)])
  })
  const discovery = path.join(inbox, 'incoming', 'discovery_320')
  await cp(path.join(demo, 'Daft Punk', 'Discovery'), discovery, { recursive: true })
  for (const name of await readdir(discovery)) await rename(path.join(discovery, name), path.join(discovery, name.toLowerCase().replaceAll(' ', '_')))
  await cp(path.join(demo, 'Mira Vale', 'Blue Hour'), path.join(inbox, 'incoming', 'blue hour (2019) [FLAC]'), { recursive: true })
  await mkdir(spare, { recursive: true })
  // A small canonical dump built the way the server's tests build theirs.
  await mkdir(path.dirname(dump), { recursive: true })
  const script = path.join(path.dirname(dump), 'build-dump.mts')
  const fixtures = path.join(server, 'src', 'modules', 'catalog-index', 'fixtures.ts')
  await writeFile(script, `import { writeFileSync } from 'node:fs'\nimport { buildDump, testCatalog } from ${JSON.stringify(fixtures)}\nwriteFileSync(${JSON.stringify(dump)}, buildDump(testCatalog()))\n`)
  run('npx', ['tsx', script], { cwd: server })
}

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const page = await context.newPage()
page.on('pageerror', error => console.log(`page error: ${error.message}`))
const heading = name => page.getByRole('heading', { name, exact: true })
const button = (name, scope = page) => scope.getByRole('button', { name, exact: true })
const api = async (route, method = 'GET') => {
  const response = await page.request.fetch(`${base}/api/v1${route}`, { method, headers: { 'X-Squirmy-Request': '1' } })
  return response.json()
}
const albumNamed = async title => (await api(`/search/library?q=${encodeURIComponent(title)}&limit=5`)).albums.find(album => album.title === title)
/** Types a path into the folder picker and waits for it to be listed. */
async function browseTo(folder, scope = page) {
  const field = scope.getByLabel('Folder path')
  await field.fill(folder)
  const listed = page.waitForResponse(response => response.url().includes('/api/v1/admin/fs'), { timeout: 3000 }).catch(() => {})
  await field.press('Enter')
  await listed
  await page.waitForTimeout(200)
}

/** Identification runs in the background at MusicBrainz's pace; waits until no file is pending. */
async function waitForIdentification() {
  const deadline = Date.now() + minutes(10)
  while ((await api('/admin/library/stats')).pending > 0) {
    if (Date.now() > deadline) throw new Error('identification did not finish')
    await page.waitForTimeout(2000)
  }
}

await step('prepare folders', async () => {
  await prepare()
  check('the library, the managed folder and the dump are ready', existsSync(dump) && existsSync(path.join(library, 'Downloads', 'okc', 'track12.flac')), work)
})

await step('setup wizard', async () => {
  await page.goto(`${base}/`)
  await heading('Welcome to Squirmy').waitFor()
  await page.getByLabel('Username').fill(admin.username)
  await page.getByLabel('Password').fill(admin.password)
  await button('Continue').click()
  await heading('Where is your music?').waitFor()
  await browseTo(path.join(library, 'nowhere'))
  check('a folder that does not exist cannot be added', await page.getByText('No such directory').isVisible() && await button('Add and scan').isDisabled())
  await browseTo(library)
  await page.waitForFunction(folder => document.querySelector('input[aria-label="Folder path"]')?.value === folder, library)
  await button('Add and scan').click()
  await heading('You’re all set').waitFor()
  check('setup adds the folder through the real route', await page.getByText(library).isVisible())
  await button('Start listening').click()
  await heading('Listen now').waitFor()
})

await step('scan progress and statistics', async () => {
  await page.goto(`${base}/admin/library`)
  const card = page.getByRole('listitem', { name: 'Music', exact: true })
  const progress = card.getByRole('progressbar')
  await progress.first().waitFor({ timeout: 30_000 })
  check('scan progress shows on the folder', true, await card.locator('p.flex').first().textContent())
  await waitForIdentification()
  await progress.first().waitFor({ state: 'detached', timeout: minutes(2) })
  check('scanning and identification finish', true)
  const stats = await api('/admin/library/stats')
  await page.getByText(new RegExp(`^${stats.matched} of ${stats.files} files$`)).waitFor()
  check('the statistics show every file', stats.files === 129, `${stats.files} files, ${stats.tracks} songs, ${stats.albums} albums`)
  check('nothing is waiting or missing', stats.pending === 0 && stats.missing === 0 && await page.getByText(`${stats.albums} albums · ${stats.artists} artists`).isVisible())
  check('the folder lists its files', await card.getByText('129 files').isVisible())
})

await step('add and remove folders', async () => {
  await button('Add folder').click()
  const dialog = page.getByRole('dialog')
  await browseTo(library, dialog)
  await button('Add and scan', dialog).click()
  await dialog.getByText('That folder is already a library root').waitFor()
  check('the server’s error shows on the folder', true)
  await browseTo(path.join(library, 'Radiohead'), dialog)
  await button('Add and scan', dialog).click()
  await dialog.getByText(/overlaps the library root/).waitFor()
  check('a folder inside another is refused', true)
  await browseTo(inbox, dialog)
  await dialog.getByLabel('Name').fill('Inbox')
  await dialog.getByRole('switch', { name: 'Let Squirmy organize this folder' }).click()
  await button('Add and scan', dialog).click()
  await dialog.waitFor({ state: 'detached' })
  await page.getByRole('listitem', { name: 'Inbox', exact: true }).getByText('Managed').waitFor()
  check('a managed folder is added', true)

  await button('Add folder').click()
  await browseTo(spare, dialog)
  check('the name follows the folder', await dialog.getByLabel('Name').inputValue() === 'spare')
  await button('Add and scan', dialog).click()
  const card = page.getByRole('listitem', { name: 'spare', exact: true })
  await card.waitFor()
  await card.getByRole('button', { name: 'More options for spare' }).click()
  await page.getByRole('menuitem', { name: 'Remove folder…' }).click()
  const confirm = page.getByRole('dialog')
  check('removing says files on disk are not touched', (await confirm.textContent()).includes('Nothing on disk is touched'))
  await button('Remove folder', confirm).click()
  await card.waitFor({ state: 'detached' })
  check('the folder is removed and stays on disk', existsSync(spare))
})

await step('make a folder managed', async () => {
  const card = page.getByRole('listitem', { name: 'Music', exact: true })
  await card.getByRole('button', { name: 'More options for Music' }).click()
  await page.getByRole('menuitem', { name: 'Edit…' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('switch', { name: 'Let Squirmy organize this folder' }).click()
  await button('Save', dialog).click()
  await heading('Let Squirmy manage Music?').waitFor()
  check('becoming managed asks first and explains it', (await dialog.textContent()).includes('rename, move and tag'))
  await button('Cancel', dialog).click()
  check('cancelling leaves it read-only', await card.getByText('Read-only').isVisible())
})

await step('review queue', async () => {
  await page.goto(`${base}/admin/reviews`)
  const item = page.getByRole('list', { name: 'Reviews' }).getByRole('button', { name: /Radiohead – OK Computer/ })
  await item.waitFor({ timeout: minutes(5) })
  check('the messy album waits for review', await page.getByRole('link', { name: /Review queue/ }).textContent().then(text => /1/.test(text)))
  await item.click()
  const detail = page.getByRole('article')
  await detail.getByText('Track by track').waitFor()
  const differing = detail.locator('mark', { hasText: 'Track 01' })
  check('the detail compares the files with the release track by track', await differing.isVisible() && await detail.getByText('Airbag').isVisible())
  const reviewId = new URL(page.url()).searchParams.get('review')
  await button('Use this release').click()
  // The note above the queue says what was done once the album has left it.
  await page.getByRole('status').filter({ hasText: /^Release applied to “OK Computer”\.$/ }).waitFor()
  await page.getByText('Nothing to review').waitFor()
  check('the queue says what was done in place', true)
  const review = await api(`/admin/reviews/${reviewId}`)
  const album = await api(`/albums/${review.albumId}`)
  check('use this release resolves the review', review.status === 'resolved')
  check('the album is identified', !!album.mbid && review.files.every(file => file.status === 'matched' && file.locked), album.title)
})

/** Opens Fix match for an album through the admin album search and waits for the candidates. */
async function openFixMatch(title) {
  await page.goto(`${base}/admin/library`)
  await button('Fix a match').click()
  await page.getByRole('dialog').getByPlaceholder('Album or artist').fill(title)
  await page.getByRole('list', { name: 'Albums' }).getByRole('button', { name: new RegExp(title) }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Fix match', exact: true })
  await dialog.getByText('Track by track').waitFor({ timeout: minutes(2) })
  return dialog
}

await step('fix match', async () => {
  let dialog = await openFixMatch('Abbey Road')
  // The album's own detail may be fetched from MusicBrainz on demand, after the candidates.
  await dialog.getByText(/Identified on MusicBrainz/).waitFor({ timeout: minutes(1) })
  check('fix match shows the current identification', true)
  await button('Use the tags', dialog).click()
  // The dialog stays to say what the choice did, and offers only Done.
  await dialog.getByRole('status').filter({ hasText: 'Playing from its tags. The files are locked to their tags.' }).waitFor()
  check('the dialog says what Use the tags did, with only Done left', await button('Done', dialog).isVisible() && !(await button('Use this release', dialog).count()))
  await button('Done', dialog).click()
  await dialog.waitFor({ state: 'detached' })
  let album = await albumNamed('Abbey Road')
  check('unmatch puts the album back on its tags', album && album.mbid === null)

  dialog = await openFixMatch('Abbey Road')
  check('the search is prefilled from the album', (await dialog.getByLabel('Search MusicBrainz').inputValue()) === 'The Beatles - Abbey Road')
  await dialog.getByLabel('Search MusicBrainz').fill('The Beatles - Abbey Road')
  await button('Search', dialog).click()
  await dialog.getByText('Track by track').waitFor({ timeout: minutes(2) })
  await button('Use this release', dialog).click()
  await dialog.getByRole('status').filter({ hasText: /^Matched to .+\. The files are locked to this release\.$/ }).waitFor()
  await button('Done', dialog).click()
  await dialog.waitFor({ state: 'detached' })
  album = await albumNamed('Abbey Road')
  check('rematch identifies the album with the chosen release', !!album?.mbid, album?.mbid)
})

await step('organize', async () => {
  const from = path.join(inbox, 'incoming', 'discovery_320', '01_one_more_time.mp3')
  const to = path.join(inbox, 'Daft Punk', 'Discovery (2001)', '01 One More Time.mp3')
  await waitForIdentification()
  await page.goto(`${base}/admin/organize`)
  await page.getByRole('switch', { name: 'Write tags' }).click()
  await button('Preview').click()
  const preview = page.getByRole('region', { name: 'Preview' })
  await preview.getByRole('heading', { name: '14 moves in 1 album' }).waitFor()
  check('the preview lists the moves of the identified album', await preview.getByText('incoming/discovery_320/01_one_more_time.mp3').isVisible() && await preview.getByText('Daft Punk/Discovery (2001)/01 One More Time.mp3').isVisible())
  check('unidentified music stays put', await preview.getByText(/5 files not identified stay put/).isVisible())
  await button('Apply all').click()
  const undo = button('Undo')
  await undo.waitFor({ timeout: minutes(2) })
  check('apply moves the files on disk', existsSync(to) && !existsSync(from))
  await undo.click()
  const confirm = page.getByRole('dialog')
  check('undo says what it restores and that tags stay written', (await confirm.textContent()).includes('move back to where they were') && (await confirm.textContent()).includes('tags written by this batch stay as they are'))
  await button('Undo batch', confirm).click()
  await page.getByText('Undone', { exact: true }).waitFor({ timeout: minutes(2) })
  check('undo moves them back', existsSync(from) && !existsSync(to))
})

await step('search index', async () => {
  await page.goto(`${base}/admin/search-index`)
  await page.getByText('Not set up').waitFor()
  await page.getByLabel('A URL or a file on this server').check()
  await page.locator('#dump-source').fill(dump)
  await button('Start import').click()
  await page.getByText('Ready', { exact: true }).waitFor({ timeout: minutes(2) })
  const status = await api('/admin/catalog-index')
  check('an import from a server path makes the index ready', status.ready && await page.getByText(status.counts.recordings.toLocaleString('en')).first().isVisible(), `${status.counts.artists} artists, ${status.counts.albums} albums, ${status.counts.recordings} songs`)
  await button('Remove').click()
  await button('Remove index', page.getByRole('dialog')).click()
  await page.getByText('Not set up').waitFor()
  check('removing it empties the index', !(await api('/admin/catalog-index')).ready)
})

await browser.close()
console.log(`\n${total - failed} of ${total} checks passed`)
process.exit(failed ? 1 : 0)
