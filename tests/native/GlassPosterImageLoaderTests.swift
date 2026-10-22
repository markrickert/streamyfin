import Foundation

final class PosterURLProtocol: URLProtocol {
  static var requests: [URLRequest] = []
  static var statusCode = 200
  static var redirects: [String: String] = [:]

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    let request = Self.canonicalRequest(for: self.request)
    Self.requests.append(request)

    if let location = Self.redirects[request.url!.absoluteString] {
      let redirect = HTTPURLResponse(
        url: request.url!, statusCode: 302, httpVersion: nil,
        headerFields: ["Location": location]
      )!
      // The real URL loading system redirects by reusing the original request
      // with the Location URL, headers included. Mirror that so the loader's
      // redirect policy is what decides what the follow-up sends.
      var follow = request
      follow.url = URL(string: location)!
      client?.urlProtocol(self, wasRedirectedTo: follow, redirectResponse: redirect)
      return
    }

    let response = HTTPURLResponse(
      url: request.url!, statusCode: Self.statusCode, httpVersion: nil, headerFields: nil
    )!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data([1, 2, 3]))
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {}
}

@main
enum GlassPosterImageLoaderTests {
  static func main() async {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [PosterURLProtocol.self]
    let loader = GlassPosterImageLoader(session: URLSession(configuration: configuration))
    let url = URL(string: "https://jellyfin.example/Items/1/Images/Primary")!
    let headers = ["CF-Access-Client-Id": "secret"]

    let first = await loader.load(url, headers: headers)
    precondition(first == Data([1, 2, 3]))
    precondition(PosterURLProtocol.requests.count == 1)
    precondition(PosterURLProtocol.requests[0].value(forHTTPHeaderField: "CF-Access-Client-Id") == "secret")

    // A remounted poster must not refetch, even when HTTP caching is disabled.
    let cached = await loader.load(url, headers: headers)
    precondition(cached == first)
    precondition(PosterURLProtocol.requests.count == 1)

    let rotated = await loader.load(url, headers: ["CF-Access-Client-Id": "rotated"])
    precondition(rotated != nil)
    precondition(PosterURLProtocol.requests.count == 2)
    precondition(PosterURLProtocol.requests[1].value(forHTTPHeaderField: "CF-Access-Client-Id") == "rotated")

    let unprotected = await loader.load(url, headers: [:])
    precondition(unprotected != nil)
    precondition(PosterURLProtocol.requests.count == 3)
    precondition(PosterURLProtocol.requests[2].value(forHTTPHeaderField: "CF-Access-Client-Id") == nil)

    let publicUrl = URL(string: "https://image.tmdb.org/poster")!
    let publicImage = await loader.load(publicUrl, headers: [:])
    precondition(publicImage != nil)
    precondition(PosterURLProtocol.requests[3].value(forHTTPHeaderField: "CF-Access-Client-Id") == nil)

    // A redirect keeps the proxy credentials only inside the same service:
    // same scheme, host and port. Anything else must go out bare.
    PosterURLProtocol.redirects = [
      "https://jellyfin.example/redirect-cross": "https://cdn.example/poster",
      "https://jellyfin.example/redirect-downgrade": "http://jellyfin.example/poster",
      "https://jellyfin.example/redirect-port": "https://jellyfin.example:8443/poster",
      "https://jellyfin.example/redirect-same": "https://jellyfin.example/poster",
      "https://jellyfin.example/redirect-same-port": "https://JELLYFIN.example:443/poster",
    ]
    let multi = ["CF-Access-Client-Id": "secret", "Authorization": "Bearer token"]

    for name in ["cross", "downgrade", "port"] {
      let loaded = await loader.load(
        URL(string: "https://jellyfin.example/redirect-\(name)")!, headers: multi)
      precondition(loaded != nil)
      let follow = PosterURLProtocol.requests.last!
      precondition(follow.value(forHTTPHeaderField: "CF-Access-Client-Id") == nil, name)
      precondition(follow.value(forHTTPHeaderField: "Authorization") == nil, name)
    }
    precondition(PosterURLProtocol.requests.last!.url!.port == 8443)

    for name in ["same", "same-port"] {
      let loaded = await loader.load(
        URL(string: "https://jellyfin.example/redirect-\(name)")!, headers: multi)
      precondition(loaded != nil)
      let follow = PosterURLProtocol.requests.last!
      precondition(follow.value(forHTTPHeaderField: "CF-Access-Client-Id") == "secret", name)
      precondition(follow.value(forHTTPHeaderField: "Authorization") == "Bearer token", name)
    }
    PosterURLProtocol.redirects = [:]

    // JS sends headers scoped to the URL they were resolved for; the native
    // side must fall back to no headers when the URL does not match.
    let payload = GlassPosterHeaders(
      json: #"{"url":"https://jellyfin.example/Items/1/Images/Primary","headers":{"CF-Access-Client-Id":"secret"}}"#)
    precondition(payload.values(for: url.absoluteString) == ["CF-Access-Client-Id": "secret"])
    precondition(payload.values(for: "https://image.tmdb.org/poster").isEmpty)
    precondition(GlassPosterHeaders(json: #"{"url":null,"headers":{"A":"b"}}"#).values(for: url.absoluteString).isEmpty)
    precondition(GlassPosterHeaders(json: "{}").values(for: url.absoluteString).isEmpty)
    precondition(GlassPosterHeaders(json: "not json").values(for: url.absoluteString).isEmpty)
    precondition(GlassPosterHeaders(json: "") == .none)

    PosterURLProtocol.statusCode = 403
    let deniedUrl = URL(string: "https://jellyfin.example/denied")!
    let denied = await loader.load(deniedUrl, headers: headers)
    let retried = await loader.load(deniedUrl, headers: headers)
    precondition(denied == nil && retried == nil)
    precondition(PosterURLProtocol.requests.count == 16)
    print("PASS: native poster requests use scoped headers and cache successful artwork")
  }
}
