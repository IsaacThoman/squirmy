// Walks the account flows in real Chromium against a server that has not been set up yet:
// setup, sign out and in, invites and registration, admin-only pages, the settings dialog
// (opening it, its sections, the Last.fm return said in Scrobbling), appearance kept across reloads with no
// flash of the wrong colors, password changes, app passwords, server settings, the app shell
// (folding and resizing the sidebar, the phone drawer) and the reconnect notice.
// Usage: node scripts/e2e-auth.mjs <baseUrl> [--restart "<command that restarts the API>"]
// Without --restart the reconnect check is skipped. Leaves an admin `admin` and a member
// `sam` behind; their passwords are printed at the end.
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'

const args = process.argv.slice(2)
const base = args.find(arg => !arg.startsWith('--')) ?? 'http://localhost:5173'
const restartIndex = args.indexOf('--restart')
const restart = restartIndex >= 0 ? args[restartIndex + 1] : null

const admin = { username: 'admin', password: 'correct horse battery', newPassword: 'another horse battery' }
const member = { username: 'sam', password: 'listen closely' }
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

const path = page => new URL(page.url()).pathname + new URL(page.url()).search
const heading = (page, name) => page.getByRole('heading', { name, exact: true })
const settings = page => page.getByRole('dialog', { name: 'Settings' })
const settingsSection = (page, name) => settings(page).getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name, exact: true })
// A closed phone drawer is aria-hidden, so it is found by its markup rather than its role.
const sidebar = page => page.locator('aside[aria-label="Sidebar"]')
const sidebarWidth = async page => Math.round((await sidebar(page).boundingBox()).width)
/** Waits out the sidebar's 300 ms fold. */
const settle = page => page.waitForTimeout(450)

/** Reloads and records the sidebar's width in every frame of the first second. */
async function reloadWatchingSidebar(page) {
  await page.evaluate(() => sessionStorage.setItem('e2e.watch-sidebar', '1'))
  await page.reload()
  await heading(page, 'Listen now').waitFor()
  await page.waitForTimeout(1000)
  return page.evaluate(() => window.__sidebarWidths ?? [])
}

/** What the page applied from storage, with every script but /appearance.js blocked so the app never runs. */
async function beforeAppScript(context) {
  const bare = await context.newPage()
  await bare.route(() => true, route => (route.request().resourceType() === 'script' && !route.request().url().endsWith('/appearance.js') ? route.abort() : route.continue()))
  await bare.goto(`${base}/`)
  const state = await bare.evaluate(() => ({
    dark: document.documentElement.classList.contains('dark'),
    theme: document.getElementById('squirmy-color-theme')?.textContent ?? null,
    app: document.getElementById('root').childElementCount,
  }))
  await bare.close()
  return state
}

