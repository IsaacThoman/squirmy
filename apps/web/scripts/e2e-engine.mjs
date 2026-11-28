// Checks the browser engines against the client-core PlayerEngine contract in a real browser,
// on the /dev/engine page with the tones from scripts/dev-audio.mjs: `WebPlayerEngine` (two
// elements) and `MseEngine` (one timeline through Media Source Extensions). It runs the output
// chain's true-peak limiter (the AudioWorklet) and equalizer on the iOS engine's test values,
// rendered offline, so silently and sample for sample, and records a crossfade between two
// tones (the iOS engine's test values: power within 0.5 dB through a 4 s fade), and two more
// with the songs' timing: one past their silence, one with Smart transitions. With a fixture
// library it also measures MseEngine through the server's own streams, recorded sample by
// sample through an AudioWorklet: the boundary between the two halves of a split tone,
// seeks inside and outside the buffer, and a background tab through three track changes.
//
// 1. node scripts/e2e-engine.mjs --prepare <dir>
//    Writes <dir>/music (split tones and a whole chirp from apps/server/src/test/audio.ts) and
//    <dir>/reference (the uncut chirps, outside the library).
// 2. Start a server with SQUIRMY_LIBRARY_PATHS=<dir>/music on a fresh database, and the Vite
//    dev server in front of it (SQUIRMY_API_URL). Run `npm run dev-audio -w @squirmy/web` once.
// 3. node scripts/e2e-engine.mjs <baseUrl> <username> <password> [--fixtures <dir>] [--browser chromium|webkit] [--engine web|mse]
//    A fresh server gets <username> as its admin. `--browser webkit` measures Safari's engine;
//    Firefox's Playwright build is not run here.
//
// Every tone is very quiet (about -34 dBFS), and the recordings are taken from the audio
// graph, not the speakers. SQUIRMY_E2E_DUMP=<dir> keeps each recording and its references
// there as raw interleaved 32-bit floats.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium, webkit } from 'playwright'

const argv = process.argv.slice(2)
const option = name => {
  const index = argv.indexOf(`--${name}`)
  if (index < 0) return undefined
  const [, value] = argv.splice(index, 2)
  return value
}

if (argv[0] === '--prepare') {
  const root = path.resolve(argv[1] ?? '')
  if (!argv[1]) {
    console.error('Usage: node scripts/e2e-engine.mjs --prepare <dir>')
    process.exit(2)
  }
  prepare(root)
  process.exit(0)
}

const fixtures = option('fixtures')
const browserName = option('browser') ?? 'chromium'
const onlyEngine = option('engine')
const [base = 'http://localhost:5173', username, password] = argv
if (!username || !password) {
  console.error('Usage: node scripts/e2e-engine.mjs <baseUrl> <username> <password> [--fixtures <dir>] [--browser chromium|webkit] [--engine web|mse]')
  process.exit(2)
}

const BLOCKED = 'The browser blocked audio until you click or press a key on the page'
/** Decoders that are not the same build differ in the last bits of a float: this much counts as the same sample (-120 dBFS). */
const SAME = 1e-6
const dbfs = value => `${(20 * Math.log10(value)).toFixed(1)} dBFS`
const HEADERS = { 'X-Squirmy-Client': 'web', 'X-Squirmy-Request': '1' }
const browserType = browserName === 'webkit' ? webkit : chromium
const results = []
let failed = 0

function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  if (!ok) failed += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

/** Writes the fixture library: each set of halves in a folder of its own, so each is its own album. */
function prepare(root) {
  const audio = new URL('../../server/src/test/audio.ts', import.meta.url).pathname
  rmSync(root, { recursive: true, force: true })
  const code = `
    import { makeSplitTone } from ${JSON.stringify(audio)}
    import { execFileSync } from 'node:child_process'
    import { copyFileSync, mkdirSync, renameSync } from 'node:fs'
    import path from 'node:path'
    const root = ${JSON.stringify(root)}
    const music = path.join(root, 'music', 'Fixture')
    const reference = path.join(root, 'reference')
    mkdirSync(reference, { recursive: true })
    for (const [folder, format] of [['MSE ALAC', 'alac'], ['MSE FLAC', 'flac'], ['MSE AAC', 'm4a'], ['MSE MP3', 'mp3']]) {
      const tone = await makeSplitTone(path.join(music, folder), { format })
      renameSync(tone.whole, path.join(reference, folder.split(' ')[1].toLowerCase() + '.flac'))
    }
    // The uncut chirp as a single of its own (named after it), to seek in: ALAC (encoded on the way) and FLAC (repackaged).
    mkdirSync(path.join(music, 'MSE Seek ALAC'), { recursive: true })
    mkdirSync(path.join(music, 'MSE Seek FLAC'), { recursive: true })
    execFileSync(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-v', 'error', '-y', '-i', path.join(reference, 'alac.flac'), '-c:a', 'alac',
      '-metadata', 'title=Seek ALAC', '-metadata', 'artist=Fixture', path.join(music, 'MSE Seek ALAC', 'Seek ALAC.m4a')])
    execFileSync(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-v', 'error', '-y', '-i', path.join(reference, 'flac.flac'), '-c:a', 'copy',
      '-metadata', 'title=Seek FLAC', '-metadata', 'artist=Fixture', path.join(music, 'MSE Seek FLAC', 'Seek FLAC.flac')])
    console.log('Wrote the fixture library to ' + path.join(root, 'music'))
  `
  execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', code], { stdio: 'inherit' })
}

async function signIn(context) {
  const status = await (await context.request.get(`${base}/api/v1/setup/status`)).json()
  if (status.needsSetup) await context.request.post(`${base}/api/v1/setup`, { headers: HEADERS, data: { username, password } })
  const login = await context.request.post(`${base}/api/v1/auth/login`, { headers: HEADERS, data: { username, password } })
  if (!login.ok()) throw new Error(`Login failed: ${login.status()} ${await login.text()}`)
  // A server set up here looks nothing up outside: the fixtures are tones.
  if (status.needsSetup) {
    await context.request.patch(`${base}/api/v1/admin/settings`, {
      headers: HEADERS, data: { musicBrainzEnabled: false, deezerEnabled: false, coverArtArchiveEnabled: false, wikidataEnabled: false, lrclibEnabled: false },
    })
  }
}

