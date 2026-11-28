import ExpoModulesCore

struct GaplessRecord: Record {
  @Field var sampleRate: Double = 0
  @Field var primingFrames: Double = 0
  @Field var frames: Double = 0
}

/// `NativeItem` in `index.ts`.
struct ItemRecord: Record {
  @Field var entryId: String = ""
  @Field var url: String = ""
  @Field var startMs: Double = 0
  @Field var gain: Double = 1
  @Field var cacheKey: String?
  @Field var gapless: GaplessRecord?
  @Field var decoder: String = "file"
  @Field var albumRun: Bool = false
  @Field var autoplay: Bool = false

  func item() throws -> EngineItem {
    guard let url = URL(string: url) else { throw Exception(name: "BadURL", description: "Not a URL: \(self.url)") }
    return EngineItem(
      entryId: entryId, url: url, startMs: startMs, gain: Float(gain), albumRun: albumRun, decoder: DecoderKind(rawValue: decoder) ?? .file,
      gapless: gapless.map { Gapless(sampleRate: $0.sampleRate, primingFrames: Int64($0.primingFrames), frames: Int64($0.frames)) },
      cacheKey: cacheKey)
  }
}

/// `NativeEqualizer` in `index.ts`.
struct EqualizerRecord: Record {
  @Field var bandsDb: [Double] = []
  @Field var preampDb: Double = 0

  func curve() -> EqualizerCurve {
    EqualizerCurve(bandsDb: bandsDb.map(Float.init), preampDb: Float(preampDb))
  }
}

/**
 * The native engine for JavaScript (`NativeEngine`): commands go to the process's one engine
 * and its events come back as `status`, `ended`, `error`, `interrupted`, `resumed` and `log`.
 * The engine itself is made on the first command, so an app on the classic engine never has one.
 * Streams with a cache key end in `cacheComplete` (the file is the app's now) or `cacheDropped`.
 */
public class AudioEngineModule: Module {
  private var listener: UUID?

  public func definition() -> ModuleDefinition {
    Name("SquirmyAudioEngine")

    Events("status", "ended", "error", "interrupted", "resumed", "log", "cacheComplete", "cacheDropped")

    // TestFlight builds show the engine setting, as development builds do; App Store builds don't.
    Constant("isTestFlight") {
      Bundle.main.appStoreReceiptURL?.lastPathComponent == "sandboxReceipt"
    }

    OnCreate { [weak self] in
      guard let self else { return }
      self.listener = SharedEngine.shared.addListener { [weak self] event in self?.forward(event) }
    }

    OnDestroy {
      if let listener = self.listener { SharedEngine.shared.removeListener(listener) }
    }

    Function("load") { (item: ItemRecord) in
      SharedEngine.shared.engine.load(try item.item(), autoplay: item.autoplay)
    }
    Function("preload") { (item: ItemRecord?) in
      SharedEngine.shared.engine.preload(try item?.item())
    }
    Function("play") { SharedEngine.shared.engine.play() }
    Function("pause") { SharedEngine.shared.engine.pause() }
    Function("seek") { (positionMs: Double) in SharedEngine.shared.engine.seek(toMs: positionMs) }
    Function("setGain") { (gain: Double) in SharedEngine.shared.engine.setGain(Float(gain)) }
    Function("stop") { SharedEngine.shared.engine.stop() }
    Function("holdAudioSession") { (hold: Bool) in SharedEngine.shared.engine.holdAudioSession(hold) }
    Function("setEqualizer") { (curve: EqualizerRecord?) in SharedEngine.shared.engine.setEqualizer(curve?.curve()) }
    Function("setCrossfade") { (seconds: Double) in SharedEngine.shared.engine.setCrossfade(seconds: seconds) }
    Function("setFade") { (level: Double) in SharedEngine.shared.engine.setFade(Float(level)) }
    Function("getStatus") { () -> [String: Any] in
      Self.payload(SharedEngine.shared.engine.status())
    }
    // What to ask the server for: Opus only where Apple's decoder has it (`OpusProbe`).
    Function("probeCodecs") { () -> [String] in
      OpusProbe.codecs
    }
    Function("prefetch") { (cacheKey: String, url: String) in
      guard let url = URL(string: url) else { throw Exception(name: "BadURL", description: "Not a URL: \(url)") }
      SharedEngine.shared.store.prefetch(cacheKey: cacheKey, url: url)
    }
    Function("cancelPrefetch") { (cacheKey: String) in
      SharedEngine.shared.store.cancelPrefetch(cacheKey: cacheKey)
    }
  }

  private static func payload(_ status: EngineStatus) -> [String: Any] {
    ["entryId": status.entryId ?? NSNull(), "state": status.state.rawValue, "positionMs": status.positionMs, "playing": status.playing]
  }

  private func forward(_ event: EngineEvent) {
    switch event {
    case .status(let status): sendEvent("status", Self.payload(status))
    case .ended(let entryId): sendEvent("ended", ["entryId": entryId])
    case .error(let entryId, let message): sendEvent("error", ["entryId": entryId, "message": message])
    case .interrupted(let entryId): sendEvent("interrupted", ["entryId": entryId])
    case .resumed(let entryId): sendEvent("resumed", ["entryId": entryId])
    case .log(let message): sendEvent("log", ["message": message])
    case .cache(.complete(let cacheKey, let file, let bytes)):
      sendEvent("cacheComplete", ["cacheKey": cacheKey, "uri": file.absoluteString, "bytes": Double(bytes)])
    case .cache(.dropped(let cacheKey, let message)):
      sendEvent("cacheDropped", ["cacheKey": cacheKey, "message": message])
    }
  }
}
