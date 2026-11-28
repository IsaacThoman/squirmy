#if canImport(ActivityKit)
import ActivityKit
import Foundation

/**
 * The downloads Live Activity, kept by the app while it runs. Nothing is pushed from the
 * server, so a suspended app can't move it on: each update is marked stale after a while, and
 * the activity says so rather than show a count that stopped. One the app left behind (it was
 * quit mid-download) is taken over by the first update of this launch, or ended.
 */
@MainActor
final class DownloadActivityController {
  static let shared = DownloadActivityController()

  /// How long an update stands before the activity calls itself out of date.
  private static let staleAfter: TimeInterval = 90
  /// How long a finished activity stays on the Lock Screen.
  private static let finishedFor: TimeInterval = 8

  private var activity: Activity<DownloadActivityAttributes>?
  private var adopted = false
  /// Updates apply one at a time, in the order JavaScript sent them.
  private var last: Task<Void, Never>?

  func update(_ state: DownloadActivityAttributes.ContentState?) async {
    let previous = last
    let task = Task { @MainActor in
      await previous?.value
      await self.apply(state)
    }
    last = task
    await task.value
  }

  private func apply(_ state: DownloadActivityAttributes.ContentState?) async {
    if !adopted {
      adopted = true
      let running = Activity<DownloadActivityAttributes>.activities.filter { $0.activityState == .active }
      // A count left from the last launch is stale: this launch's first word replaces it.
      activity = state == nil ? nil : running.first
      for leftOver in running where leftOver.id != activity?.id {
        await leftOver.end(nil, dismissalPolicy: .immediate)
      }
    }
    guard let state else {
      // Nothing downloading. A finished activity stays for its few seconds.
      await activity?.end(nil, dismissalPolicy: .immediate)
      activity = nil
      return
    }
    if state.finished {
      await activity?.end(ActivityContent(state: state, staleDate: nil), dismissalPolicy: .after(Date().addingTimeInterval(Self.finishedFor)))
      activity = nil
      return
    }
    let content = ActivityContent(state: state, staleDate: Date().addingTimeInterval(Self.staleAfter))
    if let activity, activity.activityState == .active {
      await activity.update(content)
      return
    }
    guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
    do {
      // Only possible while the app is in the foreground, where downloads are started.
      activity = try Activity.request(attributes: DownloadActivityAttributes(), content: content, pushType: nil)
    } catch {
      NSLog("[surfaces] Could not start the downloads Live Activity: %@", String(describing: error))
    }
  }
}
#endif