async function openEngine(browser, query) {
  const context = await browser.newContext()
  await signIn(context)
  const page = await context.newPage()
  page.on('pageerror', error => console.log(`page error: ${error.message}`))
  await page.goto(`${base}/dev/engine?${query}`)
  await page.waitForFunction(() => window.squirmyEngine)
  await installHelpers(page)
  return { context, page }
}

/** Puts the engine and a few helpers on `window.t` for the checks below, which run in the page. */
function installHelpers(page) {
  return page.evaluate(() => {
    const { engine, events, level, source } = window.squirmyEngine
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
    window.t = {
      engine,
      events,
      level,
      source,
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

// Muted: the recordings are taken from the audio graph, and nothing needs to come out of the speakers.
const launchArgs = browserName === 'chromium' ? ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] : []
const browser = await browserType.launch({ args: launchArgs })
const kinds = []
try {
  const probe = await openEngine(browser, 'engine=web')
  const mseSupported = await probe.page.evaluate(() => typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('audio/mp4; codecs="mp4a.40.2"'))
  console.log(`\nThe output chain in ${browserName}`)
  await outputChain(probe.page)
  await probe.context.close()
  for (const kind of ['web', 'mse']) {
    if (onlyEngine && onlyEngine !== kind) continue
    if (kind === 'mse' && !mseSupported) {
      console.log('skip  MseEngine: this browser has no Media Source Extensions for AAC in MP4')
      continue
    }
    kinds.push(kind)
    console.log(`\n${kind === 'mse' ? 'MseEngine' : 'WebPlayerEngine'} in ${browserName}`)
    const { page, context } = await openEngine(browser, `engine=${kind}`)
    await contract(page, kind)
    await context.close()
  }
} finally {
  await browser.close()
}
for (const kind of kinds) if (browserName === 'chromium') await blockedAutoplay(kind)
if (browserName === 'chromium') for (const kind of kinds) await crossfade(kind)
if (browserName === 'chromium') for (const kind of kinds) await timedCrossfade(kind)
if (fixtures && kinds.includes('mse')) await measure(fixtures)

console.log(`\n${results.length - failed} of ${results.length} checks passed`)
process.exit(failed ? 1 : 0)

/** The engine contract, case by case, with the dev page's tones. */
async function contract(page, kind) {
  const name = text => `${kind}: ${text}`
  // load, paused at a start position
  let result = await page.evaluate(async () => {
    const { engine, events, until, since, source } = window.t
    const mark = events.length
    engine.load({ entryId: 'a1', ...source('a'), startMs: 1000, autoplay: false, gain: 1 })
    const took = await until(() => engine.getStatus().state === 'paused')
    return { took, events: since(mark), status: engine.getStatus() }
  })
  check(name('load emits loading then paused'), JSON.stringify(result.events.map(event => event.status?.state)) === '["loading","paused"]', `${Math.round(result.took)} ms`)
  check(name('load lands at startMs'), Math.abs(result.status.positionMs - 1000) <= 5, `${result.status.positionMs} ms`)

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
  check(name('play emits playing'), result.events.some(event => event.status?.state === 'playing'))
  check(name('position advances with real time'), Math.abs(result.drift) <= 60, `drift ${Math.round(result.drift)} ms over 1 s`)

  // gain, including a boost above unity
  result = await page.evaluate(async () => {
    const { engine, wait, meanLevel } = window.t
    engine.setGain(1); await wait(150); const unity = await meanLevel()
    engine.setGain(2); await wait(150); const boosted = await meanLevel()
    engine.setGain(0.5); await wait(150); const cut = await meanLevel()
    engine.setGain(1)
    return { unity, boosted, cut }
  })
  check(name('output level at unity matches the tone'), Math.abs(result.unity - 0.02 / Math.SQRT2) < 0.004, `rms ${result.unity.toFixed(4)}`)
  check(name('gain 2 boosts'), Math.abs(result.boosted / result.unity - 2) < 0.15, `x${(result.boosted / result.unity).toFixed(2)}`)
  check(name('gain 0.5 cuts'), Math.abs(result.cut / result.unity - 0.5) < 0.08, `x${(result.cut / result.unity).toFixed(2)}`)

  // pause holds the position
  result = await page.evaluate(async () => {
    const { engine, events, level, wait, since } = window.t
    const mark = events.length
    engine.pause()
    const p0 = engine.getStatus().positionMs
    await wait(300)
    return { events: since(mark), moved: engine.getStatus().positionMs - p0, level: level() }
  })
  check(name('pause emits paused and holds position'), result.events.at(-1)?.status?.state === 'paused' && Math.abs(result.moved) <= 1, `moved ${result.moved} ms`)

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
  check(name('seek reports the target at once'), result.reported === 2500)
  check(name('paused seek emits status when it lands'), result.pausedSeek.state === 'paused' && Math.abs(result.pausedSeek.positionMs - 2500) <= 20, `${Math.round(result.landed)} ms, at ${result.pausedSeek.positionMs}`)
  check(name('playing seek keeps playing'), result.playingSeek.state === 'playing' && Math.abs(result.playingSeek.positionMs - 500) <= 30, `at ${result.playingSeek.positionMs}`)

  // natural end with a preload: the preload starts before `ended`, then status for it
  result = await page.evaluate(async () => {
    const { engine, events, wait, until, since, source } = window.t
    engine.load({ entryId: 'a2', ...source('a'), startMs: 3000, autoplay: true, gain: 1 })
    engine.preload({ entryId: 'b1', ...source('b'), gain: 1 })
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
  check(name('ended comes after the preload started'), result.atEnded.entryId === 'b1' && result.atEnded.state === 'playing', JSON.stringify(result.atEnded))
  check(name('ended then status for the preloaded entry'), result.events[0]?.type === 'ended' && result.events[0].entryId === 'a2' && result.events[1]?.status?.entryId === 'b1')
  check(name('gap between entries is small'), result.gap < 120, `${Math.round(result.gap)} ms`)

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
  check(name('ended without a preload stays on the entry'), result.status.state === 'ended' && result.status.entryId === 'b1' && result.events[endedIndex + 1]?.status?.state === 'ended', `at ${result.status.positionMs}`)
  check(name('ended position is the duration'), Math.abs(result.status.positionMs - 3000) <= 30)

  // seek from ended becomes paused
  result = await page.evaluate(async () => {
    const { engine, events, until, since } = window.t
    const mark = events.length
    engine.seek(1000)
    await until(() => since(mark).some(event => event.type === 'status'))
    return engine.getStatus()
  })
  check(name('seek from ended becomes paused'), result.state === 'paused' && Math.abs(result.positionMs - 1000) <= 20)

  // loading the preloaded entry reuses its buffer
  result = await page.evaluate(async () => {
    const { engine, events, wait, until, since, source } = window.t
    engine.preload({ entryId: 'c1', ...source('c'), gain: 1 })
    await wait(500)
    const mark = events.length
    engine.load({ entryId: 'c1', ...source('c'), startMs: 0, autoplay: false, gain: 1 })
    const took = await until(() => engine.getStatus().state === 'paused')
    return { took, events: since(mark), replacedEnded: since(mark).some(event => event.type === 'ended') }
  })
  check(name('loading the preloaded entry is quick'), result.took < 50, `${Math.round(result.took)} ms`)
  check(name('a replaced entry never ends'), !result.replacedEnded)

  // errors
  for (const [label, tone] of [['missing file', 'missing'], ['not audio', 'broken']]) {
    result = await page.evaluate(async arg => {
      const { engine, events, until, since, source } = window.t
      const mark = events.length
      engine.load({ entryId: 'bad', ...source(arg), startMs: 0, autoplay: true, gain: 1 })
      await until(() => engine.getStatus().state === 'error')
      return since(mark)
    }, tone)
    const error = result.find(event => event.type === 'error')
    check(name(`${label} emits error then status error`), !!error && result.at(-1)?.status?.state === 'error', error?.message)
  }

  // after an error, the next load plays
  result = await page.evaluate(async () => {
    const { engine, until, source } = window.t
    engine.load({ entryId: 'a3', ...source('a'), startMs: 0, autoplay: true, gain: 1 })
    await until(() => engine.getStatus().state === 'playing' && engine.getStatus().positionMs > 200)
    engine.pause()
    return engine.getStatus()
  })
  check(name('a load after an error plays'), result.entryId === 'a3' && result.state === 'paused')

  // stop
  result = await page.evaluate(async () => {
    const { engine, events, since } = window.t
    const mark = events.length
    engine.stop()
    return { events: since(mark), status: engine.getStatus() }
  })
  check(name('stop goes idle and emits status'), result.status.entryId === null && result.status.state === 'idle' && result.events.length === 1)
}

/** Base64 channels from the page as Float32Arrays. */
function floats(channels) {
  return channels.map(text => {
    const bytes = Buffer.from(text, 'base64')
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
  })
}

function besselI0(x) {
  let sum = 1, term = 1
  for (let k = 1; k < 40; k += 1) {
    term *= (x / 2) * (x / 2) / (k * k)
    sum += term
  }
  return sum
}

/** The true peak in dBTP, 4x oversampled as BS.1770 measures it, with an interpolator four times as long as the limiter's. */
function truePeakDb(signal) {
  const reach = 32
  const kernels = [0.25, 0.5, 0.75].map(offset => {
    const taps = Array.from({ length: reach * 2 }, (_, index) => {
      const distance = index - (reach - 1) - offset
      const edge = distance / reach
      return Math.sin(Math.PI * distance) / (Math.PI * distance) * besselI0(9 * Math.sqrt(1 - edge * edge))
    })
    const total = taps.reduce((sum, tap) => sum + tap, 0)
    return taps.map(tap => tap / total)
  })
  let peak = 0
  for (const channel of signal) {
    for (let frame = 0; frame < channel.length; frame += 1) {
      peak = Math.max(peak, Math.abs(channel[frame]))
      for (const taps of kernels) {
        let point = 0
        for (let tap = 0; tap < taps.length; tap += 1) point += (channel[frame - reach + tap] ?? 0) * taps[tap]
        peak = Math.max(peak, Math.abs(point))
      }
    }
  }
  return 20 * Math.log10(peak)
}

function channelRms(channel, from, to) {
  let sum = 0
  for (let frame = from; frame < to; frame += 1) sum += channel[frame] * channel[frame]
  return Math.sqrt(sum / (to - from))
}

/**
 * The limiter in the browser's AudioWorklet, on the test values of the iOS engine's (M4): a
 * full-scale tone boosted 12 dB comes out under -1 dBTP, and a signal under the ceiling comes
 * out bit-identical, only later by the limiter's lookahead. Then each equalizer band, at its
 * centre frequency, is within 0.5 dB of its setting.
 */
async function outputChain(page) {
  const render = request => page.evaluate(async request => {
    const { input, output } = await window.squirmyEngine.offline(request)
    return { input, output }
  }, request).then(({ input, output }) => ({ input: floats(input), output: floats(output) }))
  // The limiter's lag: its 1.5 ms lookahead and its interpolator's reach (limiter-worklet.js).
  const delayOf = rate => Math.round(0.0015 * rate) + 7
  for (const rate of [44_100, 48_000]) {
    for (const frequency of [60, 1000, 9000]) {
      const { output } = await render({ signal: { kind: 'tone', frequency }, rate, seconds: 1.5, levelDb: 0, gain: 10 ** (12 / 20) })
      const peak = truePeakDb(output)
      check(`limiter: a full-scale ${frequency} Hz tone boosted 12 dB stays under -1 dBTP (${rate} Hz)`, peak < -1 && peak > -1.5, `${peak.toFixed(2)} dBTP`)
    }
  }
  // A quarter of the sample rate, 45° off the samples: each sample is 3 dB under the wave's own peak.
  const between = await render({ signal: { kind: 'tone', frequency: 11_025, phase: Math.PI / 4 }, rate: 44_100, seconds: 1, levelDb: 0, gain: 10 ** (1 / 20) })
  const caught = truePeakDb(between.output)
  check('limiter: catches the peaks between the samples', caught < -1, `${caught.toFixed(2)} dBTP`)
  for (const [levelDb, gain] of [[-40, 1], [-40, 2], [-1.6, 1]]) {
    const rate = 48_000
    const { input, output } = await render({ signal: { kind: 'sweep' }, rate, seconds: 2, levelDb, gain })
    const delay = delayOf(rate)
    let wrong = 0
    for (let channel = 0; channel < 2; channel += 1) {
      for (let frame = 0; frame < input[channel].length; frame += 1) {
        if (output[channel][delay + frame] !== Math.fround(input[channel][frame] * gain)) wrong += 1
      }
    }
    const silentBefore = output.every(channel => channel.subarray(0, delay).every(sample => sample === 0))
    check(`limiter: a sweep at ${levelDb} dB${gain === 1 ? '' : `, turned up ${(20 * Math.log10(gain)).toFixed(0)} dB,`} passes bit-identical`, wrong === 0 && silentBefore,
      `${wrong} samples differ, ${delay} frames later (${(delay / rate * 1000).toFixed(2)} ms)`)
  }
  const bands = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16_000]
  const responses = []
  for (const [index, frequency] of bands.entries()) {
    const rate = 48_000
    const equalizer = bands.map((_, band) => (band === index ? -6 : 0))
    const plain = await render({ signal: { kind: 'tone', frequency }, rate, seconds: 1, levelDb: -20, gain: 1 })
    const shaped = await render({ signal: { kind: 'tone', frequency }, rate, seconds: 1, levelDb: -20, gain: 1, equalizer })
    // After the filters settle and the 10 ms crossfade into them.
    const from = rate / 2, to = rate - 1024
    responses.push(20 * Math.log10(channelRms(shaped.output[0], from, to) / channelRms(plain.output[0], from, to)))
  }
  const worst = Math.max(...responses.map(response => Math.abs(response + 6)))
  check('equalizer: each band at -6 dB measures within 0.5 dB of it at its centre', worst <= 0.5, responses.map((response, index) => `${bands[index]} Hz ${response.toFixed(2)}`).join(', '))
  const boosted = await render({ signal: { kind: 'tone', frequency: 1000 }, rate: 48_000, seconds: 1, levelDb: -20, gain: 1, equalizer: bands.map(frequency => (frequency === 1000 ? 6 : 0)) })
  const level = 20 * Math.log10(channelRms(boosted.output[0], 24_000, 46_976) / (0.1 / Math.SQRT2))
  check('equalizer: a boost comes with a preamp of minus it', Math.abs(level) <= 0.5, `1 kHz at +6 dB plays at ${level.toFixed(2)} dB`)
}

/**
 * A browser that requires a gesture: play is refused, reported, and recovered by a click.
 * Playwright's evaluate counts as a gesture, so the page starts the tone itself (?autoplay=)
 * and nothing is evaluated until the refusal has happened.
 */
async function blockedAutoplay(kind) {
  const strict = await chromium.launch({ args: ['--autoplay-policy=user-gesture-required'] })
  try {
    const context = await strict.newContext()
    await signIn(context)
    const page = await context.newPage()
    await page.goto(`${base}/dev/engine?engine=${kind}&autoplay=a`)
    const button = page.getByRole('button', { name: 'Enable audio' })
    await page.waitForTimeout(2000)
    check(`${kind}: the shell offers to enable audio`, await button.isVisible())
    await installHelpers(page)
    const result = await page.evaluate(() => {
      const { engine, events } = window.t
      return { error: events.map(({ event }) => event).find(event => event.type === 'error'), state: engine.getStatus().state, blocked: engine.isBlocked() }
    })
    check(`${kind}: a refused play is reported as blocked`, result.blocked && result.state === 'error' && result.error?.message === BLOCKED, result.error?.message)
    await button.click()
    const after = await page.evaluate(async () => {
      const { engine, level, wait, until } = window.t
      await until(() => engine.getStatus().state === 'playing', 3000)
      await wait(300)
      return { state: engine.getStatus().state, level: level(), blocked: engine.isBlocked() }
    })
    check(`${kind}: a click enables audio and plays`, after.state === 'playing' && !after.blocked && after.level > 0.005, `rms ${after.level.toFixed(4)}`)
    check(`${kind}: the notice goes away`, !(await button.isVisible()))
  } finally {
    await strict.close()
  }
}

/** The amplitude of a sine at `frequency` in `frames` frames of the left channel from `from`: a whole number of cycles. */
function amplitudeAt(samples, from, frames, frequency, rate) {
  let re = 0, im = 0
  for (let frame = 0; frame < frames; frame += 1) {
    const angle = 2 * Math.PI * frequency * frame / rate
    const value = samples[2 * (from + frame)] ?? 0
    re += value * Math.cos(angle)
    im -= value * Math.sin(angle)
  }
  return 2 * Math.hypot(re, im) / frames
}

/**
 * A 4 s crossfade between two tones of the same level (880 Hz from 2 s into its 8, then 330
 * Hz), recorded from the graph: the level stays within 0.5 dB through the fade (equal power),
 * the fade takes the setting and ends as the first tone does, and `ended` comes as the second
 * one starts. Muted.
 */
async function crossfade(kind) {
  const browser = await chromium.launch({ args: launchArgs })
  try {
    const { page } = await openEngine(browser, `engine=${kind}&rate=44100&muted=1&crossfade=4`)
    const result = await page.evaluate(async () => {
      const { engine, until, wait, source } = window.t
      engine.warm()
      await until(() => window.squirmyEngine.recorder, 5000)
      const recording = window.squirmyEngine.recorder()
      let atEnded = null
      const off = engine.subscribe(event => { if (event.type === 'ended' && !atEnded) atEnded = engine.getStatus() })
      engine.load({ entryId: 'd1', ...source('d'), startMs: 2000, autoplay: true, gain: 1 })
      engine.preload({ entryId: 'e1', ...source('e'), gain: 1 })
      await until(() => atEnded, 15_000)
      await wait(5000)
      off()
      engine.stop()
      await wait(100)
      return { samples: await recording.stop(), atEnded }
    })
    const samples = channels(result.samples)
    const rate = 44_100, window = 4410, hop = 2205, full = 0.02
    const windows = []
    for (let from = 0; from + window < samples.length / 2; from += hop) {
      windows.push({ at: from / rate, rms: rms(samples, from, null, 0, window), outgoing: amplitudeAt(samples, from, window, 880, rate), incoming: amplitudeAt(samples, from, window, 330, rate) })
    }
    const sounding = windows.filter(({ rms: level }) => level > full / 10)
    // Away from where the first tone starts and the second is stopped.
    const steady = sounding.slice(4, -4)
    const levels = steady.map(({ rms: level }) => 20 * Math.log10(level / (full / Math.SQRT2)))
    // Each tone over -40 dB of its level: 98.7% of an equal-power fade.
    const both = windows.filter(({ outgoing, incoming }) => outgoing > full / 100 && incoming > full / 100)
    const fadeSeconds = both.length ? both.at(-1).at - both[0].at + window / rate : 0
    const start = sounding[0]?.at ?? 0
    const outgoingEnd = windows.filter(({ outgoing }) => outgoing > full / 100).at(-1)?.at ?? 0
    check(`${kind}: a 4 s crossfade keeps the power within 0.5 dB`, levels.length > 100 && Math.max(...levels.map(Math.abs)) <= 0.5,
      `${Math.min(...levels).toFixed(2)} to ${Math.max(...levels).toFixed(2)} dB over ${(steady.length * hop / rate).toFixed(1)} s`)
    check(`${kind}: the fade takes the setting and ends with the first tone`, Math.abs(fadeSeconds - 4) < 0.35 && Math.abs(outgoingEnd + window / rate - start - 6) < 0.3,
      `both tones heard for ${fadeSeconds.toFixed(2)} s, the first ending ${(outgoingEnd + window / rate - start).toFixed(2)} s after it started`)
    check(`${kind}: ended comes as the second tone starts`, result.atEnded?.entryId === 'e1' && result.atEnded.state === 'playing' && result.atEnded.positionMs < 300, JSON.stringify(result.atEnded))
  } finally {
    await browser.close()
  }
}

/**
 * Crossfades placed by the songs' timing (client-core's `crossfadePlan`), recorded from the
 * graph, muted: the same tones, with timing that says the first (from 2 s into its 8) falls
 * silent at 7 s. Without Smart transitions the 4 s fade ends there rather than at 8 s, and the
 * second tone starts past its 1.5 s of "silence"; with them, a 2 s outro sets a 2 s fade.
 */
async function timedCrossfade(kind) {
  const cases = [
    {
      name: 'skips the silence at both ends', smart: false,
      outgoing: { audibleEndMs: 7000 }, incoming: { audibleStartMs: 1500 },
      fade: 4, outgoingEnd: 5, incomingStart: 1500,
    },
    {
      name: 'with Smart transitions, mixes over the outro', smart: true,
      outgoing: { audibleEndMs: 7000, outroStartMs: 5000 }, incoming: { audibleStartMs: 0, introEndMs: 1000 },
      fade: 2, outgoingEnd: 5, incomingStart: 0,
    },
  ]
  for (const one of cases) {
    const browser = await chromium.launch({ args: launchArgs })
    try {
      const { page } = await openEngine(browser, `engine=${kind}&rate=44100&muted=1&crossfade=4${one.smart ? '&smart=1' : ''}`)
      const result = await page.evaluate(async ({ outgoing, incoming }) => {
        const { engine, until, wait, source } = window.t
        const timed = (name, timing) => {
          const found = source(name)
          return { ...found, media: { transcoded: false, ...found.media, timing: { bpm: null, beatOffsetMs: null, audibleStartMs: null, audibleEndMs: null, introEndMs: null, outroStartMs: null, ...timing } } }
        }
        engine.warm()
        await until(() => window.squirmyEngine.recorder, 5000)
        const recording = window.squirmyEngine.recorder()
        let atEnded = null
        const off = engine.subscribe(event => { if (event.type === 'ended' && !atEnded) atEnded = engine.getStatus() })
        engine.load({ entryId: 'd1', ...timed('d', outgoing), startMs: 2000, autoplay: true, gain: 1 })
        engine.preload({ entryId: 'e1', ...timed('e', incoming), gain: 1 })
        await until(() => atEnded, 15_000)
        await wait(5000)
        off()
        engine.stop()
        await wait(100)
        return { samples: await recording.stop(), atEnded }
      }, one)
      const samples = channels(result.samples)
      const rate = 44_100, window = 4410, hop = 2205, full = 0.02
      const windows = []
      for (let from = 0; from + window < samples.length / 2; from += hop) {
        windows.push({ at: from / rate, rms: rms(samples, from, null, 0, window), outgoing: amplitudeAt(samples, from, window, 880, rate), incoming: amplitudeAt(samples, from, window, 330, rate) })
      }
      const start = windows.find(({ rms: level }) => level > full / 10)?.at ?? 0
      const both = windows.filter(({ outgoing, incoming }) => outgoing > full / 100 && incoming > full / 100)
      const fadeSeconds = both.length ? both.at(-1).at - both[0].at + window / rate : 0
      const outgoingEnd = (windows.filter(({ outgoing }) => outgoing > full / 100).at(-1)?.at ?? 0) + window / rate - start
      check(`${kind}: ${one.name}: the fade takes ${one.fade} s and ends as the first tone falls silent`, Math.abs(fadeSeconds - one.fade) < 0.35 && Math.abs(outgoingEnd - one.outgoingEnd) < 0.3,
        `both tones heard for ${fadeSeconds.toFixed(2)} s, the first ending ${outgoingEnd.toFixed(2)} s after it started`)
      check(`${kind}: ${one.name}: the second tone starts at ${one.incomingStart} ms`, result.atEnded?.entryId === 'e1' && result.atEnded.state === 'playing' && Math.abs(result.atEnded.positionMs - one.incomingStart) < 300, JSON.stringify(result.atEnded))
    } finally {
      await browser.close()
    }
  }
}

/** Interleaved 32-bit float stereo, decoded by ffmpeg at `rate`. */
function decode(file, rate) {
  const bytes = execFileSync(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-v', 'error', '-i', file, '-ar', String(rate), '-ac', '2', '-f', 'f32le', '-acodec', 'pcm_f32le', '-'], { maxBuffer: 256 * 1024 * 1024 })
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
}

function channels(recorded) {
  const [left, right] = recorded.map(text => {
    const bytes = Buffer.from(text, 'base64')
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
  })
  const interleaved = new Float32Array(left.length * 2)
  for (let frame = 0; frame < left.length; frame += 1) {
    interleaved[2 * frame] = left[frame]
    interleaved[2 * frame + 1] = right[frame]
  }
  return interleaved
}

/** The shift in [-radius, radius] at which `reference` from `referenceFrame` best matches `actual` from `actualFrame`. */
function align(actual, actualFrame, reference, referenceFrame, radius, length = 2048) {
  let best = { shift: 0, score: -Infinity }
  for (let shift = -radius; shift <= radius; shift += 1) {
    let both = 0, energy = 0, own = 0
    for (let index = 0; index < 2 * length; index += 1) {
      const a = actual[2 * (actualFrame + shift) + index] ?? 0
      const b = reference[2 * referenceFrame + index] ?? 0
      both += a * b
      energy += b * b
      own += a * a
    }
    const score = both / Math.sqrt(energy * own || 1)
    if (score > best.score) best = { shift, score }
  }
  return best
}

/** The first frame louder than the noise floor. */
function onset(samples, from = 0) {
  for (let frame = from; frame < samples.length / 2; frame += 1) {
    if (Math.abs(samples[2 * frame]) > 2e-4 || Math.abs(samples[2 * frame + 1]) > 2e-4) return frame
  }
  return -1
}

function rms(a, aFrom, b, bFrom, frames) {
  let sum = 0
  for (let index = 0; index < 2 * frames; index += 1) {
    const difference = (a[2 * aFrom + index] ?? 0) - (b ? b[2 * bFrom + index] ?? 0 : 0)
    sum += difference * difference
  }
  return Math.sqrt(sum / (2 * frames))
}

/**
 * Where each entry starts in `recording` and how its samples compare with `references` (each
 * entry's own decode, exactly its frames): `wrong` counts those more than `SAME` apart, after
 * the first `settle` frames of each entry. Chromium decodes an entry's first lossy frame from
 * the state its decoder is in (the previous entry's, or none), not from the priming the window
 * cut, so those frames are compared with the uncut `original` instead: `carried` is how far
 * the recording is from it there, and `fresh` how far ffmpeg's decode of that entry alone is.
 */
function boundaries(recording, references, { settle = 0, original = null } = {}) {
  const first = onset(recording)
  if (first < 0) return null
  const start = first + align(recording, first, references[0], 0, 64).shift
  const found = [{ start, gap: 0 }]
  for (let index = 1; index < references.length; index += 1) {
    const expected = found[index - 1].start + references[index - 1].length / 2
    const { shift, score } = align(recording, expected, references[index], 0, 2048)
    found.push({ start: expected + shift, gap: shift, score })
  }
  let position = 0
  return found.map(({ start: at, gap, score }, index) => {
    const reference = references[index]
    const skip = settle
    let wrong = 0, largest = 0
    for (let sample = 2 * skip; sample < reference.length; sample += 1) {
      const difference = Math.abs((recording[2 * at + sample] ?? 0) - reference[sample])
      if (difference > SAME) wrong += 1
      if (difference > largest) largest = difference
    }
    const carried = skip && original ? rms(recording, at, original, position, skip) : null
    const fresh = skip && original ? rms(reference, 0, original, position, skip) : null
    position += reference.length / 2
    return { start: at, gap, score, wrong, largest, carried, fresh }
  })
}

/** Through the server's own streams, recorded: boundaries, seeks and a background tab. */
async function measure(dir) {
  console.log(`\nMseEngine through the server's streams, in ${browserName}`)
  const scratch = mkdtempSync(path.join(tmpdir(), 'squirmy-engine-'))
  const measureBrowser = await browserType.launch({
    args: launchArgs,
    // Playwright turns background throttling off by default; a background tab is checked as a browser runs it.
    ignoreDefaultArgs: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  })
  try {
    const { page, context } = await openEngine(measureBrowser, 'engine=mse&rate=44100&lead=1&behind=1&muted=1')
    await page.evaluate(async () => {
      window.t.engine.warm()
      await window.t.until(() => window.squirmyEngine.recorder, 5000)
    })
    const query = await page.evaluate(() => window.t.engine.playbackQuery())
    const rate = await page.evaluate(() => window.squirmyEngine.sampleRate())
    check('the recorder runs at the streams\' rate', rate === 44100, String(rate))
    const api = async (pathname, params = {}) => {
      const url = new URL(`${base}/api/v1${pathname}`)
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
      const response = await context.request.get(url.href, { headers: HEADERS })
      if (!response.ok()) throw new Error(`${pathname}: ${response.status()} ${await response.text()}`)
      return response.json()
    }
    const albums = (await api('/collection/albums', { sort: 'title', limit: '200' })).items
    const tracksOf = async title => {
      const album = albums.find(candidate => candidate.title === title)
      if (!album) throw new Error(`No album ${title}: run --prepare and scan it`)
      return (await api(`/albums/${album.id}`)).discs.flatMap(disc => disc.tracks)
    }
    /** The descriptor, once the server has measured the file's exact length. */
    const describe = async (track, quality) => {
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const descriptor = await api(`/tracks/${track.id}/playback`, { ...query, quality })
        if (descriptor.gapless) return descriptor
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
      throw new Error(`${track.title} has no exact length yet`)
    }
    /** What the engine is handed, and ffmpeg's decode of the same bytes cut to the real frames. */
    const entry = async (descriptor, id) => {
      const file = path.join(scratch, `${id}.mp4`)
      const response = await context.request.get(`${base}${descriptor.url}`)
      writeFileSync(file, await response.body())
      const { primingFrames, frames, sampleRate } = descriptor.gapless
      const decoded = decode(file, sampleRate)
      // ffmpeg trims an original by its own gapless tags; the fragmented MP4 has none, so its priming is cut here.
      const skip = descriptor.profile === 'original' ? 0 : primingFrames
      return {
        load: { entryId: id, url: descriptor.url, gain: 1, media: { transcoded: descriptor.transcoded, profile: descriptor.profile, mime: descriptor.mime, codec: descriptor.codec, sampleRate: descriptor.sampleRate, durationMs: descriptor.durationMs, gapless: descriptor.gapless } },
        reference: decoded.slice(2 * skip, 2 * (skip + frames)),
      }
    }
    const play = (target, entries, options = {}) => target.evaluate(async ({ loads, busy }) => {
      const { engine, until, wait } = window.t
      engine.stop()
      const recording = window.squirmyEngine.recorder()
      await wait(100)
      let index = 0
      const ended = []
      const off = engine.subscribe(event => {
        if (event.type !== 'ended') return
        ended.push(performance.now())
        index += 1
        if (loads[index + 1]) engine.preload(loads[index + 1])
      })
      // A busy page: every tick of a timer (throttled in the background) holds the main thread for 400 ms.
      let ticks = 0
      const started = performance.now()
      const timer = setInterval(() => {
        ticks += 1
        const until = performance.now() + (busy ? 400 : 0)
        while (performance.now() < until) { /* hold the main thread */ }
      }, 50)
      engine.load({ ...loads[0], startMs: 0, autoplay: true })
      if (loads[1]) engine.preload(loads[1])
      await until(() => engine.getStatus().state === 'ended' || engine.getStatus().state === 'error', 60_000)
      clearInterval(timer)
      off()
      await wait(400)
      const seconds = (performance.now() - started) / 1000
      return { samples: await recording.stop(), ended, ticksPerSecond: ticks / seconds, visibility: document.visibilityState }
    }, { loads: entries.map(item => item.load), busy: options.busy ?? false })

    // How long a lossy decoder's state from before an entry lasts into it: nothing for FLAC; for AAC
    // the overlap of one frame, then traces under -100 dBFS for two more; one frame for MP3.
    const deliveries = [
      ['flac_mp4', 'MSE ALAC', 'original', 0], ['aac_mp4_256', 'MSE ALAC', 'high', 4096],
      ['copy_mp4 (FLAC)', 'MSE FLAC', 'original', 0], ['copy_mp4 (AAC)', 'MSE AAC', 'original', 4096], ['MP3 original', 'MSE MP3', 'original', 1152],
    ]
    for (const [label, album, quality, settle] of deliveries) {
      const tracks = await tracksOf(album)
      const descriptors = await Promise.all(tracks.map(track => describe(track, quality)))
      const entries = await Promise.all(descriptors.map((descriptor, index) => entry(descriptor, `${album}-${quality}-${index}`.replaceAll(' ', '-'))))
      const { samples } = await play(page, entries)
      const recording = channels(samples)
      if (process.env.SQUIRMY_E2E_DUMP) {
        const name = label.replace(/\W+/g, '-')
        writeFileSync(path.join(process.env.SQUIRMY_E2E_DUMP, `${name}.recording.f32`), recording)
        entries.forEach((item, index) => writeFileSync(path.join(process.env.SQUIRMY_E2E_DUMP, `${name}.reference-${index}.f32`), item.reference))
      }
      const original = decode(path.join(dir, 'reference', `${album.split(' ')[1].toLowerCase()}.flac`), 44_100)
      const found = boundaries(recording, entries.map(item => item.reference), { settle, original })
      if (!found) {
        // WebKit plays MSE, but not into Web Audio: its MediaElementAudioSourceNode stays silent.
        check(`${label}: the halves meet`, false, 'nothing recorded: the element\'s output does not reach Web Audio')
        return
      }
      const [, second] = found
      const wrong = found.reduce((sum, part) => sum + part.wrong, 0)
      const largest = Math.max(...found.map(part => part.largest)).toExponential(1)
      const first = settle ? `; first ${settle} frames of each ${found.map(part => dbfs(part.carried)).join(' and ')} from the original, ffmpeg's ${found.map(part => dbfs(part.fresh)).join(' and ')}` : ''
      const detail = `${descriptors[0].profile}, boundary ${second.gap} samples, ${wrong} samples wrong (largest difference ${largest})${first}`
      // Lossy: an entry's first frame is no further from the original than ffmpeg's decode of it (within 1 dB).
      const accurate = !settle || found.every(part => part.carried <= part.fresh * 1.12)
      if (label === 'flac_mp4') {
        check(`${label}: the halves meet at 0 samples with no sample wrong`, second.gap === 0 && wrong === 0, detail)
        // The next song of an album never crossfades.
        const faded = await openEngine(measureBrowser, 'engine=mse&rate=44100&muted=1&crossfade=4')
        await faded.page.evaluate(async () => {
          window.t.engine.warm()
          await window.t.until(() => window.squirmyEngine.recorder, 5000)
        })
        const album = entries.map(item => ({ ...item, load: { ...item.load, continuesAlbum: true } }))
        const [, joined] = boundaries(channels((await play(faded.page, album)).samples), album.map(item => item.reference)) ?? []
        check(`${label}: with crossfade on, an album's halves still meet at 0 samples`, joined?.gap === 0 && joined.wrong === 0, `boundary ${joined?.gap} samples, ${joined?.wrong} wrong`)
        await faded.context.close()
      }
      else if (label === 'aac_mp4_256') check(`${label}: the halves meet at 0 samples, every sample after each first frame as decoded, those frames as accurate`, second.gap === 0 && wrong === 0 && accurate, detail)
      else console.log(`info  ${label}: ${detail}`)
    }

    // Seeks inside and outside the buffer, each recorded from its first sample.
    for (const [label, album, quality] of [['flac_mp4', 'Seek ALAC', 'original'], ['aac_mp4_256', 'Seek ALAC', 'high'], ['copy_mp4', 'Seek FLAC', 'original']]) {
      const [track] = await tracksOf(album)
      const item = await entry(await describe(track, quality), `seek-${album}-${quality}`.replaceAll(' ', '-'))
      await page.evaluate(async load => {
        const { engine, until } = window.t
        engine.stop()
        engine.load({ ...load, startMs: 0, autoplay: false })
        await until(() => engine.getStatus().state === 'paused', 10_000)
      }, item.load)
      for (const [where, positionMs] of [['outside', 3900], ['inside', 4100], ['outside, back', 600], ['inside, back', 700]]) {
        const result = await page.evaluate(async positionMs => {
          const { engine, until, wait, events, since } = window.t
          const before = window.squirmyEngine.inspect().current.fromMs
          const mark = events.length
          engine.seek(positionMs)
          await until(() => since(mark).some(event => event.type === 'status'), 10_000)
          const timeline = window.squirmyEngine.inspect()
          const recording = window.squirmyEngine.recorder()
          await wait(50)
          engine.play()
          await until(() => engine.getStatus().state === 'playing', 10_000)
          await wait(400)
          engine.pause()
          await wait(50)
          return { samples: await recording.stop(), restarted: timeline.current.fromMs !== before }
        }, positionMs)
        const recording = channels(result.samples)
        if (process.env.SQUIRMY_E2E_DUMP) writeFileSync(path.join(process.env.SQUIRMY_E2E_DUMP, `seek-${label}-${positionMs}.recording.f32`.replace(/[^\w.-]+/g, '-')), recording)
        const first = onset(recording)
        const frame = Math.round(positionMs * 44.1)
        const { shift, score } = first < 0 ? { shift: NaN, score: 0 } : align(recording, first + 256, item.reference, frame + 256, 1500)
        const errorMs = -shift / 44.1
        const { restarted } = result
        check(`${label}: a seek ${where} the buffer lands within 10 ms`, Math.abs(errorMs) <= 10 && score > 0.9 && restarted === where.startsWith('outside'),
          `${errorMs.toFixed(2)} ms off, match ${score.toFixed(3)}, stream ${restarted ? 'started again' : 'kept'}`)
      }
    }

    // A background tab through three track changes: the halves twice, each next one preloaded on `ended`.
    const tracks = await tracksOf('MSE ALAC')
    const descriptors = await Promise.all(tracks.map(track => describe(track, 'original')))
    const halves = await Promise.all(descriptors.map((descriptor, index) => entry(descriptor, `background-${index}`)))
    const sequence = [0, 1, 0, 1].map((half, index) => ({ load: { ...halves[half].load, entryId: `background-${index}` }, reference: halves[half].reference }))
    await context.close()
    if (browserName === 'chromium') await background(sequence, play)
  } finally {
    await measureBrowser.close()
    rmSync(scratch, { recursive: true, force: true })
  }

  /**
   * Playwright keeps every page "visible" (it emulates focus), so the tab is made a background
   * one as far as a browser can be told: its window minimized, which throttles its timers in
   * Chromium's full headless mode, and its main thread held for most of the run besides.
   */
  async function background(sequence, play) {
    const hidden = await chromium.launch({
      channel: 'chromium', args: launchArgs,
      ignoreDefaultArgs: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
    })
    try {
      const { page, context } = await openEngine(hidden, 'engine=mse&rate=44100&muted=1')
      await page.evaluate(async () => {
        window.t.engine.warm()
        await window.t.until(() => window.squirmyEngine.recorder, 5000)
      })
      const cdp = await context.newCDPSession(page)
      const { windowId } = await cdp.send('Browser.getWindowForTarget')
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } })
      await page.waitForTimeout(500)
      const { samples, ended, ticksPerSecond } = await play(page, sequence, { busy: true })
      const found = boundaries(channels(samples), sequence.map(item => item.reference))
      const gaps = found?.slice(1).map(part => part.gap) ?? []
      check('a background tab plays three track changes gaplessly', gaps.length === 3 && gaps.every(gap => gap === 0) && found.every(part => part.wrong === 0),
        `boundaries ${gaps.join(', ')} samples, ${found?.reduce((sum, part) => sum + part.wrong, 0)} wrong, ${ended.length} ends reported, a 50 ms timer ran ${ticksPerSecond.toFixed(1)} times a second`)
      await context.close()
    } finally {
      await hidden.close()
    }
  }
}
