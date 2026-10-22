import ExpoModulesCore
import Foundation
import Security
#if canImport(TVServices)
import TVServices
#endif

public class TopShelfCacheModule: Module {
  private let appGroupInfoPlistKey = "StreamyfinAppGroupIdentifier"
  private let keychainAccessGroupInfoPlistKey = "StreamyfinKeychainAccessGroupIdentifier"
  private let cacheKey = "TopShelfCache"
  private let artworkDirectoryName = "TVDiscoveryImages"
  private let apiKeyService = "StreamyfinTopShelf"
  private let apiKeyAccount = "JellyfinApiKey"
  private var appGroupIdentifier: String? {
    if let appGroupIdentifier = Bundle.main.object(
      forInfoDictionaryKey: appGroupInfoPlistKey
    ) as? String {
      return appGroupIdentifier
    }

    guard let bundleIdentifier = Bundle.main.bundleIdentifier else {
      return nil
    }

    return "group.\(bundleIdentifier)"
  }
  private var keychainAccessGroupIdentifier: String? {
    Bundle.main.object(forInfoDictionaryKey: keychainAccessGroupInfoPlistKey) as? String
  }

  public func definition() -> ModuleDefinition {
    Name("TopShelfCache")

    Function("writeCache") { (json: String, apiKey: String?) -> Bool in
      guard
        let appGroupIdentifier = appGroupIdentifier,
        let defaults = UserDefaults(suiteName: appGroupIdentifier),
        let groupURL = FileManager.default.containerURL(
          forSecurityApplicationGroupIdentifier: appGroupIdentifier
        ),
        let prepared = prepareArtwork(json, in: groupURL)
      else {
        return false
      }

      defaults.set(prepared, forKey: cacheKey)
      defaults.set(Date().timeIntervalSince1970, forKey: "\(cacheKey)UpdatedAt")
      defaults.synchronize()
      let didSaveAPIKey = saveAPIKey(apiKey)

      #if canImport(TVServices)
      TVTopShelfContentProvider.topShelfContentDidChange()
      #endif

      return didSaveAPIKey
    }

    Function("clearCache") { () -> Bool in
      guard
        let appGroupIdentifier = appGroupIdentifier,
        let defaults = UserDefaults(suiteName: appGroupIdentifier)
      else {
        return false
      }

      defaults.removeObject(forKey: cacheKey)
      defaults.removeObject(forKey: "\(cacheKey)UpdatedAt")
      defaults.synchronize()
      if let groupURL = FileManager.default.containerURL(
        forSecurityApplicationGroupIdentifier: appGroupIdentifier
      ) {
        try? FileManager.default.removeItem(
          at: groupURL.appendingPathComponent(artworkDirectoryName)
        )
      }
      let didDeleteAPIKey = deleteAPIKey()

      #if canImport(TVServices)
      TVTopShelfContentProvider.topShelfContentDidChange()
      #endif

      return didDeleteAPIKey
    }
  }

  private func prepareArtwork(_ json: String, in groupURL: URL) -> String? {
    guard
      let data = json.data(using: .utf8),
      var payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let sections = payload["sections"] as? [[String: Any]]
    else {
      return nil
    }

    let artworkDirectory = groupURL.appendingPathComponent(artworkDirectoryName)
    let fileManager = FileManager.default
    payload["sections"] = sections.map { section in
      var section = section
      section["items"] = (section["items"] as? [[String: Any]] ?? []).map { item in
        var item = item
        guard
          let sourceString = item["imageUrl"] as? String,
          let source = URL(string: sourceString),
          source.isFileURL
        else {
          return item
        }

        let name = source.lastPathComponent
        let validName = name.range(
          of: #"^[a-f0-9]{64}\.jpg$"#,
          options: .regularExpression
        ) != nil
        guard validName else {
          item.removeValue(forKey: "imageUrl")
          return item
        }

        let destination = artworkDirectory.appendingPathComponent(name)
        do {
          try fileManager.createDirectory(
            at: artworkDirectory,
            withIntermediateDirectories: true
          )
          if !fileManager.fileExists(atPath: destination.path) {
            try fileManager.copyItem(at: source, to: destination)
          }
          item["imageUrl"] = destination.absoluteString
        } catch {
          item.removeValue(forKey: "imageUrl")
        }
        return item
      }
      return section
    }

    guard
      let prepared = try? JSONSerialization.data(withJSONObject: payload),
      let result = String(data: prepared, encoding: .utf8)
    else {
      return nil
    }
    return result
  }

  private func baseAPIKeyQuery() -> [String: Any] {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: apiKeyService,
      kSecAttrAccount as String: apiKeyAccount
    ]

    if let keychainAccessGroupIdentifier {
      query[kSecAttrAccessGroup as String] = keychainAccessGroupIdentifier
    }

    return query
  }

  private func saveAPIKey(_ apiKey: String?) -> Bool {
    guard deleteAPIKey() else {
      return false
    }

    guard
      let apiKey,
      !apiKey.isEmpty,
      let data = apiKey.data(using: .utf8)
    else {
      return true
    }

    var query = baseAPIKeyQuery()
    query[kSecValueData as String] = data
    let status = SecItemAdd(query as CFDictionary, nil)
    return status == errSecSuccess
  }

  private func deleteAPIKey() -> Bool {
    let status = SecItemDelete(baseAPIKeyQuery() as CFDictionary)
    return status == errSecSuccess || status == errSecItemNotFound
  }
}