async function apiLogin(username, password) {
  const response = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Squirmy-Request': '1' },
    body: JSON.stringify({ username, password }),
  })
  return response.status
}

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await context.addInitScript(() => {
  if (sessionStorage.getItem('e2e.watch-sidebar') !== '1') return
  sessionStorage.removeItem('e2e.watch-sidebar')
  const widths = window.__sidebarWidths = []
  const start = performance.now()
  const frame = () => {
    const aside = document.querySelector('aside[aria-label="Sidebar"]')
    if (aside) widths.push(Math.round(aside.getBoundingClientRect().width))
    if (performance.now() - start < 1000) requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
})
const page = await context.newPage()
page.on('pageerror', error => console.log(`page error: ${error.message}`))
let inviteLink = null

await step('setup wizard', async () => {
  await page.goto(`${base}/library/albums`)
  await heading(page, 'Welcome to Squirmy').waitFor()
  check('a fresh server opens the setup wizard', path(page) === '/setup', path(page))

  await page.getByLabel('Username').fill(admin.username)
  await page.getByLabel('Password').fill('short')
  await page.getByRole('button', { name: 'Continue' }).click()
  check('setup validates with the contract schema', await page.getByText('At least 8 characters').isVisible())

  await page.getByLabel('Password').fill(admin.password)
  await page.getByRole('button', { name: 'Continue' }).click()
  await heading(page, 'Where is your music?').waitFor()
  check('creating the admin moves on to the music folder', path(page) === '/setup/library')

  const folders = page.getByRole('list').getByRole('button')
  await folders.first().waitFor()
  const folder = (await folders.first().textContent()).trim()
  await folders.first().click()
  await page.waitForFunction(name => document.querySelector('input[aria-label="Folder path"]')?.value.endsWith(`/${name}`), folder)
  check('the folder picker browses the server', true, await page.getByLabel('Folder path').inputValue())
  await page.getByRole('button', { name: 'Add and scan' }).click()
  await heading(page, 'You’re all set').waitFor()
  const skipped = await page.getByText('cannot add library folders yet').isVisible()
  const added = await page.getByText('Your music folder', { exact: true }).isVisible()
  check('adding the folder finishes setup', skipped || added, skipped ? 'skipped: no library route on this server' : 'added')
  await page.getByRole('button', { name: 'Start listening' }).click()
  await heading(page, 'Listen now').waitFor()
  check('setup ends in the app shell', path(page) === '/')
})

await step('sign out and in', async () => {
  await page.getByRole('button', { name: /^Account, / }).click()
  await page.getByRole('menuitem', { name: 'Log out' }).click()
  await heading(page, 'Sign in to Squirmy').waitFor()
  check('log out shows sign-in', path(page) === '/login')

  await page.getByLabel('Username').fill(admin.username)
  await page.getByLabel('Password').fill('not the password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  const alert = page.getByRole('alert')
  await alert.waitFor()
  check('a wrong password is refused inline', (await alert.textContent()).includes('Wrong username or password'))

  await page.getByLabel('Password').fill(admin.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await heading(page, 'Listen now').waitFor()
  check('the right password signs in', path(page) === '/')
})

await step('a signed-out visit returns to where it was going', async () => {
  const other = await browser.newContext()
  const visitor = await other.newPage()
  await visitor.goto(`${base}/admin/jobs`)
  await heading(visitor, 'Sign in to Squirmy').waitFor()
  check('signed-out visitors are sent to sign-in', path(visitor) === '/login?next=%2Fadmin%2Fjobs', path(visitor))
  await other.close()
})

await step('invites', async () => {
  await page.goto(`${base}/admin/users`)
  await heading(page, 'Users & invites').waitFor()
  await page.getByRole('button', { name: 'Invite someone' }).click()
  await page.getByRole('button', { name: 'Create invite' }).click()
  const link = page.getByLabel('Invite link')
  await link.waitFor()
  inviteLink = await link.inputValue()
  check('an invite gives a copyable link', inviteLink.includes('/register?invite='), inviteLink)
  await page.getByRole('button', { name: 'Done' }).click()
})

await step('register with the invite', async () => {
  const other = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const guest = await other.newPage()
  await guest.goto(inviteLink)
  await heading(guest, 'Join Squirmy').waitFor()
  check('the invite code is filled in', (await guest.getByLabel('Invite code').inputValue()) === new URL(inviteLink).searchParams.get('invite'))
  await guest.getByLabel('Username').fill(member.username)
  await guest.getByLabel('Password').fill(member.password)
  await guest.getByRole('button', { name: 'Create account' }).click()
  await heading(guest, 'Listen now').waitFor()
  check('registering signs the new user in', path(guest) === '/')
  check('members get no Admin link', await guest.getByRole('link', { name: /^Admin/ }).count() === 0)
  await guest.getByRole('button', { name: /^Account, / }).click()
  await guest.getByRole('menuitem', { name: 'Settings' }).waitFor()
  check('a member\'s account menu has no Admin panel', await guest.getByRole('menuitem', { name: 'Admin panel' }).count() === 0)
  await guest.keyboard.press('Escape')
  await guest.keyboard.press('ControlOrMeta+k')
  const places = guest.getByRole('dialog', { name: 'Search' }).getByRole('listbox', { name: 'Go to' })
  await places.getByRole('option', { name: 'Albums' }).waitFor()
  check('nor does quick search offer it', await places.getByRole('option', { name: 'Admin panel' }).count() === 0)
  await guest.keyboard.press('Escape')
  for (const route of ['/admin/users', '/admin/settings']) {
    await guest.goto(`${base}${route}`)
    await heading(guest, 'Admins only').waitFor()
    check(`a member cannot open ${route}`, true)
  }
  await other.close()

  const reuse = await fetch(`${base}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Squirmy-Request': '1' },
    body: JSON.stringify({ inviteCode: new URL(inviteLink).searchParams.get('invite'), username: 'robin', password: 'another member' }),
  })
  check('an invite works once', reuse.status === 400)
})

await step('the settings dialog', async () => {
  await page.goto(`${base}/`)
  await heading(page, 'Listen now').waitFor()
  await page.getByRole('button', { name: /^Account, / }).click()
  await page.getByRole('menuitem', { name: 'Admin panel' }).waitFor()
  check('an admin\'s account menu links to the admin panel', true)
  await page.getByRole('menuitem', { name: 'Settings' }).click()
  await settings(page).waitFor()
  check('Settings in the account menu opens the dialog on Playback', await settingsSection(page, 'Playback').getAttribute('aria-current') === 'page')
  for (const name of ['Playback', 'Appearance', 'Account', 'Scrobbling', 'App passwords', 'About']) {
    await settingsSection(page, name).click()
    await settings(page).getByRole('heading', { name, exact: true, level: 2 }).waitFor({ timeout: 5000 })
  }
  check('each section opens from the section list', true)
  const version = (await (await fetch(`${base}/api/v1/setup/status`)).json()).version
  check('About shows the server\'s version', await settings(page).getByText(`Squirmy ${version}`, { exact: true }).isVisible(), version)
  await page.keyboard.press('Escape')
  await settings(page).waitFor({ state: 'detached' })
  check('Escape closes it', path(page) === '/')

  await page.keyboard.press('ControlOrMeta+Comma')
  await settings(page).waitFor({ timeout: 5000 })
  check('Ctrl/Cmd+comma opens it', true)
  await page.keyboard.press('Escape')
  await settings(page).waitFor({ state: 'detached' })

  await page.goto(`${base}/settings/app-passwords`)
  await settings(page).waitFor()
  check('/settings/<section> opens that section over Home', await settingsSection(page, 'App passwords').getAttribute('aria-current') === 'page' && path(page) === '/', path(page))
  await page.keyboard.press('Escape')

  await page.goto(`${base}/settings?lastfm=connected`)
  await settings(page).waitFor()
  // Said at the top of the Scrobbling section it opens, not over the page.
  await settings(page).getByRole('status').filter({ hasText: 'Connected to Last.fm.' }).waitFor({ timeout: 5000 })
  check('returning from Last.fm says so in Scrobbling, which it opens', await settingsSection(page, 'Scrobbling').getAttribute('aria-current') === 'page')
  await page.keyboard.press('Escape')
  await settings(page).waitFor({ state: 'detached' })
})

await step('appearance', async () => {
  await page.goto(`${base}/settings/appearance`)
  await settings(page).waitFor()
  const mode = name => settings(page).getByRole('group', { name: 'Theme' }).getByRole('button', { name, exact: true })
  const theme = name => settings(page).getByRole('group', { name: 'Color theme' }).getByRole('button', { name, exact: true })
  const applied = () => page.evaluate(() => ({ dark: document.documentElement.classList.contains('dark'), theme: document.getElementById('squirmy-color-theme')?.textContent ?? null }))
  check('a new browser follows the system (light here)', await mode('System').getAttribute('aria-pressed') === 'true' && !(await applied()).dark)
  await mode('Dark').click()
  await theme('Ocean').click()
  const chosen = await applied()
  check('Dark and a color theme apply at once', chosen.dark && Boolean(chosen.theme))
  check('the chosen theme is marked', await theme('Ocean').getAttribute('aria-pressed') === 'true')
  const early = await beforeAppScript(context)
  check('the appearance script applies both before the app script runs', early.app === 0 && early.dark && early.theme === chosen.theme, `app ${early.app}, dark ${early.dark}, theme ${early.theme === chosen.theme ? 'same' : (early.theme ?? 'none').slice(0, 40)}`)
  await page.goto(`${base}/settings/appearance`)
  await settings(page).waitFor()
  const reloaded = await applied()
  check('both survive a reload', reloaded.dark && reloaded.theme === chosen.theme && await theme('Ocean').getAttribute('aria-pressed') === 'true' && await mode('Dark').getAttribute('aria-pressed') === 'true')

  await mode('Light').click()
  await theme('Squirmy').click()
  const reset = await applied()
  check('Light and the default theme drop the dark class and the theme stylesheet', !reset.dark && reset.theme === null)
  const earlyLight = await beforeAppScript(context)
  check('and the appearance script applies that before the app script runs', earlyLight.app === 0 && !earlyLight.dark && earlyLight.theme === null)
  await mode('System').click()
  await page.keyboard.press('Escape')
  await settings(page).waitFor({ state: 'detached' })
})

await step('change password', async () => {
  await page.goto(`${base}/settings/account`)
  await page.getByRole('button', { name: 'Change password' }).click()
  const dialog = page.getByRole('dialog', { name: 'Change password' })
  await dialog.getByLabel('Current password').fill('wrong current password')
  await dialog.getByLabel('New password', { exact: true }).fill(admin.newPassword)
  await dialog.getByLabel('Repeat the new password').fill(admin.newPassword)
  await dialog.getByRole('button', { name: 'Change password' }).click()
  await dialog.getByText('The current password is wrong').waitFor()
  check('a wrong current password shows on its field', true)
  await dialog.getByLabel('Current password').fill(admin.password)
  await dialog.getByRole('button', { name: 'Change password' }).click()
  await dialog.waitFor({ state: 'detached' })
  // The Account section says it, where the password is changed.
  check('the Account section says the password changed', await settings(page).getByRole('status').filter({ hasText: 'Password changed. Your other sessions were signed out.' }).waitFor({ timeout: 5000 }).then(() => true, () => false))
  const me = await page.request.get(`${base}/api/v1/auth/me`, { headers: { 'X-Squirmy-Request': '1' } })
  check('the password changes and this browser stays signed in', me.ok() && await settings(page).isVisible(), `me ${me.status()}`)
  check('the old password no longer works', await apiLogin(admin.username, admin.password) === 401)
  check('the new password works', await apiLogin(admin.username, admin.newPassword) === 200)
})

await step('app passwords', async () => {
  await settingsSection(page, 'App passwords').click()
  await settings(page).getByRole('button', { name: 'Create', exact: true }).click()
  const create = page.getByRole('dialog', { name: 'New app password' })
  await create.getByLabel('Name', { exact: true }).fill('Car stereo')
  await create.getByRole('button', { name: 'Create' }).click()
  const secret = page.getByRole('textbox', { name: 'App password' })
  await secret.waitFor()
  check('a new app password is shown once', (await secret.inputValue()).length >= 16)
  await page.getByRole('button', { name: 'Done' }).click()
  const row = page.getByText('Car stereo', { exact: true })
  await row.waitFor()
  check('it is listed', true)
  await settings(page).getByRole('button', { name: 'Revoke' }).click()
  await page.getByRole('dialog', { name: 'Revoke “Car stereo”?' }).getByRole('button', { name: 'Revoke' }).click()
  await row.waitFor({ state: 'detached' })
  check('revoking removes it', await page.getByText('No app passwords').isVisible())
  await page.keyboard.press('Escape')
})

await step('server settings persist', async () => {
  await page.goto(`${base}/admin/settings`)
  const name = page.getByLabel('Server name')
  await name.fill('Squirmy Test')
  await name.press('Enter')
  await page.getByRole('status').getByText('Saved').waitFor()
  await page.getByRole('switch', { name: 'Deezer' }).click()
  await page.getByRole('button', { name: 'Add key' }).nth(1).click()
  await page.getByRole('dialog').getByLabel('API key').fill('an-acoustid-key')
  await page.getByRole('button', { name: 'Save key' }).click()
  await page.getByRole('dialog').waitFor({ state: 'detached' })
  await page.waitForTimeout(300)
  await page.reload()
  await name.waitFor()
  check('the server name persists', await name.inputValue() === 'Squirmy Test')
  check('a toggle persists', await page.getByRole('switch', { name: 'Deezer' }).getAttribute('aria-checked') === 'false')
  check('a key shows as set and is never sent back', await page.getByRole('button', { name: 'Change' }).count() === 1)
  const status = await (await fetch(`${base}/api/v1/setup/status`)).json()
  check('the sign-in screens see the new name', status.serverName === 'Squirmy Test')
})

await step('jobs', async () => {
  await page.goto(`${base}/admin/jobs`)
  await page.getByText(/Live · updated/).waitFor()
  check('the jobs page loads and refreshes itself', true)
})

await step('the sidebar folds and keeps its width', async () => {
  await page.goto(`${base}/`)
  await heading(page, 'Listen now').waitFor()
  const open = await sidebarWidth(page)
  check('the sidebar starts open at its default width', open === 264, `${open}px`)
  await page.keyboard.press('ControlOrMeta+b')
  await settle(page)
  check('Ctrl/Cmd+B folds it to a rail', await sidebarWidth(page) === 52 && await sidebar(page).getByRole('button', { name: 'Open sidebar' }).isVisible(), `${await sidebarWidth(page)}px`)
  check('the rail keeps its links', await sidebar(page).getByRole('link', { name: 'Albums' }).isVisible())
  const foldedLoad = [...new Set(await reloadWatchingSidebar(page))]
  check('folded survives a reload, with no animation on load', foldedLoad.length === 1 && foldedLoad[0] === 52, foldedLoad.join(' → '))
  await page.keyboard.press('ControlOrMeta+b')
  await settle(page)
  check('Ctrl/Cmd+B opens it again', await sidebarWidth(page) === open)
  await page.reload()
  await heading(page, 'Listen now').waitFor()
  check('open survives a reload', await sidebarWidth(page) === open)

  const handle = page.getByRole('separator', { name: 'Resize sidebar' })
  const box = await handle.boundingBox()
  const x = box.x + box.width / 2
  const y = box.y + 200
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 40, y, { steps: 4 })
  await page.mouse.move(x + 80, y, { steps: 4 })
  await page.mouse.up()
  await settle(page)
  const dragged = await sidebarWidth(page)
  check('dragging its edge resizes it', Math.abs(dragged - (open + 80)) <= 2, `${dragged}px`)
  const load = [...new Set(await reloadWatchingSidebar(page))]
  check('the width survives a reload', Math.abs(await sidebarWidth(page) - dragged) <= 1, `${await sidebarWidth(page)}px`)
  check('the sidebar is painted at its kept width from the first frame', load.length === 1 && load[0] === dragged, `${load.slice(0, 3).join(' → ')}${load.length > 3 ? ` … ${load.at(-1)}` : ''} px`)

  const again = await handle.boundingBox()
  await page.mouse.move(again.x + again.width / 2, y)
  await page.mouse.down()
  await page.mouse.move(again.x - 150, y, { steps: 6 })
  await page.mouse.move(again.x - 250, y, { steps: 6 })
  await page.mouse.up()
  await settle(page)
  check('dragging it in past the snap point folds it', await sidebarWidth(page) === 52, `${await sidebarWidth(page)}px`)
  await page.keyboard.press('ControlOrMeta+b')
  await settle(page)
  check('it reopens at the width it had', Math.abs(await sidebarWidth(page) - dragged) <= 1, `${await sidebarWidth(page)}px`)
  await handle.dblclick()
  await settle(page)
  check('a double click restores the default width', await sidebarWidth(page) === open, `${await sidebarWidth(page)}px`)
})

await step('the phone drawer', async () => {
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: await context.storageState() })
  const tab = await phone.newPage()
  await tab.goto(`${base}/`)
  await heading(tab, 'Listen now').waitFor()
  const drawerOpen = async () => (await sidebar(tab).evaluate(aside => !aside.inert && aside.getBoundingClientRect().left >= 0))
  check('the sidebar is closed on a phone', !(await drawerOpen()))
  check('there is no tab bar', await tab.evaluate(() => [...document.querySelectorAll('nav')].every(nav => nav.closest('aside'))))
  const opener = tab.getByRole('button', { name: 'Open sidebar' })
  await opener.click()
  await tab.waitForTimeout(300)
  check('Open sidebar slides the drawer in', await drawerOpen())
  await sidebar(tab).getByRole('link', { name: 'Library' }).click()
  await tab.waitForURL('**/library?filter=*')
  await tab.waitForTimeout(300)
  check('following a link navigates and closes the drawer', !(await drawerOpen()))
  await opener.click()
  await tab.waitForTimeout(300)
  check('focus moves into the drawer', await sidebar(tab).evaluate(aside => aside.contains(document.activeElement)))
  await tab.keyboard.press('Escape')
  await tab.waitForTimeout(300)
  check('Escape closes it and gives focus back', !(await drawerOpen()) && await opener.evaluate(button => button === document.activeElement))
  await opener.click()
  await tab.waitForTimeout(300)
  await sidebar(tab).getByRole('button', { name: /^Account, / }).click()
  await tab.getByRole('menuitem', { name: 'Settings' }).click()
  await settings(tab).waitFor()
  check('Settings opens from the drawer\'s account menu and the drawer closes', !(await drawerOpen()))
  await phone.close()
})

await step('the admin panel', async () => {
  await page.goto(`${base}/`)
  await heading(page, 'Listen now').waitFor()
  await page.getByRole('button', { name: /^Account, / }).click()
  await page.getByRole('menuitem', { name: 'Admin panel' }).click()
  await page.waitForURL('**/admin/library')
  await page.getByRole('heading', { name: 'Admin', level: 1 }).waitFor()
  check('Admin panel in the account menu opens the admin library', true)
  const nav = page.getByRole('navigation', { name: 'Admin sections' })
  const sections = { 'Library': 'library', 'Review queue': 'reviews', 'Organize': 'organize', 'Search index': 'search-index', 'Providers': 'providers', 'Users & invites': 'users', 'Server settings': 'settings', 'Jobs': 'jobs' }
  const listed = (await nav.getByRole('link').allTextContents()).map(text => text.trim())
  check('the header lists every admin section', listed.join() === Object.keys(sections).join(), listed.join(' · '))
  const missed = []
  let slowest = 0
  for (const [name, slug] of Object.entries(sections)) {
    const started = Date.now()
    await nav.getByRole('link', { name, exact: true }).click()
    await page.waitForURL(`**/admin/${slug}`)
    // Navigation renders in a transition: the address changes first, the page when it is ready.
    await nav.locator('[aria-current="page"]').filter({ hasText: name }).waitFor({ timeout: 5000 }).catch(() => {})
    slowest = Math.max(slowest, Date.now() - started)
    const current = await nav.locator('[aria-current="page"]').allTextContents()
    const broken = await page.getByText(/Something went wrong|Admins only/).allTextContents()
    if (current.join() !== name || broken.length) missed.push(`${name}: current ${current.join() || 'none'}${broken.length ? `, “${broken.join(' / ')}”` : ''}`)
  }
  check('each section opens and is marked current', missed.length === 0, missed.length ? missed.join('; ') : `slowest ${slowest} ms`)
  await page.keyboard.press('ControlOrMeta+k')
  const places = page.getByRole('dialog', { name: 'Search' }).getByRole('listbox', { name: 'Go to' })
  await places.getByRole('option', { name: 'Admin panel' }).click()
  await page.waitForURL('**/admin/library')
  check('quick search goes to the admin panel too', true)
})

await step('reconnect notice', async () => {
  if (!restart) return console.log('skip  reconnect notice (no --restart command)')
  await page.goto(`${base}/`)
  await heading(page, 'Listen now').waitFor()
  await page.waitForTimeout(1000)
  const notice = page.getByText('Reconnecting to the server…')
  check('no notice while connected', !(await notice.isVisible()))
  const started = Date.now()
  const child = spawn('sh', ['-c', restart], { stdio: 'inherit' })
  const restarted = new Promise(resolve => child.on('exit', resolve))
  await notice.waitFor({ timeout: 15_000 })
  const shown = Date.now() - started
  await notice.waitFor({ state: 'detached', timeout: 60_000 })
  check('the notice shows while the server is down and clears after', true, `shown after ${shown} ms, cleared after ${Date.now() - started} ms`)
  await restarted
})

await browser.close()
console.log(`\n${total - failed} of ${total} checks passed`)
console.log(`Accounts: ${admin.username} / ${admin.newPassword} (admin), ${member.username} / ${member.password} (member)`)
process.exit(failed ? 1 : 0)
