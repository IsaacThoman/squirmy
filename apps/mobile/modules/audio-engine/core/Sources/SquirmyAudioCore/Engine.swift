import Foundation

/// The `PlayerEngine` states of `packages/client-core/src/engine.ts`.
enum EngineState: String {
  case idle, loading, playing, paused, buffering, ended, error
}

struct EngineStatus: Equatable {
  var entryId: String?
  var state: EngineState
  var positionMs: Double
  /// Asked to play, and not paused since: true while loading or buffering to play.
  var playing: Bool
}

enum EngineEvent {
  /// The state or entry changed, or a seek landed.
  case status(EngineStatus)
  /// The entry played to its natural end.
  case ended(entryId: String)
  case error(entryId: String, message: String)
  /// The system paused playback: a call, Siri, another app, or the output going away.
  case interrupted(entryId: String)
  /// The interruption of `entryId` is over and the system says to carry on.
  case resumed(entryId: String)
  case log(String)
  /// A stream with a cache key is whole, or was given up. From `StreamStore`, not the engine,
  /// on the same path to JavaScript.
  case cache(CacheReport)
}

/// The audio session, on iOS and tvOS (`AudioSessionController`).
protocol EngineSession: AnyObject {
  /// Before sound: makes the session active. False when the system refuses.
  func activate() -> Bool
  /// With nothing to play.
  func deactivate()
}

struct EngineConfig {
  /// Rendered ahead of the playhead locally (wired, Bluetooth, the speaker) and on AirPlay,
  /// whose receivers buffer.
  var lead = 0.4
  var airPlayLead = 10.0
  /// Decoded beyond what is rendered.
  var decodeAhead = 3.0
  var airPlayDecodeAhead = 12.0
  /// Kept behind the playhead, to render again after an automatic flush.
  var history = 2.0
  var airPlayHistory = 12.0
  /// The clock stops below this lead when nothing more is decoded, and starts again with
  /// this much decoded ahead (or the stream's end).
  var underrun = 0.06
  var resumeAfter = 1.0
  /// Silence kept ahead while an entry loads, so the session stays active without delaying
  /// the first sample by more than this.
  var silenceLead = 0.06
  /// A start that is not gapless (a load, a seek) fades in over this, so it does not click.
  var fadeIn = 0.005
  /// Gain changes ramp over this.
  var gainRamp = 0.01
  /// The fade over everything (the sleep timer's) moves over this from one level to the next,
  /// so steps a few times a second make one smooth fade.
  var fadeRamp = 0.25
  /// A crossfade shorter than this, as when the next entry arrives at the last moment, is
  /// not worth it: the entries meet gapless instead.
  var shortestCrossfade = 0.1
  var tick = 0.02
  /// Frames per buffer handed to the output.
  var chunkFrames = 2048
  /// Tests drive `tick` themselves.
  var manualTicks = false
}

/// One entry in the engine, the loaded one or the preloaded one.
private final class Slot {
  let pipeline: Pipeline
  var gain: Float
  /// The gain last applied, which a change ramps from.
  var heardGain: Float
  /// The item frame that goes to the output next.
  var nextFrame: Int64 = 0
  /// Frames of fade-in still to apply, of `fadeLength`.
  var fadeLeft = 0
  var fadeLength = 0
  /// It continues the album of the entry before it: never crossfaded into.
  var albumRun: Bool

  init(pipeline: Pipeline, gain: Float) {
    self.pipeline = pipeline
    self.gain = gain
    heardGain = gain
    albumRun = pipeline.item.albumRun
  }

  var entryId: String { pipeline.item.entryId }
}

/// Where the chain's state was before a run of frames was queued, to carry on from when
/// rendering again part way.
private struct Mark {
  let frame: Int64
  let limiterGain: Float
  let equalizer: Equalizer
  let fade: Float
}

/// A run of queued output: timeline frames `start..<end` play `slot` from `itemStart`, or
/// silence without a slot. During a crossfade `slot` is the incoming entry and `mix` the
/// outgoing one, from its frame `mixStart`.
private struct Segment {
  let start: Int64
  var end: Int64
  let slot: Slot?
  let itemStart: Int64
  var mix: Slot? = nil
  var mixStart: Int64 = 0
}

/**
 * A crossfade: `to` starts at timeline frame `start`, under the last `length` frames of
 * `from` (its frames from `fromStart` to its end). Equal power: `from` goes down along a
 * cosine as `to` comes up along a sine, so two unrelated songs keep their loudness together.
 * It lasts until the playhead has passed its end, so it can be rendered again from anywhere
 * in it.
 */
private final class Crossfade {
  let from: Slot
  let to: Slot
  let start: Int64
  let fromStart: Int64
  let length: Int64

  init(from: Slot, to: Slot, start: Int64, fromStart: Int64, length: Int64) {
    self.from = from
    self.to = to
    self.start = start
    self.fromStart = fromStart
    self.length = length
  }

  var end: Int64 { start + length }
  /// Frames of it still to queue.
  var left: Int64 { length - (from.nextFrame - fromStart) }
  var isQueued: Bool { left <= 0 }

  /// How loud each side is `frame` frames into it.
  func levels(at frame: Int64) -> (from: Float, to: Float) {
    let angle = (Double(frame) + 0.5) / Double(length) * Double.pi / 2
    return (Float(cos(angle)), Float(sin(angle)))
  }
}

