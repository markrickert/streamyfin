import ExpoModulesCore
import Foundation
import ImageIO
import Security
#if canImport(TVServices)
import TVServices
#endif

public class TopShelfCacheModule: Module {
  private let appGroupInfoPlistKey = "StreamyfinAppGroupIdentifier"
  private let cacheKey = "TopShelfCache"
  private let artworkFolder = "TopShelfArtwork"
  private let maxArtworkFiles = 72
  private let maxArtworkBytes: Int64 = 8 * 1024 * 1024
  private let maxStorageBytes: Int64 = 48 * 1024 * 1024
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
  private var container: URL? {
    guard let appGroupIdentifier else { return nil }
    return FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupIdentifier)
  }

  private func artworkDirectory(create: Bool) -> URL? {
    guard let container else { return nil }
    let directory = container.appendingPathComponent(artworkFolder, isDirectory: true)
    if create {
      do {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      } catch {
        return nil
      }
    }
    return directory
  }

  private func imageFile(_ key: String, createDirectory: Bool = false) -> URL? {
    guard key.count == 64,
          key.unicodeScalars.allSatisfy({ ("0"..."9").contains(String($0)) || ("a"..."f").contains(String($0)) }),
          let directory = artworkDirectory(create: createDirectory)
    else { return nil }
    return directory.appendingPathComponent("\(key).jpg")
  }

  private func cachedImage(_ key: String) -> String? {
    guard let file = imageFile(key), FileManager.default.fileExists(atPath: file.path) else {
      return nil
    }
    return file.absoluteString
  }

  private func storeImage(_ key: String, from source: String) -> String? {
    if let existing = cachedImage(key) { return existing }
    guard let destination = imageFile(key, createDirectory: true),
          let directory = artworkDirectory(create: true),
          let sourceURL = URL(string: source), sourceURL.isFileURL,
          let size = try? sourceURL.resourceValues(forKeys: [.fileSizeKey]).fileSize,
          size > 0, Int64(size) <= maxArtworkBytes,
          let image = CGImageSourceCreateWithURL(sourceURL as CFURL, nil),
          CGImageSourceGetCount(image) > 0,
          let files = try? FileManager.default.contentsOfDirectory(atPath: directory.path),
          files.count < maxArtworkFiles,
          let existingFiles = try? FileManager.default.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: [.fileSizeKey]),
          Int64(size) + existingFiles.reduce(Int64(0), {
            $0 + Int64((try? $1.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
          }) <= maxStorageBytes
    else { return nil }
    let pending = directory.appendingPathComponent("\(key).pending")
    do {
      try FileManager.default.copyItem(at: sourceURL, to: pending)
      try FileManager.default.moveItem(at: pending, to: destination)
      return destination.absoluteString
    } catch {
      try? FileManager.default.removeItem(at: pending)
      return nil
    }
  }

  private func pruneImages(_ keys: [String]) {
    guard let directory = artworkDirectory(create: false),
          let files = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
    else { return }
    let keep = Set(keys.compactMap { imageFile($0)?.lastPathComponent })
    for file in files where !keep.contains(file.lastPathComponent) {
      try? FileManager.default.removeItem(at: file)
    }
  }

  public func definition() -> ModuleDefinition {
    Name("TopShelfCache")

    Function("getCachedImage") { (key: String) -> String? in
      cachedImage(key)
    }

    Function("storeImage") { (key: String, fileUri: String) -> String? in
      storeImage(key, from: fileUri)
    }

    Function("pruneImages") { (keys: [String]) in
      pruneImages(keys)
    }

    Function("writeCache") { (json: String) -> Bool in
      guard
        let appGroupIdentifier = appGroupIdentifier,
        let defaults = UserDefaults(suiteName: appGroupIdentifier)
      else {
        return false
      }

      defaults.set(json, forKey: cacheKey)
      defaults.set(Date().timeIntervalSince1970, forKey: "\(cacheKey)UpdatedAt")
      defaults.synchronize()
      deleteLegacyAPIKey()

      #if canImport(TVServices)
      TVTopShelfContentProvider.topShelfContentDidChange()
      #endif

      return true
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
      if let directory = artworkDirectory(create: false) {
        try? FileManager.default.removeItem(at: directory)
      }
      deleteLegacyAPIKey()

      #if canImport(TVServices)
      TVTopShelfContentProvider.topShelfContentDidChange()
      #endif

      return true
    }
  }

  private func deleteLegacyAPIKey() {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: apiKeyService,
      kSecAttrAccount as String: apiKeyAccount
    ]
    SecItemDelete(query as CFDictionary)
  }
}
