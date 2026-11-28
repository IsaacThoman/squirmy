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
  /// A transport command fades the outgoing audio over this.
  var fadeOut = 0.01
  /// Gain changes ramp over this.
  var gainRamp = 0.01
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
  /// The item frame where the fade-in starts, so a renderer flush can replay it.
  var fadeStart: Int64 = 0
  var fadeLength = 0

  init(pipeline: Pipeline, gain: Float) {
    self.pipeline = pipeline
    self.gain = gain
    heardGain = gain
  }

  var entryId: String { pipeline.item.entryId }
}

/// A run of queued output: timeline frames `start..<end` play `slot` from `itemStart`, or
/// silence without a slot.
private struct Segment {
  let start: Int64
  var end: Int64
  let slot: Slot?
  let itemStart: Int64
}

/**
 * The engine: at most two entries, the loaded one and the one that follows, on one sample
 * clock. Each entry's first real sample goes right after the previous one's last, so
 * consecutive tracks are gapless to the sample whenever their decoders trim exactly.
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
  private var queuedAudio = QueuedAudio()
  /// A de-click tail belongs to the output clock, outside the new entry's position.
  private var outgoing: OutputChunk?

  /// The next timeline frame to queue, and what is queued.
  private var enqueued: Int64 = 0
  private var segments: [Segment] = []
  /// The end of the chain: every entry not at unity gain plays through it.
  private var limiter: Limiter
  /// The limiter's gain before each run of frames queued, to carry on from when rendering
  /// again part way.
  private var limiterMarks: [(frame: Int64, gain: Float)] = []
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
    restart(fadingOut: true)
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
      return
    }
    let old = next
    next = item.map(makeSlot)
    if let old {
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
    cancelOutgoing()
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
      restart(fadingOut: true)
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
    restart(fadingOut: true)
    startAt(target)
    seeking = true
    tick()
  }

  private func doStop() {
    restart(fadingOut: true)
    current?.pipeline.release()
    next?.pipeline.release()
    current = nil
    next = nil
    wantsPlay = false
    buffering = false
    seeking = false
    interruptedEntryId = nil
    setState(.idle, always: true)
    if !holding && outgoing == nil { session?.deactivate() }
    tick()
  }

  private func doHold(_ hold: Bool) {
    guard hold != holding else { return }
    holding = hold
    log(hold ? "holding the audio session" : "audio session released")
    if current == nil && outgoing == nil {
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
    cancelOutgoing()
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
    cancelOutgoing()
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
    finishOutgoing()
    advance()
    checkFailures()
    checkUnderrun()
    fill()
    runClock()
    requestDecoding()
    forgetHistory()
    if current == nil && next == nil && !holding && outgoing == nil { stopTicking() }
  }

  /// Crosses into the preloaded entry once its first frame plays, and ends an entry with
  /// nothing after it once its last frame has.
  private func advance() {
    let playhead = Int64(output.currentFrame())
    if let current, let next, let first = segments.first(where: { $0.slot === next }), playhead >= first.start {
      self.current = next
      self.next = nil
      anchor = 0
      current.pipeline.release()
      segments.removeAll { $0.slot === current }
      log("\(current.entryId) ended; \(next.entryId) playing")
      state = .playing
      emit(.ended(entryId: current.entryId))
      emit(.status(makeStatus()))
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
    if let outgoing, playhead < outgoing.end { return }
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
    if let outgoing, playhead < outgoing.end { return }
    if buffering {
      let feeding = current.nextFrame >= current.pipeline.decoded.end && current.pipeline.decoded.ended ? next : current
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
    if enqueued - playhead < frames(seconds: config.underrun), !atEnd, peekChunk() == nil {
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
    if let outgoing, enqueued < outgoing.end {
      guard output.isReadyForMoreMediaData else { return }
      let start = max(enqueued, outgoing.start)
      output.enqueue(outgoing.slice(from: start, to: outgoing.end), at: start)
      enqueued = outgoing.end
    }
    // A paused replacement must not be queued while the clock is still playing the tail.
    if outgoing != nil && !wantsPlay && current != nil { return }
    if seeking, let current, current.pipeline.decoded.ended, current.nextFrame >= current.pipeline.decoded.end {
      // Sought to the very end.
      seeking = false
      emit(.status(makeStatus()))
    }
    while enqueued < playhead + lead, output.isReadyForMoreMediaData {
      if let (slot, samples) = takeChunk() {
        enqueue(slot, samples)
        continue
      }
      let waitingToSound = current != nil && wantsPlay && current!.pipeline.error == nil && (state == .loading || seeking)
      let holdingOnly = current == nil && holding
      guard (waitingToSound || holdingOnly) && !systemInterrupted && enqueued < playhead + silenceLead else { break }
      let count = config.chunkFrames / 4
      limiter.reset()
      limiterMarks.append((enqueued, 1))
      output.enqueue([Float](repeating: 0, count: count * 2)[...], at: enqueued)
      append(Segment(start: enqueued, end: enqueued + Int64(count), slot: nil, itemStart: 0))
      enqueued += Int64(count)
    }
  }

  /// The next frames to queue: the loaded entry's, then the preloaded one's once the loaded
  /// one is decoded to its end and queued.
  private func peekChunk() -> Slot? {
    guard let current else { return nil }
    let decoded = current.pipeline.decoded
    if current.nextFrame < decoded.end { return current }
    guard decoded.ended, !seeking, let next, next.pipeline.error == nil, next.nextFrame < next.pipeline.decoded.end else { return nil }
    return next
  }

  private func takeChunk() -> (Slot, [Float])? {
    guard let slot = peekChunk() else { return nil }
    let samples = slot.pipeline.copy(from: slot.nextFrame, count: config.chunkFrames)
    return samples.isEmpty ? nil : (slot, Array(samples))
  }

  private func enqueue(_ slot: Slot, _ chunk: [Float]) {
    var samples = chunk
    let count = samples.count / 2
    // At unity gain (normalization off) an entry plays as the file is; any other gain, a
    // boost above all, goes through the limiter.
    let limited = slot.gain != 1 || slot.heardGain != 1
    shape(&samples, slot)
    let itemStart = slot.nextFrame
    slot.nextFrame += Int64(count)
    limiterMarks.append((enqueued, limiter.gain))
    if limited {
      limiter.process(&samples, ahead: upcoming(limiter.aheadFrames)[...])
    } else {
      limiter.pass(samples[...])
    }
    queuedAudio.append(samples[...], at: enqueued)
    output.enqueue(samples[...], at: enqueued)
    append(Segment(start: enqueued, end: enqueued + Int64(count), slot: slot, itemStart: itemStart))
    enqueued += Int64(count)
    guard slot === current else { return }
    if state == .loading {
      log("\(slot.entryId) \(wantsPlay ? "playing" : "ready") at \(Int(Double(anchor) / output.sampleRate * 1000)) ms")
      setState(wantsPlay ? .playing : .paused)
    } else if seeking {
      seeking = false
      emit(.status(makeStatus()))
    }
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
    let offset = Int(slot.nextFrame - slot.fadeStart)
    if offset >= 0, offset < slot.fadeLength {
      let count = min(count, slot.fadeLength - offset)
      for frame in 0..<count {
        let level = Float(offset + frame) / Float(slot.fadeLength)
        samples[frame * 2] *= level
        samples[frame * 2 + 1] *= level
      }
    }
  }

  /// Up to `count` frames that are queued after what was just taken, at their entries' gains:
  /// what the limiter looks ahead into. Short where decoding has not got that far.
  private func upcoming(_ count: Int) -> [Float] {
    guard let current else { return [] }
    var frames = scaled(current.pipeline.copy(from: current.nextFrame, count: count), current)
    let decoded = current.pipeline.decoded
    let short = count - frames.count / 2
    if short > 0, decoded.ended, current.nextFrame + Int64(frames.count / 2) >= decoded.end, !seeking, let next, next.pipeline.error == nil {
      frames += scaled(next.pipeline.copy(from: next.nextFrame, count: short), next)
    }
    return frames
  }

  /// `samples` at the slot's gain, or at the one it ramps from when that is larger, so the
  /// limiter turns down at least as far as it will have to.
  private func scaled(_ samples: ArraySlice<Float>, _ slot: Slot) -> [Float] {
    let gain = max(slot.gain, slot.heardGain)
    return gain == 1 ? Array(samples) : samples.map { $0 * gain }
  }

  private func append(_ segment: Segment) {
    if var last = segments.last, last.slot === segment.slot, last.end == segment.start,
       segment.slot == nil || last.itemStart + (last.end - last.start) == segment.itemStart {
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
    let fading = outgoing.map { playhead < $0.end } ?? false
    let shouldRun = !systemInterrupted && (sounding || fading || (current == nil && holding))
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
    for slot in [current, next].compactMap({ $0 }) { slot.pipeline.want(slot.nextFrame + ahead) }
  }

  private func forgetHistory() {
    let playhead = Int64(output.currentFrame())
    queuedAudio.forget(before: playhead)
    guard let current else { return }
    let keep = frames(seconds: (airPlay ? config.airPlayHistory + config.airPlayLead : config.history + config.lead))
    current.pipeline.forget(before: current.nextFrame - keep)
    segments.removeAll { $0.end < playhead - keep }
    limiterMarks.removeAll { $0.frame < playhead - keep }
  }

  private func finishOutgoing() {
    guard let outgoing, Int64(output.currentFrame()) >= outgoing.end else { return }
    self.outgoing = nil
    if !wantsPlay && !(current == nil && holding) {
      // The feed tick can land past the end of the tail. A paused load starts right there.
      output.setRate(0, at: outgoing.end)
    }
    if current == nil && !holding { session?.deactivate() }
  }

  /// A pause or loss of the output must take effect even during the short tail.
  private func cancelOutgoing() {
    guard let outgoing, Int64(output.currentFrame()) < outgoing.end else { return }
    restart()
    startAt(anchor)
    if current == nil && !holding { session?.deactivate() }
  }

  // MARK: - Rendering again

  /// Flushes the whole lead, even on AirPlay. The only outgoing audio re-queued is the
  /// de-click tail at the playhead, so a ready replacement can start right after it.
  private func restart(fadingOut: Bool = false) {
    let playhead = Int64(output.currentFrame())
    let wasRunning = output.rate > 0
    output.setRate(0, at: playhead)
    if fadingOut && wasRunning {
      // Rapid commands can replace the destination during a fade. Finish that same tail.
      if outgoing.map({ playhead >= $0.end }) ?? true {
        let fadeEnd = playhead + frames(seconds: config.fadeOut)
        let segment = segments.first { $0.slot != nil && $0.start <= playhead && playhead < $0.end }
        outgoing = segment.flatMap { queuedAudio.fadeOut(from: playhead, to: min(fadeEnd, $0.end)) }
      }
    } else {
      outgoing = nil
    }
    output.flush()
    enqueued = playhead
    segments.removeAll()
    queuedAudio.reset()
    limiter.reset()
    limiterMarks.removeAll()
    next?.nextFrame = 0
  }

  /// The loaded entry starts at `frame`, from a fade-in.
  private func startAt(_ frame: Int64) {
    guard let current else { return }
    anchor = frame
    current.nextFrame = frame
    current.fadeStart = frame
    current.fadeLength = Int(frames(seconds: config.fadeIn))
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
    queuedAudio.discard(from: frame)
    enqueued = frame
    segments.removeAll { $0.start >= frame }
    if let last = segments.last, last.end > frame { segments[segments.count - 1].end = frame }
    // From about where the limiter was there: what it had looked ahead into is gone.
    limiterMarks.removeAll { $0.frame > frame }
    limiter.reset(gain: limiterMarks.last?.gain ?? 1)
    next?.nextFrame = 0
    if let current {
      if let position, position.slot === current {
        current.nextFrame = position.frame
        if !current.pipeline.holds(position.frame) { current.pipeline.seek(to: position.frame) }
      } else if let position, position.slot === next {
        next?.nextFrame = position.frame
      } else if position == nil {
        current.nextFrame = anchor
        if !current.pipeline.holds(anchor) { current.pipeline.seek(to: anchor) }
      }
    }
    tick()
  }

  private func itemFrame(at frame: Int64) -> (slot: Slot, frame: Int64)? {
    for segment in segments where frame >= segment.start && frame < segment.end {
      guard let slot = segment.slot else { return nil }
      return (slot, segment.itemStart + (frame - segment.start))
    }
    // Past everything queued: where the loaded entry would go on.
    if let current, frame >= enqueued { return (current, current.nextFrame) }
    return nil
  }

  /// A new output rate: everything is rendered again at it, from where it is.
  private func changeRate(to rate: Double) {
    guard rate > 0, rate != output.sampleRate else { return }
    log("output rate \(Int(output.sampleRate)) → \(Int(rate)) Hz")
    let seconds = makeStatus().positionMs / 1000
    let wasLoading = state == .loading
    output.setRate(0, at: Int64(output.currentFrame()))
    output.flush()
    output.sampleRate = rate
    output.setRate(0, at: 0)
    enqueued = 0
    segments.removeAll()
    queuedAudio.reset()
    if outgoing != nil && current == nil && !holding { session?.deactivate() }
    outgoing = nil
    limiter = Limiter(sampleRate: rate)
    limiterMarks.removeAll()
    guard let current else { return }
    let frame = Int64((seconds * rate).rounded())
    anchor = frame
    current.nextFrame = frame
    current.fadeStart = frame
    current.fadeLength = Int(frames(seconds: config.fadeIn))
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
    var last: Segment?
    for segment in segments where segment.slot === current {
      if playhead < segment.start { return segment.itemStart }
      if playhead < segment.end { return segment.itemStart + (playhead - segment.start) }
      last = segment
    }
    if let last { return last.itemStart + (last.end - last.start) }
    return anchor
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