/// What to queue next: frames of one entry, or of two in a crossfade.
private enum Run {
  case solo(Slot, count: Int)
  case mix(Crossfade, count: Int)
}

/// Frames about to be queued, at their entries' gains, and whose they are.
private struct Chunk {
  var samples: [Float]
  let slot: Slot
  let itemStart: Int64
  var mix: Slot? = nil
  var mixStart: Int64 = 0
  /// It goes through the limiter whatever the equalizer does: a gain other than 1, or a crossfade.
  let limited: Bool
}

/**
 * The engine: at most two entries, the loaded one and the one that follows, on one sample
 * clock. Each entry's first real sample goes right after the previous one's last, so
 * consecutive tracks are gapless to the sample whenever their decoders trim exactly. With a
 * crossfade set, the next entry starts that long before the loaded one ends instead, the two
 * mixed into one stream, unless it continues the loaded one's album (`albumRun`).
 *
 * Everything runs on `queue`, the feed queue, which never waits for bytes: it takes decoded
 * PCM from each entry's `Pipeline` and keeps the output a short lead ahead of the playhead
 * (`tick`, every 20 ms). Commands arrive on any thread and are queued there; `status()` reads
 * the clock at once. It follows the `PlayerEngine` contract in client-core: it never plays,
 * pauses or seeks on its own, apart from moving to the preloaded entry at a natural end, and
 * the system's pauses come out as `interrupted` for the app to turn into session commands.
 */
final class Engine {
  let queue: DispatchQueue
  var listener: ((EngineEvent) -> Void)?
  var session: EngineSession?

  private let output: AudioOutput
  private let factory: SourceFactory
  private let config: EngineConfig
  private var timer: DispatchSourceTimer?

  private var current: Slot?
  private var next: Slot?
  private var state: EngineState = .idle
  private var wantsPlay = false
  private var holding = false
  private var interruptedEntryId: String?
  private var systemInterrupted = false
  private var airPlay = false

  /// The next timeline frame to queue, and what is queued.
  private var enqueued: Int64 = 0
  private var segments: [Segment] = []
  /// Between the entries' gain and the limiter, for everything queued.
  private var equalizer: Equalizer
  /// The end of the chain: every entry not at unity gain, and everything the equalizer
  /// changes, plays through it.
  private var limiter: Limiter
  private var marks: [Mark] = []
  /// How long a crossfade between entries lasts; 0 for none.
  private var crossfadeSeconds = 0.0
  /// The crossfade queued or playing, from the loaded entry into the next or, once the next
  /// is heard, from the one before into the loaded one.
  private var crossfade: Crossfade?
  /// A level over everything queued, the sleep timer's fade, and the level last applied.
  private var fadeLevel: Float = 1
  private var heardFade: Float = 1
  /// The item frame shown while none of the loaded entry has played since a load or seek.
  private var anchor: Int64 = 0
  /// A seek waits for its first frames.
  private var seeking = false
  private var buffering = false
  private var rebuilds = 0

  init(output: AudioOutput, factory: SourceFactory, config: EngineConfig = EngineConfig(), queue: DispatchQueue = DispatchQueue(label: "squirmy.audio.feed", qos: .userInteractive)) {
    self.output = output
    self.factory = factory
    self.config = config
    self.queue = queue
    limiter = Limiter(sampleRate: output.sampleRate)
    equalizer = Equalizer(sampleRate: output.sampleRate)
    output.onEvent = { [weak self] event in self?.outputEvent(event) }
  }

  // MARK: - Commands, from any thread

  func load(_ item: EngineItem, autoplay: Bool) { queue.async { self.doLoad(item, autoplay: autoplay) } }
  func preload(_ item: EngineItem?) { queue.async { self.doPreload(item) } }
  func play() { queue.async { self.doPlay() } }
  func pause() { queue.async { self.doPause() } }
  func seek(toMs positionMs: Double) { queue.async { self.doSeek(positionMs) } }
  func setGain(_ gain: Float) { queue.async { self.current?.gain = gain } }
  func stop() { queue.async { self.doStop() } }
  func holdAudioSession(_ hold: Bool) { queue.async { self.doHold(hold) } }
  /// The equalizer's curve, or `nil` for none. Heard after the lead, crossfaded over 10 ms.
  func setEqualizer(_ curve: EqualizerCurve?) { queue.async { self.equalizer.set(curve) } }
  /// How long the next entry overlaps the loaded one's end, in seconds; 0 for none. For the
  /// crossfades not queued yet.
  func setCrossfade(seconds: Double) { queue.async { self.crossfadeSeconds = max(0, seconds) } }
  /// A level from 0 to 1 over everything that plays, whichever entries those are: the sleep
  /// timer's fade. Heard after the lead.
  func setFade(_ level: Float) { queue.async { self.fadeLevel = min(1, max(0, level)) } }

  /// The status now, with the position read from the clock.
  func status() -> EngineStatus {
    queue.sync { makeStatus() }
  }

  // MARK: - The system, from any thread

