import Foundation

/// Sign-in for a Mac of the device's net (a Portals bridge's `net`): the device's token,
/// as `Authorization: Bearer`, on the WebSocket's upgrade and on every REST call. No
/// password, no session and no ticket: one round trip fewer on every connection, and no
/// sign-in after the app is launched again.
public struct TokenAuthenticator: HermesAuthenticator {
    public let baseURL: URL
    private let loader: any HTTPLoader
    /// Read at each use: the device may join another net meanwhile.
    private let token: @Sendable () -> String?

    public init(baseURL: URL, loader: any HTTPLoader = URLSessionHTTPLoader(), token: @escaping @Sendable () -> String?) {
        self.baseURL = baseURL
        self.loader = loader
        self.token = token
    }

    public func webSocketRequest() async throws -> URLRequest {
        try authorized(URLRequest(url: try baseURL.hermesWebSocketURL(query: [])))
    }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        try await loader.data(for: try authorized(request))
    }

    /// The request with the token on it.
    func authorized(_ request: URLRequest) throws -> URLRequest {
        guard let token = token(), !token.isEmpty else { throw HermesAuthError.missingCredentials }
        var request = request
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return request
    }
}
