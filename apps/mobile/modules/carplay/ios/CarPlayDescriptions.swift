import Foundation

struct CarPlayList: Decodable, Equatable {
  var id: String
  var title: String
  var tabIcon: String?
  var sections: [CarPlaySection] = []
  var emptyTitle: String?
  var emptyDetail: String?
  var loading: Bool?
  var header: CarPlayHeader?
}

struct CarPlayHeader: Decodable, Equatable {
  var title: String
  var detail: String?
  var imageUrl: URL?
  var actionIds: [String]
}

struct CarPlaySection: Decodable, Equatable {
  var title: String?
  var items: [CarPlayRow]
}

struct CarPlayRow: Decodable, Equatable {
  var id: String
  var title: String
  var detail: String?
  var imageUrl: URL?
  var icon: String?
  var enabled: Bool?
  var playing: Bool?
  var disclosure: Bool?
  var images: [CarPlayTile]?
}

struct CarPlayTile: Decodable, Equatable {
  var id: String
  var title: String
  var imageUrl: URL?
}

struct CarPlayNowPlaying: Decodable, Equatable {
  var shuffle = false
  var repeatMode = "off"
  var liked: Bool?
  var hasTrack = false
  var upNext = false
  var album = false

  enum CodingKeys: String, CodingKey {
    case shuffle, liked, hasTrack, upNext, album
    case repeatMode = "repeat"
  }
}