  func interruptionBegan() { queue.async { self.doInterruptionBegan() } }
  func interruptionEnded(shouldResume: Bool) { queue.async { self.doInterruptionEnded(shouldResume) } }
  /// The output went away (headphones unplugged): paused for good, as in every iOS player.
  func outputLost() { queue.async { self.doOutputLost() } }
  /// The route changed. AirPlay receivers buffer, so the engine renders further ahead there.
  func routeChanged(airPlay: Bool, sampleRate: Double) {
    queue.async {
      if airPlay != self.airPlay {
        self.airPlay = airPlay
        self.log("lead \(airPlay ? self.config.airPlayLead : self.config.lead) s (\(airPlay ? "AirPlay" : "local"))")
      }
      self.changeRate(to: sampleRate)
      self.tick()
    }
  }
  /// The media services were reset: a new output, carrying on where it was.
  func mediaServicesReset() {
    queue.async {
      self.log("media services reset")
      self.rebuildOutput()
    }
  }

  /// For tests: runs one feed step now.
  func tickNow() { queue.sync { tick() } }

  /// For tests: waits for every decoder to catch up with what the feed loop wants.
  func settle() {
    let pipelines = queue.sync { [current, next].compactMap { $0?.pipeline } }
    pipelines.forEach { $0.settle() }
  }

  // MARK: - Command handling, on the queue

  private func doLoad(_ item: EngineItem, autoplay: Bool) {
    advance()
    let previous = current
    let slot: Slot
    if let next, next.entryId == item.entryId, next.pipeline.item.url == item.url {
      slot = next
      self.next = nil
    } else {
      slot = makeSlot(item)
    }
    slot.gain = item.gain
    slot.heardGain = item.gain
    restart()
    if previous !== slot { previous?.pipeline.release() }
    current = slot
    interruptedEntryId = nil
    if autoplay { systemInterrupted = false }
    let start = frames(ms: max(0, item.startMs))
    startAt(start)
    wantsPlay = autoplay
    buffering = false
    seeking = false
    log("\(item.entryId) load at \(Int(item.startMs)) ms (\(item.decoder.rawValue))\(autoplay ? ", playing" : "")")
    setState(.loading, always: true)
    resumeTicking()
    tick()
  }

  private func doPreload(_ item: EngineItem?) {
    advance()
    if let item, let next, next.entryId == item.entryId, next.pipeline.item.url == item.url {
      next.gain = item.gain
      next.heardGain = item.gain
      if next.albumRun != item.albumRun {
        next.albumRun = item.albumRun
        // A crossfade into it, or a gapless start that should now be one, is queued already.
        if segments.contains(where: { $0.slot === next }) { renderAgain(from: Int64(output.currentFrame()), flushed: false) }
      }
      return
    }
    let old = next
    next = item.map(makeSlot)
    if let old {
      if crossfade?.to === old { crossfade = nil }
      old.pipeline.release()
      // Its start is queued already: what follows the loaded entry has to be rendered again.
      if segments.contains(where: { $0.slot === old }) {
        renderAgain(from: Int64(output.currentFrame()), flushed: false)
      }
    }
    tick()
  }

  private func doPlay() {
    advance()
    guard current != nil, state != .error, state != .loading, state != .playing, state != .buffering else { return }
    interruptedEntryId = nil
    // The system may never say an interruption ended (another app kept the audio); the
    // user's play is the end of it.
    systemInterrupted = false
    if state == .ended {
      // Playing an entry that ended starts it over, as a player's play button does.
      restart()
      startAt(0)
      seeking = true
    }
    wantsPlay = true
    setState(.playing)
    resumeTicking()
    tick()
  }

  private func doPause() {
    advance()
    guard current != nil else { return }
    wantsPlay = false
    interruptedEntryId = nil
    buffering = false
    if state == .playing || state == .buffering || state == .ended { setState(.paused) }
    tick()
  }

  private func doSeek(_ positionMs: Double) {
    advance()
    guard let current, state != .error else { return }
    var target = max(0, frames(ms: positionMs))
    if let length = current.pipeline.lengthFrames.frames { target = min(target, length) }
    if state == .loading {
      // Still loading: start there instead. The status that ends loading reports it.
      restart()
      startAt(target)
      tick()
      return
    }
    // Reported with the status of the seek landing: at once when the frames are decoded
    // already, otherwise when they arrive.
    if state == .ended {
      wantsPlay = false
      state = .paused
    } else if state == .buffering {
      state = .playing
    }
    buffering = false
    restart()
    startAt(target)
    seeking = true
    tick()
  }

  private func doStop() {
    current?.pipeline.release()
    next?.pipeline.release()
    current = nil
    next = nil
    wantsPlay = false
    buffering = false
    seeking = false
    interruptedEntryId = nil
    restart()
    setState(.idle, always: true)
    if !holding { session?.deactivate() }
    tick()
  }

  private func doHold(_ hold: Bool) {
    guard hold != holding else { return }
    holding = hold
    log(hold ? "holding the audio session" : "audio session released")
    if current == nil {
      restart()
      if !hold { session?.deactivate() }
    }
    resumeTicking()
    tick()
  }

  private func doInterruptionBegan() {
    advance()
    systemInterrupted = true
    log("interrupted")
    guard let current, wantsPlay else { return tick() }
    interruptedEntryId = current.entryId
    systemPause(current)
  }

  private func doInterruptionEnded(_ shouldResume: Bool) {
    systemInterrupted = false
    let entryId = interruptedEntryId
    interruptedEntryId = nil
    log("interruption ended\(shouldResume ? ", should resume" : "")")
    if let entryId, shouldResume, current?.entryId == entryId { emit(.resumed(entryId: entryId)) }
    tick()
  }

