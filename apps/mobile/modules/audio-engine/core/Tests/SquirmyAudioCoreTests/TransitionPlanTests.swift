import XCTest
@testable import SquirmyAudioCore

/// The same cases as client-core's `transition.test.ts`: the phone and the web must place a fade alike.
final class TransitionPlanTests: XCTestCase {
  private func plan(out outgoingMs: Double, _ outgoing: ItemTiming? = nil, into incomingMs: Double?, _ incoming: ItemTiming? = nil, seconds: Double = 6, smart: Bool) -> TransitionPlan {
    TransitionPlan.make(outgoingMs: outgoingMs, outgoing: outgoing, incomingMs: incomingMs, incoming: incoming, seconds: seconds, smart: smart)
  }

  func testFadesOverTheLengthSetAtTheEndsOfTheFilesWithoutTiming() {
    XCTAssertEqual(plan(out: 200_000, into: 180_000, smart: false), TransitionPlan(fadeMs: 6_000, outgoingEndMs: 200_000, incomingStartMs: 0))
    XCTAssertEqual(plan(out: 8_000, into: 180_000, smart: false).fadeMs, 4_000)
    XCTAssertEqual(plan(out: 200_000, into: 5_000, smart: false).fadeMs, 2_500)
    XCTAssertEqual(plan(out: 200_000, into: nil, smart: false).fadeMs, 6_000)
    XCTAssertEqual(plan(out: 200_000, into: 180_000, smart: true), TransitionPlan(fadeMs: 6_000, outgoingEndMs: 200_000, incomingStartMs: 0))
  }

  func testSkipsTheSilenceAfterTheOutgoingItemAndBeforeTheIncomingOne() {
    XCTAssertEqual(plan(out: 200_000, ItemTiming(audibleEndMs: 196_500), into: 180_000, ItemTiming(audibleStartMs: 700), smart: false),
                   TransitionPlan(fadeMs: 6_000, outgoingEndMs: 196_500, incomingStartMs: 700))
  }

  func testIgnoresTimingThatDoesNotFitTheItem() {
    XCTAssertEqual(plan(out: 200_000, ItemTiming(audibleEndMs: 50_000, outroStartMs: 10_000), into: 180_000, ItemTiming(audibleStartMs: 120_000, introEndMs: 150_000), smart: true),
                   TransitionPlan(fadeMs: 6_000, outgoingEndMs: 200_000, incomingStartMs: 0))
  }

  func testSmartTransitionsMixOverTheLongerOfTheOutroAndTheIntro() {
    let fadesOut = ItemTiming(audibleEndMs: 199_000, outroStartMs: 195_000)
    let hardStart = ItemTiming(audibleStartMs: 100, introEndMs: 300)
    XCTAssertEqual(plan(out: 200_000, fadesOut, into: 180_000, hardStart, smart: true), TransitionPlan(fadeMs: 4_000, outgoingEndMs: 199_000, incomingStartMs: 100))
    XCTAssertEqual(plan(out: 200_000, fadesOut, into: 180_000, ItemTiming(audibleStartMs: 0, introEndMs: 5_000), smart: true).fadeMs, 5_000)
    XCTAssertEqual(plan(out: 200_000, ItemTiming(audibleEndMs: 199_000, outroStartMs: 170_000), into: 180_000, hardStart, smart: true).fadeMs, 6_000)
    let hardEnd = ItemTiming(audibleEndMs: 199_900, outroStartMs: 199_700)
    XCTAssertEqual(plan(out: 200_000, hardEnd, into: 180_000, hardStart, smart: true),
                   TransitionPlan(fadeMs: TransitionPlan.smartShortestMs, outgoingEndMs: 199_900, incomingStartMs: 100))
    XCTAssertEqual(plan(out: 200_000, hardEnd, into: 180_000, hardStart, seconds: 0.5, smart: true).fadeMs, 500)
  }
}
