// Checks the browser PlayerEngine against the client-core contract in real Chromium, on the
// /dev/engine page with the tones from scripts/dev-audio.mjs.
// Usage: node scripts/e2e-engine.mjs <baseUrl> <username> <password>
// Needs the Vite dev server (which serves the tones) in front of a server where that user exists.
import { chromium } from 'playwright'

const [base = 'http://localhost:5173', username, password] = process.argv.slice(2)
if (!username || !password) {
  console.error('Usage: node scripts/e2e-engine.mjs <baseUrl> <username> <password>')
  process.exit(2)
}

const BLOCKED = 'The browser blocked audio until you click or press a key on the page'
const results = []
let failed = 0

function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  if (!ok) failed += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

async function signIn(context) {
  const login = await context.request.post(`${base}/api/v1/auth/login`, {
    headers: { 'X-Squirmy-Client': 'web', 'X-Squirmy-Request': '1' },
    data: { username, password },
  })
  if (!login.ok()) throw new Error(`Login failed: ${login.status()} ${await login.text()}`)
}

async function openEngine(browser) {
  const context = await browser.newContext()
  await signIn(context)
  const page = await context.newPage()
  page.on('pageerror', error => console.log(`page error: ${error.message}`))
  await page.goto(`${base}/dev/engine`)
  await page.waitForFunction(() => window.squirmyEngine)
  await installHelpers(page)
  return { context, page }
}