  private func doOutputLost() {
    advance()
    interruptedEntryId = nil
    log("output lost")
    guard let current, wantsPlay else { return }
    systemPause(current)
  }

  private func systemPause(_ slot: Slot) {
    wantsPlay = false
    buffering = false
    if state == .playing || state == .buffering { setState(.paused) }
    tick()
    emit(.interrupted(entryId: slot.entryId))
  }

  // MARK: - The feed loop

  private func tick() {
    if let failure = output.failure {
      log("output failed: \(failure); rebuilding it")
      rebuilds += 1
      if rebuilds > 3, let current {
        // A renderer that fails again at once will not be fixed by another.
        fail(current, EngineError.wrapping(failure))
        return
      }
      return rebuildOutput()
    }
    advance()
    checkFailures()
    checkUnderrun()
    fill()
    runClock()
    requestDecoding()
    forgetHistory()
    if current == nil && next == nil && !holding { stopTicking() }
  }

  /// Crosses into the preloaded entry once its first frame plays, and ends an entry with
  /// nothing after it once its last frame has.
  private func advance() {
    let playhead = Int64(output.currentFrame())
    if let current, let next, let first = segments.first(where: { $0.slot === next }), playhead >= first.start {
      self.current = next
      self.next = nil
      anchor = 0
      // Fading out under the next one, it plays on until its last frame.
      if crossfade?.from !== current { current.pipeline.release() }
      segments.removeAll { $0.slot === current }
      log("\(current.entryId) ended; \(next.entryId) playing")
      state = .playing
      emit(.ended(entryId: current.entryId))
      emit(.status(makeStatus()))
    }
    if let fade = crossfade, fade.from !== self.current, fade.isQueued, playhead >= fade.end {
      crossfade = nil
      fade.from.pipeline.release()
    }
    guard let current, wantsPlay, state == .playing, !seeking, next == nil || next!.nextFrame == 0 else { return }
    let decoded = current.pipeline.decoded
    if decoded.ended, current.nextFrame >= decoded.end, next == nil, playhead >= enqueued {
      wantsPlay = false
      output.setRate(0, at: enqueued)
      log("\(current.entryId) ended")
      state = .ended
      emit(.ended(entryId: current.entryId))
      emit(.status(makeStatus()))
    }
  }

  private func checkFailures() {
    if let next, let error = next.pipeline.error, next.nextFrame == 0 {
      // A preload that fails is dropped without a word; the entry loads normally later.
      log("preload \(next.entryId) dropped: \(error.message)")
      next.pipeline.release()
      self.next = nil
    }
    guard let current, state != .error, let error = current.pipeline.error else { return }
    // What was decoded before the failure plays out first.
    let playhead = Int64(output.currentFrame())
    guard current.nextFrame >= current.pipeline.decoded.end, state != .playing || playhead >= enqueued else { return }
    fail(current, error)
  }

  private func fail(_ slot: Slot, _ error: EngineError) {
    wantsPlay = false
    buffering = false
    seeking = false
    restart()
    state = .error
    log("\(slot.entryId) failed: \(error.message)")
    emit(.error(entryId: slot.entryId, message: error.message))
    emit(.status(makeStatus()))
  }

  private func checkUnderrun() {
    guard let current else { return }
    let playhead = Int64(output.currentFrame())
    if buffering {
      let feeding: Slot?
      if let fade = crossfade, !fade.isQueued {
        // The outgoing entry is decoded to its end: only the incoming one can hold a crossfade up.
        feeding = fade.to
      } else {
        feeding = current.nextFrame >= current.pipeline.decoded.end && current.pipeline.decoded.ended ? next : current
      }
      let ahead = feeding.map { $0.pipeline.decoded.end - $0.nextFrame } ?? 0
      let done = feeding == nil || feeding!.pipeline.decoded.ended || feeding!.pipeline.error != nil
      if ahead >= frames(seconds: config.resumeAfter) || done {
        buffering = false
        log("\(current.entryId) buffered, playing on at \(Int(makeStatus().positionMs)) ms")
        setState(.playing)
      }
      return
    }
    guard wantsPlay, state == .playing, !seeking, output.rate > 0 else { return }
    let atEnd = current.pipeline.decoded.ended && current.nextFrame >= current.pipeline.decoded.end && next == nil
    if enqueued - playhead < frames(seconds: config.underrun), !atEnd, nextRun(planning: false) == nil {
      // The renderer's clock runs on when it runs dry, which would skip what comes next.
      output.setRate(0, at: playhead)
      buffering = true
      log("\(current.entryId) buffering at \(Int(makeStatus().positionMs)) ms")
      setState(.buffering)
    }
  }

