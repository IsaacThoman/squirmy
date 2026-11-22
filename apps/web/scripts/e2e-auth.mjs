// Walks the account flows in real Chromium against a server that has not been set up yet:
// setup, sign out and in, invites and registration, admin-only pages, password changes,
// app passwords, server settings, and the reconnect notice.
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
  check('members get no Admin link', await guest.getByRole('link', { name: 'Admin' }).count() === 0)
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

await step('change password', async () => {
  await page.goto(`${base}/settings/account`)
  await page.getByRole('button', { name: 'Change password' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Current password').fill('wrong current password')
  await dialog.getByLabel('New password', { exact: true }).fill(admin.newPassword)
  await dialog.getByLabel('Repeat the new password').fill(admin.newPassword)
  await dialog.getByRole('button', { name: 'Change password' }).click()
  await dialog.getByText('The current password is wrong').waitFor()
  check('a wrong current password shows on its field', true)
  await dialog.getByLabel('Current password').fill(admin.password)
  await dialog.getByRole('button', { name: 'Change password' }).click()
  await page.getByText('Password changed', { exact: true }).first().waitFor()
  check('the password changes and this browser stays signed in', await heading(page, 'Settings').isVisible())
  check('the old password no longer works', await apiLogin(admin.username, admin.password) === 401)
  check('the new password works', await apiLogin(admin.username, admin.newPassword) === 200)
})

await step('app passwords', async () => {
  await page.getByRole('link', { name: 'App passwords', exact: true }).click()
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.getByLabel('Name', { exact: true }).fill('Car stereo')
  await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click()
  const secret = page.getByRole('textbox', { name: 'App password' })
  await secret.waitFor()
  check('a new app password is shown once', (await secret.inputValue()).length >= 16)
  await page.getByRole('button', { name: 'Done' }).click()
  const row = page.getByText('Car stereo', { exact: true })
  await row.waitFor()
  check('it is listed', true)
  await page.getByRole('button', { name: 'Revoke' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Revoke' }).click()
  await row.waitFor({ state: 'detached' })
  check('revoking removes it', await page.getByText('No app passwords').isVisible())
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
