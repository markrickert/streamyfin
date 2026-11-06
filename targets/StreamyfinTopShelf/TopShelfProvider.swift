import Foundation
import TVServices

private let appGroupInfoPlistKey = "StreamyfinAppGroupIdentifier"
private let cacheKey = "TopShelfCache"
private let artworkFolder = "TopShelfArtwork"

private struct TopShelfCachePayload: Decodable {
  let sections: [TopShelfCacheSection]
}

private struct TopShelfCacheSection: Decodable {
  let title: String
  let items: [TopShelfCacheItem]
}

private struct TopShelfCacheItem: Decodable {
  let id: String
  let title: String
  let imageUrl: String?
  let route: String
  let playRoute: String?
}

final class TopShelfProvider: TVTopShelfContentProvider {
  override func loadTopShelfContent(
    completionHandler: @escaping (TVTopShelfContent?) -> Void
  ) {
    guard
      let appGroupIdentifier = Bundle.main.object(
        forInfoDictionaryKey: appGroupInfoPlistKey
      ) as? String,
      let defaults = UserDefaults(suiteName: appGroupIdentifier),
      let json = defaults.string(forKey: cacheKey),
      let data = json.data(using: .utf8),
      let payload = try? JSONDecoder().decode(TopShelfCachePayload.self, from: data)
    else {
      completionHandler(nil)
      return
    }

    let sections = payload.sections.compactMap { section -> TVTopShelfItemCollection<TVTopShelfSectionedItem>? in
      let items = section.items.compactMap { makeTopShelfItem($0, appGroupIdentifier: appGroupIdentifier) }
      guard !items.isEmpty else { return nil }

      let collection = TVTopShelfItemCollection(items: items)
      collection.title = section.title
      return collection
    }

    completionHandler(sections.isEmpty ? nil : TVTopShelfSectionedContent(sections: sections))
  }

  private func makeTopShelfItem(
    _ cacheItem: TopShelfCacheItem,
    appGroupIdentifier: String
  ) -> TVTopShelfSectionedItem? {
    guard let route = URL(string: cacheItem.route) else {
      return nil
    }

    let item = TVTopShelfSectionedItem(identifier: cacheItem.id)
    item.title = cacheItem.title
    item.imageShape = .poster
    item.displayAction = TVTopShelfAction(url: route)

    if let playRoute = cacheItem.playRoute, let playURL = URL(string: playRoute) {
      item.playAction = TVTopShelfAction(url: playURL)
    }

    if let imageUrl = cacheItem.imageUrl,
       let url = imageURL(from: imageUrl, appGroupIdentifier: appGroupIdentifier) {
      item.setImageURL(url, for: .screenScale1x)
      item.setImageURL(url, for: .screenScale2x)
    }

    return item
  }

  private func imageURL(from reference: String, appGroupIdentifier: String) -> URL? {
    guard let url = URL(string: reference), url.isFileURL,
          let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupIdentifier),
          url.standardizedFileURL.deletingLastPathComponent() ==
            container.appendingPathComponent(artworkFolder, isDirectory: true).standardizedFileURL,
          FileManager.default.fileExists(atPath: url.path)
    else { return nil }
    return url
  }
}