  /// Keeps the output `lead` ahead: the entries' frames, silence while one loads (so the
  /// session stays active and iOS keeps the app running), or silence alone while the app
  /// holds the session with nothing loaded.
  private func fill() {
    let playhead = Int64(output.currentFrame())
    let lead = frames(seconds: airPlay ? config.airPlayLead : config.lead)
    let silenceLead = frames(seconds: config.silenceLead)
    if seeking, let current, current.pipeline.decoded.ended, current.nextFrame >= current.pipeline.decoded.end {
      // Sought to the very end.
      seeking = false
      emit(.status(makeStatus()))
    }
    while enqueued < playhead + lead, output.isReadyForMoreMediaData {
      if let chunk = takeChunk() {
        enqueue(chunk)
        continue
      }
      let waitingToSound = current != nil && wantsPlay && current!.pipeline.error == nil && (state == .loading || seeking)
      let holdingOnly = current == nil && holding
      guard (waitingToSound || holdingOnly) && !systemInterrupted && enqueued < playhead + silenceLead else { break }
      let count = config.chunkFrames / 4
      limiter.reset()
      equalizer.reset()
      marks.append(Mark(frame: enqueued, limiterGain: 1, equalizer: equalizer, fade: heardFade))
      output.enqueue([Float](repeating: 0, count: count * 2)[...], at: enqueued)
      append(Segment(start: enqueued, end: enqueued + Int64(count), slot: nil, itemStart: 0))
      enqueued += Int64(count)
    }
  }

  /// What to queue next: the loaded entry's frames, then the preloaded one's once the loaded
  /// one is decoded to its end and queued, or the two mixed in a crossfade. `planning` starts
  /// the crossfade when its time has come; without it, this only looks.
  private func nextRun(planning: Bool) -> Run? {
    let most = config.chunkFrames
    if let fade = crossfade, !fade.isQueued {
      let to = fade.to.pipeline.decoded
      let incoming = Int(to.end - fade.to.nextFrame)
      // An incoming entry shorter than the fade (or failing in it) is silent for the rest.
      let finished = (to.ended || fade.to.pipeline.error != nil) && incoming <= 0
      let count = min(most, Int(fade.left), finished ? most : incoming)
      return count > 0 ? .mix(fade, count: count) : nil
    }
    guard let current else { return nil }
    let decoded = current.pipeline.decoded
    if current.nextFrame < decoded.end {
      guard let start = crossfadeStart(current) else { return .solo(current, count: most) }
      if current.nextFrame < start { return .solo(current, count: min(most, Int(start - current.nextFrame))) }
      // Its time has come, or passed while the next entry was not decoded yet: a shorter one.
      // Until the next one has frames, the loaded one plays on alone.
      if planning, let next, let fade = beginCrossfade(from: current, into: next) {
        return .mix(fade, count: min(most, Int(fade.left), Int(next.pipeline.decoded.end - next.nextFrame)))
      }
      return .solo(current, count: most)
    }
    guard decoded.ended, !seeking, let next, next.pipeline.error == nil, next.nextFrame < next.pipeline.decoded.end else { return nil }
    return .solo(next, count: most)
  }

  /// The loaded entry's frame where a crossfade into the preloaded one begins, or nil when
  /// they meet gapless: no crossfade set, the next one continuing the album, or the loaded
  /// one's end not known yet (decoding runs further ahead while a crossfade is set).
  private func crossfadeStart(_ slot: Slot) -> Int64? {
    guard crossfadeSeconds > 0, crossfade == nil, let next, !next.albumRun, next.nextFrame == 0, next.pipeline.error == nil else { return nil }
    let decoded = slot.pipeline.decoded
    guard decoded.ended else { return nil }
    // Never more than half of either entry, so a short one is not all fade.
    var length = min(frames(seconds: crossfadeSeconds), decoded.end / 2)
    if let incoming = next.pipeline.lengthFrames.frames { length = min(length, incoming / 2) }
    guard length >= frames(seconds: config.shortestCrossfade) else { return nil }
    return decoded.end - length
  }

  /// Starts a crossfade from `current`'s next frame to its end, if that is long enough and
  /// `next` has frames to mix in.
  private func beginCrossfade(from current: Slot, into next: Slot) -> Crossfade? {
    let length = current.pipeline.decoded.end - current.nextFrame
    guard length >= frames(seconds: config.shortestCrossfade), next.nextFrame < next.pipeline.decoded.end else { return nil }
    let fade = Crossfade(from: current, to: next, start: enqueued, fromStart: current.nextFrame, length: length)
    log("crossfading \(current.entryId) into \(next.entryId) over \(Int(Double(length) / output.sampleRate * 1000)) ms")
    crossfade = fade
    return fade
  }

  private func takeChunk() -> Chunk? {
    switch nextRun(planning: true) {
    case nil:
      return nil
    case .solo(let slot, let count):
      let samples = Array(slot.pipeline.copy(from: slot.nextFrame, count: count))
      guard !samples.isEmpty else { return nil }
      // At unity gain (normalization off) and with no equalizer, an entry plays as the file
      // is; any other gain, a boost above all, goes through the limiter.
      var chunk = Chunk(samples: samples, slot: slot, itemStart: slot.nextFrame, limited: slot.gain != 1 || slot.heardGain != 1)
      shape(&chunk.samples, slot)
      slot.nextFrame += Int64(samples.count / 2)
      return chunk
    case .mix(let fade, let count):
      return mix(fade, count: count)
    }
  }