/** Puts the engine and a few helpers on `window.t` for the checks below, which run in the page. */
function installHelpers(page) {
  return page.evaluate(() => {
    const { engine, events, level } = window.squirmyEngine
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
    window.t = {
      engine,
      events,
      level,
      wait,
      async until(predicate, timeout = 5000) {
        const start = performance.now()
        while (!predicate()) {
          if (performance.now() - start > timeout) throw new Error(`Timed out waiting for ${predicate}`)
          await wait(5)
        }
        return performance.now() - start
      },
      since: index => events.slice(index).map(({ event }) => event),
      async meanLevel(samples = 8) {
        let sum = 0
        for (let index = 0; index < samples; index += 1) {
          sum += level()
          await wait(40)
        }
        return sum / samples
      },
    }
  })
}

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] })
try {
  const { page } = await openEngine(browser)

  // load, paused at a start position
  let result = await page.evaluate(async () => {
    const { engine, events, until, since } = window.t
    const mark = events.length
    engine.load({ entryId: 'a1', url: '/dev-audio/a.flac', startMs: 1000, autoplay: false, gain: 1 })
    const took = await until(() => engine.getStatus().state === 'paused')
    return { took, events: since(mark), status: engine.getStatus() }
  })
  check('load emits loading then paused', JSON.stringify(result.events.map(event => event.status?.state)) === '["loading","paused"]', `${Math.round(result.took)} ms`)
  check('load lands at startMs', Math.abs(result.status.positionMs - 1000) <= 5, `${result.status.positionMs} ms`)

  // play, and the position follows the clock
  result = await page.evaluate(async () => {
    const { engine, events, wait, until, since } = window.t
    const mark = events.length
    engine.play()
    await until(() => engine.getStatus().state === 'playing' && engine.getStatus().positionMs > 1000)
    const p0 = engine.getStatus().positionMs, t0 = performance.now()
    await wait(1000)
    const p1 = engine.getStatus().positionMs, t1 = performance.now()
    return { events: since(mark), drift: (p1 - p0) - (t1 - t0) }
  })
  check('play emits playing', result.events.some(event => event.status?.state === 'playing'))
  check('position advances with real time', Math.abs(result.drift) <= 60, `drift ${Math.round(result.drift)} ms over 1 s`)

  // gain, including a boost above unity
  result = await page.evaluate(async () => {
    const { engine, wait, meanLevel } = window.t
    engine.setGain(1); await wait(150); const unity = await meanLevel()
    engine.setGain(2); await wait(150); const boosted = await meanLevel()
    engine.setGain(0.5); await wait(150); const cut = await meanLevel()
    engine.setGain(1)
    return { unity, boosted, cut }
  })
  check('output level at unity matches the tone', Math.abs(result.unity - 0.02 / Math.SQRT2) < 0.004, `rms ${result.unity.toFixed(4)}`)
  check('gain 2 boosts', Math.abs(result.boosted / result.unity - 2) < 0.15, `x${(result.boosted / result.unity).toFixed(2)}`)
  check('gain 0.5 cuts', Math.abs(result.cut / result.unity - 0.5) < 0.08, `x${(result.cut / result.unity).toFixed(2)}`)

  // pause holds the position
  result = await page.evaluate(async () => {
    const { engine, events, level, wait, since } = window.t
    const mark = events.length
    engine.pause()
    const p0 = engine.getStatus().positionMs
    await wait(300)
    return { events: since(mark), moved: engine.getStatus().positionMs - p0, level: level() }
  })
  check('pause emits paused and holds position', result.events.at(-1)?.status?.state === 'paused' && Math.abs(result.moved) <= 1, `moved ${result.moved} ms`)

  // seek while paused and while playing; status once it lands
  result = await page.evaluate(async () => {
    const { engine, events, until, since } = window.t
    let mark = events.length
    engine.seek(2500)
    const reported = engine.getStatus().positionMs
    const landed = await until(() => since(mark).some(event => event.type === 'status'))
    const pausedSeek = since(mark).find(event => event.type === 'status').status
    engine.play()
    await until(() => engine.getStatus().state === 'playing')
    mark = events.length
    engine.seek(500)
    await until(() => since(mark).some(event => event.type === 'status' && event.status.positionMs < 1000))
    const playingSeek = since(mark).find(event => event.type === 'status').status
    engine.pause()
    return { reported, landed, pausedSeek, playingSeek }
  })
  check('seek reports the target at once', result.reported === 2500)
  check('paused seek emits status when it lands', result.pausedSeek.state === 'paused' && Math.abs(result.pausedSeek.positionMs - 2500) <= 20, `${Math.round(result.landed)} ms, at ${result.pausedSeek.positionMs}`)
  check('playing seek keeps playing', result.playingSeek.state === 'playing' && Math.abs(result.playingSeek.positionMs - 500) <= 30, `at ${result.playingSeek.positionMs}`)

  // natural end with a preload: the preload starts before `ended`, then status for it
  result = await page.evaluate(async () => {
    const { engine, events, wait, until, since } = window.t
    engine.load({ entryId: 'a2', url: '/dev-audio/a.flac', startMs: 3000, autoplay: true, gain: 1 })
    engine.preload({ entryId: 'b1', url: '/dev-audio/b.flac', gain: 1 })
    await until(() => engine.getStatus().state === 'playing')
    const mark = events.length
    let atEnded = null, endedAt = 0
    const off = engine.subscribe(event => {
      if (event.type === 'ended') { atEnded = engine.getStatus(); endedAt = performance.now() }
    })
    await until(() => atEnded !== null, 4000)
    off()
    await wait(300)
    const after = engine.getStatus()
    const elapsed = performance.now() - endedAt
    return { events: since(mark).slice(0, 2), atEnded, gap: elapsed - after.positionMs }
  })
  check('ended comes after the preload started', result.atEnded.entryId === 'b1' && result.atEnded.state === 'playing', JSON.stringify(result.atEnded))
  check('ended then status for the preloaded entry', result.events[0]?.type === 'ended' && result.events[0].entryId === 'a2' && result.events[1]?.status?.entryId === 'b1')
  check('gap between entries is small', result.gap < 120, `${Math.round(result.gap)} ms`)

  // natural end without a preload
  result = await page.evaluate(async () => {
    const { engine, events, wait, until, since } = window.t
    engine.seek(2500)
    const mark = events.length
    await until(() => since(mark).some(event => event.type === 'ended'), 4000)
    await wait(20)
    return { events: since(mark), status: engine.getStatus() }
  })
  const endedIndex = result.events.findIndex(event => event.type === 'ended')
  check('ended without a preload stays on the entry', result.status.state === 'ended' && result.status.entryId === 'b1' && result.events[endedIndex + 1]?.status?.state === 'ended', `at ${result.status.positionMs}`)
  check('ended position is the duration', Math.abs(result.status.positionMs - 3000) <= 30)

  // seek from ended becomes paused
  result = await page.evaluate(async () => {
    const { engine, events, until, since } = window.t
    const mark = events.length
    engine.seek(1000)
    await until(() => since(mark).some(event => event.type === 'status'))
    return engine.getStatus()
  })
  check('seek from ended becomes paused', result.state === 'paused' && Math.abs(result.positionMs - 1000) <= 20)

  // loading the preloaded entry reuses its buffer
  result = await page.evaluate(async () => {
    const { engine, events, wait, until, since } = window.t
    engine.preload({ entryId: 'c1', url: '/dev-audio/c.flac', gain: 1 })
    await wait(500)
    const mark = events.length
    engine.load({ entryId: 'c1', url: '/dev-audio/c.flac', startMs: 0, autoplay: false, gain: 1 })
    const took = await until(() => engine.getStatus().state === 'paused')
    return { took, events: since(mark), replacedEnded: since(mark).some(event => event.type === 'ended') }
  })
  check('loading the preloaded entry is quick', result.took < 50, `${Math.round(result.took)} ms`)
  check('a replaced entry never ends', !result.replacedEnded)

  // errors
  for (const [name, url] of [['missing file', '/dev-audio/missing.flac'], ['not audio', '/dev-audio/broken.flac']]) {
    result = await page.evaluate(async arg => {
    const { engine, events, until, since } = window.t
      const mark = events.length
      engine.load({ entryId: 'bad', url: arg, startMs: 0, autoplay: true, gain: 1 })
      await until(() => engine.getStatus().state === 'error')
      return since(mark)
  }, url)
    const error = result.find(event => event.type === 'error')
    check(`${name} emits error then status error`, !!error && result.at(-1)?.status?.state === 'error', error?.message)
  }

  // stop
  result = await page.evaluate(async () => {
    const { engine, events, since } = window.t
    const mark = events.length
    engine.stop()
    return { events: since(mark), status: engine.getStatus() }
  })
  check('stop goes idle and emits status', result.status.entryId === null && result.status.state === 'idle' && result.events.length === 1)
} finally {
  await browser.close()
}

