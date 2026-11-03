import Foundation

/// How a client proves itself to one `hermes serve`.
public protocol HermesAuthenticator: Sendable {
    /// Where the host's `hermes serve` answers.
    nonisolated var baseURL: URL { get }
    /// A request that opens `/api/ws`, with a fresh credential.
    func webSocketRequest() async throws -> URLRequest
    /// Sends a REST request to the host with the credential on it.
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public enum HermesAuthError: Error, Sendable, Hashable {
    /// The server did not hand out a session token. It is either not a headless
    /// `hermes serve`, or it requires a login.
    case tokenNotFound
    case unexpectedStatus(Int)
    case invalidBaseURL
    /// No user name or password is stored for the host.
    case missingCredentials
    /// The host rejected the user name or the password.
    case invalidCredentials
    /// The host has no user name and password set up (`dashboard.basic_auth`).
    case passwordSignInUnavailable
    /// The host is rate-limiting sign-in attempts.
    case tooManyAttempts
    /// Signed in, yet the host still refused the session.
    case sessionNotAccepted
}

extension HermesAuthError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .tokenNotFound: "The host did not offer a session. Is it running, and set up to work without a sign-in?"
        case let .unexpectedStatus(status): "The host answered with HTTP \(status)."
        case .invalidBaseURL: "The host's address is not a valid URL."
        case .missingCredentials: "No user name and password are saved for this host."
        case .invalidCredentials: "The host did not accept the user name or password."
        case .passwordSignInUnavailable: "The host has no user name and password set up."
        case .tooManyAttempts: "Too many sign-in attempts. Try again in a minute."
        case .sessionNotAccepted: "The host did not accept the sign-in."
        }
    }
}

extension URL {
    /// The `/api/ws` URL for a Hermes base URL: `http` becomes `ws`, `https` becomes `wss`.
    /// No query at all for none (a token goes in a header).
    func hermesWebSocketURL(query: [URLQueryItem]) throws -> URL {
        guard var components = URLComponents(url: self, resolvingAgainstBaseURL: false) else {
            throw HermesAuthError.invalidBaseURL
        }
        switch components.scheme?.lowercased() {
        case "http": components.scheme = "ws"
        case "https": components.scheme = "wss"
        case "ws", "wss": break
        default: throw HermesAuthError.invalidBaseURL
        }
        let base = components.path.hasSuffix("/") ? String(components.path.dropLast()) : components.path
        components.path = base + "/api/ws"
        components.queryItems = query.isEmpty ? nil : query
        guard let url = components.url else { throw HermesAuthError.invalidBaseURL }
        return url
    }
}

/// The login-free path for a `hermes serve` bound to loopback: the server hands its
/// per-process session token to any loopback caller at `GET /`.
///
/// This works from the simulator and from tools on the same Mac. It cannot work from a
/// phone: the server only accepts loopback peers on this path.
public struct LoopbackTokenAuthenticator: HermesAuthenticator {
    public var baseURL: URL
    /// Skips the fetch, for a server started with `HERMES_DASHBOARD_SESSION_TOKEN`.
    public var fixedToken: String?
    private let session: URLSession

    public init(baseURL: URL, fixedToken: String? = nil, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.fixedToken = fixedToken
        self.session = session
    }

    public func webSocketRequest() async throws -> URLRequest {
        let token = try await token()
        return URLRequest(url: try baseURL.hermesWebSocketURL(query: [URLQueryItem(name: "token", value: token)]))
    }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: try await authorized(request))
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        return (data, http)
    }

    /// The request with the session token on it.
    func authorized(_ request: URLRequest) async throws -> URLRequest {
        var request = request
        request.setValue(try await token(), forHTTPHeaderField: "X-Hermes-Session-Token")
        return request
    }

    /// The token changes every time the server restarts, so it is read on each use.
    func token() async throws -> String {
        if let fixedToken { return fixedToken }
        var request = URLRequest(url: baseURL)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await session.data(for: request)
        if let status = (response as? HTTPURLResponse)?.statusCode, status != 200 {
            throw HermesAuthError.unexpectedStatus(status)
        }
        guard let token = Self.token(inPage: String(decoding: data, as: UTF8.self)) else {
            throw HermesAuthError.tokenNotFound
        }
        return token
    }

    /// Reads `window.__HERMES_SESSION_TOKEN__="…";` from the page a headless serve
    /// returns at its root. The value is a JSON string literal.
    static func token(inPage page: String) -> String? {
        let pattern = /window\.__HERMES_SESSION_TOKEN__\s*=\s*("(?:[^"\\]|\\.)*")/
        guard let match = page.firstMatch(of: pattern) else { return nil }
        let token = try? JSONDecoder().decode(String.self, from: Data(match.1.utf8))
        return token?.isEmpty == false ? token : nil
    }
}