  /// `count` frames of a crossfade, each entry at its own gain along its curve. The sum of
  /// two songs can go over where neither does, so it always goes through the limiter.
  private func mix(_ fade: Crossfade, count: Int) -> Chunk {
    let offset = fade.from.nextFrame - fade.fromStart
    var outgoing = Array(fade.from.pipeline.copy(from: fade.from.nextFrame, count: count))
    var incoming = Array(fade.to.pipeline.copy(from: fade.to.nextFrame, count: count))
    let heard = incoming.count / 2
    shape(&outgoing, fade.from)
    if heard > 0 { shape(&incoming, fade.to) }
    var samples = [Float](repeating: 0, count: count * 2)
    for frame in 0..<count {
      let (down, up) = fade.levels(at: offset + Int64(frame))
      for side in 0..<2 {
        let index = frame * 2 + side
        let a = index < outgoing.count ? outgoing[index] * down : 0
        let b = index < incoming.count ? incoming[index] * up : 0
        samples[index] = a + b
      }
    }
    let chunk = Chunk(samples: samples, slot: fade.to, itemStart: fade.to.nextFrame, mix: fade.from, mixStart: fade.from.nextFrame, limited: true)
    fade.from.nextFrame += Int64(count)
    fade.to.nextFrame += Int64(heard)
    return chunk
  }

  private func enqueue(_ chunk: Chunk) {
    var samples = chunk.samples
    let count = samples.count / 2
    let limited = chunk.limited || equalizer.isActive
    marks.append(Mark(frame: enqueued, limiterGain: limiter.gain, equalizer: equalizer, fade: heardFade))
    applyFade(&samples)
    equalizer.process(&samples)
    if limited {
      limiter.process(&samples, ahead: upcoming(limiter.aheadFrames)[...])
    } else {
      limiter.pass(samples[...])
    }
    output.enqueue(samples[...], at: enqueued)
    append(Segment(start: enqueued, end: enqueued + Int64(count), slot: chunk.slot, itemStart: chunk.itemStart, mix: chunk.mix, mixStart: chunk.mixStart))
    enqueued += Int64(count)
    // The loaded entry's first frames since a load or seek, alone or fading out.
    guard chunk.slot === current || chunk.mix === current, let current else { return }
    if state == .loading {
      log("\(current.entryId) \(wantsPlay ? "playing" : "ready") at \(Int(Double(anchor) / output.sampleRate * 1000)) ms")
      setState(wantsPlay ? .playing : .paused)
    } else if seeking {
      seeking = false
      emit(.status(makeStatus()))
    }
  }

  /// The fade over everything, moving to a new level over `fadeRamp`.
  private func applyFade(_ samples: inout [Float]) {
    guard fadeLevel != 1 || heardFade != 1 else { return }
    let count = samples.count / 2
    let step = 1 / Float(max(1, frames(seconds: config.fadeRamp)))
    var level = heardFade
    for frame in 0..<count {
      if level != fadeLevel { level = level < fadeLevel ? min(fadeLevel, level + step) : max(fadeLevel, level - step) }
      samples[frame * 2] *= level
      samples[frame * 2 + 1] *= level
    }
    heardFade = level
  }

  /// The entry's gain, ramped from the last one, and a start's fade-in.
  private func shape(_ samples: inout [Float], _ slot: Slot) {
    let count = samples.count / 2
    if slot.heardGain != slot.gain {
      let ramp = max(1, min(count, Int(frames(seconds: config.gainRamp))))
      let from = slot.heardGain
      let step = (slot.gain - from) / Float(ramp)
      for frame in 0..<count {
        let gain = frame < ramp ? from + step * Float(frame + 1) : slot.gain
        samples[frame * 2] *= gain
        samples[frame * 2 + 1] *= gain
      }
      slot.heardGain = slot.gain
    } else if slot.gain != 1 {
      for index in samples.indices { samples[index] *= slot.gain }
    }
    if slot.fadeLeft > 0 {
      let faded = min(count, slot.fadeLeft)
      for frame in 0..<faded {
        let level = Float(slot.fadeLength - slot.fadeLeft + frame) / Float(slot.fadeLength)
        samples[frame * 2] *= level
        samples[frame * 2 + 1] *= level
      }
      slot.fadeLeft -= faded
    }
  }

  /// Up to `count` frames that are queued after what was just taken, at their entries' gains
  /// and through the equalizer: what the limiter looks ahead into. Short where decoding has
  /// not got that far.
  private func upcoming(_ count: Int) -> [Float] {
    var frames: [Float]
    if let fade = crossfade, !fade.isQueued {
      // The rest of a crossfade, mixed along its curves.
      let outgoing = scaled(fade.from.pipeline.copy(from: fade.from.nextFrame, count: count), fade.from)
      let incoming = scaled(fade.to.pipeline.copy(from: fade.to.nextFrame, count: count), fade.to)
      let offset = fade.from.nextFrame - fade.fromStart
      frames = (0..<min(count, Int(fade.left))).flatMap { frame -> [Float] in
        let (down, up) = fade.levels(at: offset + Int64(frame))
        return (0..<2).map { side in
          let index = frame * 2 + side
          return (index < outgoing.count ? outgoing[index] * down : 0) + (index < incoming.count ? incoming[index] * up : 0)
        }
      }
    } else {
      guard let current else { return [] }
      frames = scaled(current.pipeline.copy(from: current.nextFrame, count: count), current)
      let decoded = current.pipeline.decoded
      let short = count - frames.count / 2
      if short > 0, decoded.ended, current.nextFrame + Int64(frames.count / 2) >= decoded.end, !seeking, let next, next.pipeline.error == nil {
        frames += scaled(next.pipeline.copy(from: next.nextFrame, count: short), next)
      }
    }
    // At the louder of the fade's two levels, as `scaled` does for gains.
    let fade = max(fadeLevel, heardFade)
    if fade != 1 { frames = frames.map { $0 * fade } }
    // Through a copy, which leaves the equalizer where the frames just taken left it.
    var ahead = equalizer
    ahead.process(&frames)
    return frames
  }

