import SwiftUI
import WidgetKit

/// The widget extension: Now Playing (Home and Lock Screen), Jump back in, and the downloads Live Activity.
@main
struct SquirmyWidgets: WidgetBundle {
  var body: some Widget {
    NowPlayingWidget()
    RecentlyPlayedWidget()
    DownloadsLiveActivity()
  }
}