// A browser that requires a gesture: play is refused, reported, and recovered by a click.
// Playwright's evaluate counts as a gesture, so the page starts the tone itself (?autoplay=)
// and nothing is evaluated until the refusal has happened.
const strict = await chromium.launch({ args: ['--autoplay-policy=user-gesture-required'] })
try {
  const context = await strict.newContext()
  await signIn(context)
  const page = await context.newPage()
  await page.goto(`${base}/dev/engine?autoplay=a`)
  const button = page.getByRole('button', { name: 'Enable audio' })
  await page.waitForTimeout(2000)
  check('the shell offers to enable audio', await button.isVisible())
  await installHelpers(page)
  const result = await page.evaluate(() => {
    const { engine, events } = window.t
    return { error: events.map(({ event }) => event).find(event => event.type === 'error'), state: engine.getStatus().state, blocked: engine.isBlocked() }
  })
  check('a refused play is reported as blocked', result.blocked && result.state === 'error' && result.error?.message === BLOCKED, result.error?.message)
  await button.click()
  const after = await page.evaluate(async () => {
    const { engine, level, wait, until } = window.t
    await until(() => engine.getStatus().state === 'playing', 3000)
    await wait(300)
    return { state: engine.getStatus().state, level: level(), blocked: engine.isBlocked() }
  })
  check('a click enables audio and plays', after.state === 'playing' && !after.blocked && after.level > 0.005, `rms ${after.level.toFixed(4)}`)
  check('the notice goes away', !(await button.isVisible()))
} finally {
  await strict.close()
}

console.log(`\n${results.length - failed} of ${results.length} checks passed`)
process.exit(failed ? 1 : 0)