  /// `samples` at the slot's gain, or at the one it ramps from when that is larger, so the
  /// limiter turns down at least as far as it will have to.
  private func scaled(_ samples: ArraySlice<Float>, _ slot: Slot) -> [Float] {
    let gain = max(slot.gain, slot.heardGain)
    return gain == 1 ? Array(samples) : samples.map { $0 * gain }
  }

  private func append(_ segment: Segment) {
    if var last = segments.last, last.slot === segment.slot, last.end == segment.start, last.mix === segment.mix,
       segment.slot == nil || last.itemStart + (last.end - last.start) == segment.itemStart,
       segment.mix == nil || last.mixStart + (last.end - last.start) == segment.mixStart {
      last.end = segment.end
      segments[segments.count - 1] = last
    } else {
      segments.append(segment)
    }
  }

  /// Runs the clock while there is something to hear (or the silence of a held session),
  /// and stops it otherwise.
  private func runClock() {
    let playhead = Int64(output.currentFrame())
    let sounding = current != nil && wantsPlay && !buffering && (state == .playing || state == .loading)
    let shouldRun = !systemInterrupted && (sounding || (current == nil && holding))
    if shouldRun, output.rate == 0, enqueued > playhead {
      guard session?.activate() ?? true else { return }
      output.setRate(1, at: playhead)
      rebuilds = 0
    } else if !shouldRun, output.rate != 0 {
      output.setRate(0, at: playhead)
    }
  }

  private func requestDecoding() {
    let ahead = frames(seconds: airPlay ? config.airPlayDecodeAhead : config.decodeAhead)
    // A crossfade starts that long before the loaded entry's end, which has to be known by then.
    let fade = crossfadeSeconds > 0 ? frames(seconds: crossfadeSeconds) : 0
    if let current { current.pipeline.want(current.nextFrame + ahead + fade) }
    if let next { next.pipeline.want(next.nextFrame + ahead) }
  }

  private func forgetHistory() {
    guard let current else { return }
    let keep = frames(seconds: (airPlay ? config.airPlayHistory + config.airPlayLead : config.history + config.lead))
    current.pipeline.forget(before: current.nextFrame - keep)
    let playhead = Int64(output.currentFrame())
    segments.removeAll { $0.end < playhead - keep }
    marks.removeAll { $0.frame < playhead - keep }
  }

  // MARK: - Rendering again

  /// Stops the clock where it is and throws away everything queued, for a new start.
  private func restart() {
    let playhead = Int64(output.currentFrame())
    output.setRate(0, at: playhead)
    output.flush()
    enqueued = playhead
    segments.removeAll()
    limiter.reset()
    equalizer.reset()
    marks.removeAll()
    dropCrossfade()
    next?.nextFrame = 0
  }

  /// Forgets the crossfade, letting go of an outgoing entry that is no longer loaded.
  private func dropCrossfade() {
    guard let fade = crossfade else { return }
    crossfade = nil
    if fade.from !== current && fade.from !== next { fade.from.pipeline.release() }
  }

  /// The loaded entry starts at `frame`, from a fade-in.
  private func startAt(_ frame: Int64) {
    guard let current else { return }
    anchor = frame
    current.nextFrame = frame
    current.fadeLength = max(1, Int(frames(seconds: config.fadeIn)))
    current.fadeLeft = Int(frames(seconds: config.fadeIn))
    if !current.pipeline.holds(frame) { current.pipeline.seek(to: frame) }
  }

  /// A new output after the media services were reset or the renderer failed, carrying on
  /// from what was heard.
  private func rebuildOutput() {
    let playhead = Int64(output.currentFrame())
    output.rebuild()
    output.setRate(0, at: playhead)
    renderAgain(from: playhead, flushed: true)
  }

  /// Queues again from timeline frame `from`: after the output threw away what it had from
  /// there (`flushed`), or to replace what follows the loaded entry. The decoded history
  /// has the frames, so the decoders need not go back. The clock starts again in `tick`.
  private func renderAgain(from frame: Int64, flushed: Bool) {
    let position = itemFrame(at: frame)
    if !flushed {
      output.setRate(0, at: frame)
      output.flush()
    }
    enqueued = frame
    segments.removeAll { $0.start >= frame }
    if let last = segments.last, last.end > frame { segments[segments.count - 1].end = frame }
    // From about where the limiter and the equalizer were there: what the limiter had looked
    // ahead into is gone. The equalizer keeps its curve, which may have changed since.
    marks.removeAll { $0.frame > frame }
    limiter.reset(gain: marks.last?.limiterGain ?? 1)
    if let mark = marks.last {
      let curve = equalizer.target
      equalizer = mark.equalizer
      equalizer.set(curve)
      // The fade's ramp goes on from where it was there, towards the level set now.
      heardFade = mark.fade
    } else {
      equalizer.reset()
    }
    // From before a crossfade, it is begun again when its time comes.
    if let fade = crossfade, frame < fade.start { crossfade = nil }
    next?.nextFrame = 0
    if let current {
      if let position, position.slot === current {
        current.nextFrame = position.frame
        if !current.pipeline.holds(position.frame) { current.pipeline.seek(to: position.frame) }
        // Inside a crossfade into it: the one fading out goes on from there too.
        if let mix = position.mix { mix.slot.nextFrame = mix.frame }
      } else if let position, position.slot === next {
        next?.nextFrame = position.frame
        if let mix = position.mix { mix.slot.nextFrame = mix.frame }
      } else if position == nil {
        current.nextFrame = anchor
        if !current.pipeline.holds(anchor) { current.pipeline.seek(to: anchor) }
      }
    }
    tick()
  }

