#if canImport(ActivityKit)
import ActivityKit
import Foundation

/**
 * The Live Activity while downloads run: what is downloading and how far it has come. The pod
 * starts, updates and ends it from the app; the widget extension draws it. ActivityKit pairs
 * the two copies of this type by name, so both must keep the same fields.
 */
struct DownloadActivityAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    /// The album or playlist downloading, or how many are ("3 downloads").
    var title: String
    /// The app's own words for it: "Downloading 2 of 12", "Downloaded".
    var detail: String
    /// Songs on the phone, out of every song asked for.
    var done: Int
    var total: Int
    /// Every song is here, or what is left can't be had: the activity is about to end.
    var finished: Bool
  }
}
#endif
