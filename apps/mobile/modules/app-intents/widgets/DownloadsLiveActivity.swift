import ActivityKit
import SwiftUI
import WidgetKit

/// Downloads in progress, on the Lock Screen and in the Dynamic Island.
struct DownloadsLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: DownloadActivityAttributes.self) { context in
      DownloadBanner(state: context.state, stale: context.isStale)
        .padding(16)
        .activitySystemActionForegroundColor(.primary)
        .widgetURL(WidgetLinks.downloads)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          Image(systemName: context.state.finished ? "checkmark.circle.fill" : "arrow.down.circle.fill")
            .font(.title2).foregroundStyle(.tint)
        }
        DynamicIslandExpandedRegion(.trailing) {
          Text(count(context.state)).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
        }
        DynamicIslandExpandedRegion(.bottom) {
          VStack(alignment: .leading, spacing: 6) {
            Text(context.state.title).font(.subheadline.weight(.semibold)).lineLimit(1)
            ProgressView(value: fraction(context.state)).tint(.accentColor)
          }
        }
      } compactLeading: {
        Image(systemName: "arrow.down.circle.fill").foregroundStyle(.tint)
      } compactTrailing: {
        Text(count(context.state)).font(.caption2.monospacedDigit())
      } minimal: {
        ProgressView(value: fraction(context.state)).progressViewStyle(.circular).tint(.accentColor)
      }
      .widgetURL(WidgetLinks.downloads)
    }
  }
}

private struct DownloadBanner: View {
  let state: DownloadActivityAttributes.ContentState
  let stale: Bool

  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: state.finished ? "checkmark.circle.fill" : "arrow.down.circle.fill")
        .font(.title).foregroundStyle(.tint)
      VStack(alignment: .leading, spacing: 4) {
        Text(state.title).font(.headline).lineLimit(1)
        Text(detail).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
        if !state.finished {
          ProgressView(value: fraction(state)).tint(.accentColor)
        }
      }
    }
  }

  private var detail: String {
    // A suspended app can't say how far it got; the transfers go on without it.
    stale && !state.finished ? "Downloading · open Squirmy for progress" : state.detail
  }
}

private func fraction(_ state: DownloadActivityAttributes.ContentState) -> Double {
  state.total > 0 ? min(1, Double(state.done) / Double(state.total)) : 0
}

private func count(_ state: DownloadActivityAttributes.ContentState) -> String {
  "\(state.done)/\(state.total)"
}