  /// What plays at timeline `frame`: whose frame, and in a crossfade, the outgoing entry's too.
  private func itemFrame(at frame: Int64) -> (slot: Slot, frame: Int64, mix: (slot: Slot, frame: Int64)?)? {
    for segment in segments where frame >= segment.start && frame < segment.end {
      guard let slot = segment.slot else { return nil }
      let offset = frame - segment.start
      return (slot, segment.itemStart + offset, segment.mix.map { ($0, segment.mixStart + offset) })
    }
    // Past everything queued: where what is being queued would go on.
    guard frame >= enqueued, let current else { return nil }
    if let fade = crossfade, !fade.isQueued { return (fade.to, fade.to.nextFrame, (fade.from, fade.from.nextFrame)) }
    if let next, next.nextFrame > 0 { return (next, next.nextFrame, nil) }
    return (current, current.nextFrame, nil)
  }

  /// A new output rate: everything is rendered again at it, from where it is.
  private func changeRate(to rate: Double) {
    guard rate > 0, rate != output.sampleRate else { return }
    log("output rate \(Int(output.sampleRate)) → \(Int(rate)) Hz")
    let seconds = makeStatus().positionMs / 1000
    let wasLoading = state == .loading
    // Rendered again from the loaded entry's position, which a crossfade into it would cut.
    dropCrossfade()
    output.setRate(0, at: Int64(output.currentFrame()))
    output.flush()
    output.sampleRate = rate
    output.setRate(0, at: 0)
    enqueued = 0
    segments.removeAll()
    limiter = Limiter(sampleRate: rate)
    let curve = equalizer.target
    equalizer = Equalizer(sampleRate: rate)
    equalizer.set(curve)
    marks.removeAll()
    guard let current else { return }
    let frame = Int64((seconds * rate).rounded())
    anchor = frame
    current.nextFrame = frame
    current.fadeLength = max(1, Int(frames(seconds: config.fadeIn)))
    current.fadeLeft = current.fadeLength
    current.pipeline.seek(to: frame, rate: rate)
    next?.nextFrame = 0
    next?.pipeline.seek(to: 0, rate: rate)
    if !wasLoading && state != .ended && state != .error { seeking = true }
  }

  private func outputEvent(_ event: OutputEvent) {
    switch event {
    case .flushedAutomatically(let frame):
      log("output flushed itself at frame \(frame)")
      renderAgain(from: max(frame, Int64(output.currentFrame())), flushed: true)
    case .configurationChanged:
      tick()
    }
  }

  // MARK: - Status

  private func makeStatus() -> EngineStatus {
    EngineStatus(entryId: current?.entryId, state: state, positionMs: Double(positionFrames()) / output.sampleRate * 1000, playing: wantsPlay)
  }

  private func positionFrames() -> Int64 {
    guard let current else { return 0 }
    if state == .ended { return current.pipeline.decoded.end }
    if seeking || state == .loading { return anchor }
    let playhead = Int64(output.currentFrame())
    var last: Int64?
    // Its own frames, alone or in a crossfade, coming in or fading out.
    for segment in segments where segment.slot === current || segment.mix === current {
      let start = segment.slot === current ? segment.itemStart : segment.mixStart
      if playhead < segment.start { return start }
      if playhead < segment.end { return start + (playhead - segment.start) }
      last = start + (segment.end - segment.start)
    }
    return last ?? anchor
  }

  private func setState(_ state: EngineState, always: Bool = false) {
    guard state != self.state || always else { return }
    self.state = state
    emit(.status(makeStatus()))
  }

  // MARK: - Helpers

  private func makeSlot(_ item: EngineItem) -> Slot {
    Slot(pipeline: Pipeline(item: item, factory: factory, engineRate: output.sampleRate) { [weak self] message in self?.log(message) }, gain: item.gain)
  }

  private func frames(ms: Double) -> Int64 { Int64((ms / 1000 * output.sampleRate).rounded()) }
  private func frames(seconds: Double) -> Int64 { Int64((seconds * output.sampleRate).rounded()) }

  private func emit(_ event: EngineEvent) { listener?(event) }
  private func log(_ message: String) { listener?(.log(message)) }

  private func resumeTicking() {
    guard timer == nil, !config.manualTicks else { return }
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + config.tick, repeating: config.tick, leeway: .milliseconds(2))
    timer.setEventHandler { [weak self] in self?.tick() }
    timer.resume()
    self.timer = timer
  }

  private func stopTicking() {
    timer?.cancel()
    timer = nil
  }
}
