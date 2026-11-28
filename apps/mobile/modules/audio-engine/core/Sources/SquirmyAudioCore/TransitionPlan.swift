import Foundation

/// The playback descriptor's `timing`: where an item's music starts and ends, in
/// milliseconds of the file, from the server's sonic analysis. Each is nil when unknown.
struct ItemTiming: Equatable {
  var audibleStartMs: Double?
  var audibleEndMs: Double?
  var introEndMs: Double?
  var outroStartMs: Double?
}

/**
 * Where a crossfade between two items starts and ends: client-core's `crossfadePlan`
 * (`packages/client-core/src/transition.ts`), rule for rule, so the phone and the web place a
 * fade the same way; `TransitionPlanTests` has the same cases as its tests.
 *
 * - The fade is the length set, but no more than half of either item.
 * - Silence is skipped: the fade ends where the outgoing item falls silent (`audibleEndMs`),
 *   and the incoming one starts where its sound does (`audibleStartMs`).
 * - With Smart transitions, the fade lasts as long as the longer of the outgoing item's outro
 *   and the incoming one's intro, at least `smartShortestMs` and at most the length set.
 *
 * Timing that does not fit the item (an end before its middle, a start after it) is ignored.
 */
struct TransitionPlan: Equatable {
  /// How long both items play together.
  var fadeMs: Double
  /// Where the outgoing item falls silent: the fade ends here, and the item with it.
  var outgoingEndMs: Double
  /// Where the incoming item starts when the fade does.
  var incomingStartMs: Double

  static let smartShortestMs = 1000.0

  static func make(outgoingMs: Double, outgoing: ItemTiming?, incomingMs: Double?, incoming: ItemTiming?, seconds: Double, smart: Bool) -> TransitionPlan {
    let inLength = incomingMs ?? .infinity
    let fade = max(0, min(seconds * 1000, outgoingMs / 2, inLength / 2))
    let end = within(outgoing?.audibleEndMs, outgoingMs / 2, outgoingMs) ?? outgoingMs
    let start = incomingStart(incomingMs: incomingMs, incoming: incoming)
    let plain = TransitionPlan(fadeMs: fade, outgoingEndMs: end, incomingStartMs: start)
    guard smart else { return plain }
    let outroStart = within(outgoing?.outroStartMs, outgoingMs / 2, end)
    let introEnd = within(incoming?.introEndMs, start, inLength / 2)
    if outroStart == nil && introEnd == nil { return plain }
    let span = max(outroStart.map { end - $0 } ?? 0, introEnd.map { $0 - start } ?? 0)
    return TransitionPlan(fadeMs: min(fade, max(smartShortestMs, span)), outgoingEndMs: end, incomingStartMs: start)
  }

  /// Where the incoming item starts: it depends on its own timing alone.
  static func incomingStart(incomingMs: Double?, incoming: ItemTiming?) -> Double {
    within(incoming?.audibleStartMs, 0, (incomingMs ?? .infinity) / 2) ?? 0
  }

  private static func within(_ value: Double?, _ low: Double, _ high: Double) -> Double? {
    guard let value, value.isFinite, value >= low, value <= high else { return nil }
    return value
  }
}
