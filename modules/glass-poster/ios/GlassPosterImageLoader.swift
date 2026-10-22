import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

final class GlassPosterImageLoader {
  static let shared = GlassPosterImageLoader()

  // The NSCache, not URLCache, is what keeps artwork across card remounts;
  // 32 MB holds several screens of posters without pressuring app memory.
  private static let maxArtworkCacheBytes = 32 * 1024 * 1024

  private let cache = NSCache<NSString, NSData>()
  private let session: URLSession

  init(session: URLSession = .shared) {
    self.session = session
    cache.totalCostLimit = Self.maxArtworkCacheBytes
  }

  func load(_ url: URL, headers: [String: String]) async -> Data? {
    // Header changes must not reuse an image fetched with older credentials.
    let headerSort = headers.keys.sorted().map { "\($0)\u{1}\(headers[$0] ?? "")" }
    let key = ([url.absoluteString] + headerSort).joined(separator: "\u{0}") as NSString
    if let cached = cache.object(forKey: key) {
      return cached as Data
    }

    var request = URLRequest(url: url)
    for (name, value) in headers {
      request.setValue(value, forHTTPHeaderField: name)
    }

    guard let (data, response) = try? await session.data(for: request, delegate: HeaderStrippingRedirectPolicy()),
          let http = response as? HTTPURLResponse,
          (200..<300).contains(http.statusCode) else { return nil }
    cache.setObject(data as NSData, forKey: key, cost: data.count)
    return data
  }
}

/// Headers JS resolved for one image URL, sent as `{ "url": ..., "headers": ... }`.
/// Decoded once when the prop arrives. `values(for:)` hands them out only for the
/// URL they were resolved for, so a payload applied out of order with `imageUrl`
/// falls back to no headers instead of sending another service's credentials.
struct GlassPosterHeaders: Equatable {
  static let none = GlassPosterHeaders(url: nil, values: [:])

  let url: String?
  let values: [String: String]

  init(url: String?, values: [String: String]) {
    self.url = url
    self.values = values
  }

  init(json: String) {
    struct Payload: Decodable {
      let url: String?
      let headers: [String: String]
    }
    guard
      let data = json.data(using: .utf8),
      let payload = try? JSONDecoder().decode(Payload.self, from: data)
    else {
      self = .none
      return
    }
    self.init(url: payload.url, values: payload.headers)
  }

  func values(for imageUrl: String) -> [String: String] {
    url == imageUrl ? values : [:]
  }
}

/// URLSession forwards a request's headers to wherever a redirect points. Proxy
/// credentials must never leave the service of the URL they were resolved for
/// (docs/custom-headers.md), so a redirect to another scheme, host or port goes
/// out bare. A downgrade to http would otherwise send them in plain text.
private final class HeaderStrippingRedirectPolicy: NSObject, URLSessionTaskDelegate {
  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    guard let origin = Self.origin(of: task.originalRequest?.url),
          origin == Self.origin(of: request.url) else {
      var redirected = request
      for name in (task.originalRequest?.allHTTPHeaderFields ?? [:]).keys {
        redirected.setValue(nil, forHTTPHeaderField: name)
      }
      return completionHandler(redirected)
    }
    completionHandler(request)
  }

  private static func origin(of url: URL?) -> String? {
    guard let scheme = url?.scheme?.lowercased(), let host = url?.host?.lowercased() else {
      return nil
    }
    let port = url?.port ?? (scheme == "https" ? 443 : 80)
    return "\(scheme)://\(host):\(port)"
  }
}
