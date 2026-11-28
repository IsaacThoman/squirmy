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
      entryId: entryId, url: url, startMs: startMs, gain: Float(gain), decoder: DecoderKind(rawValue: decoder) ?? .file,
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
 */
public class AudioEngineModule: Module {
  private var listener: UUID?

  public func definition() -> ModuleDefinition {
    Name("SquirmyAudioEngine")

    Events("status", "ended", "error", "interrupted", "resumed", "log")

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
    Function("getStatus") { () -> [String: Any] in
      Self.payload(SharedEngine.shared.engine.status())
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
    }
  }
}
