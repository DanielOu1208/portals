import Foundation

/// Plain HTTP requests, small enough to stub in tests.
public protocol HTTPLoader: Sendable {
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

/// `URLSession` as an `HTTPLoader`, with cookies of its own that last as long as it does.
public struct URLSessionHTTPLoader: HTTPLoader {
    private let session: URLSession

    /// - Parameter session: defaults to a new session whose cookies live in memory and
    ///   are shared with nothing else.
    public init(session: URLSession? = nil) {
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.timeoutIntervalForRequest = 20
            self.session = URLSession(configuration: configuration)
        }
    }

    public func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        return (data, http)
    }
}

/// Sign-in for a `hermes serve` reached over a network (the tailnet), with the user name
/// and password set on the host under `dashboard.basic_auth`.
///
/// Signing in (`POST /auth/password-login`) sets session cookies, which the loader
/// keeps. Each WebSocket is then opened with a ticket (`POST /api/auth/ws-ticket`):
/// single use, good for 30 seconds. When the host no longer accepts the session, the
/// authenticator signs in again and asks once more.
public actor PasswordAuthenticator: HermesAuthenticator {
    public struct Credentials: Sendable, Hashable {
        public var username: String
        public var password: String

        public init(username: String, password: String) {
            self.username = username
            self.password = password
        }
    }

    public nonisolated let baseURL: URL
    private let loader: any HTTPLoader
    /// Read at each sign-in, so a password changed in the app is used from then on.
    private let credentials: @Sendable () -> Credentials?
    private var isSignedIn = false

    public init(
        baseURL: URL,
        loader: any HTTPLoader = URLSessionHTTPLoader(),
        credentials: @escaping @Sendable () -> Credentials?
    ) {
        self.baseURL = baseURL
        self.loader = loader
        self.credentials = credentials
    }

    public func webSocketRequest() async throws -> URLRequest {
        let ticket = try await ticket()
        return URLRequest(url: try baseURL.hermesWebSocketURL(query: [URLQueryItem(name: "ticket", value: ticket)]))
    }

    /// The loader carries the session cookies. A session the host no longer accepts is
    /// renewed, and the request sent once more.
    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        if !isSignedIn { try await signIn() }
        let first = try await loader.data(for: request)
        guard first.1.statusCode == 401 else { return first }
        try await signIn()
        return try await loader.data(for: request)
    }

    private func ticket() async throws -> String {
        if isSignedIn, let ticket = try await mintTicket() {
            return ticket
        }
        try await signIn()
        guard let ticket = try await mintTicket() else {
            isSignedIn = false
            throw HermesAuthError.sessionNotAccepted
        }
        return ticket
    }

    private func signIn() async throws {
        guard let credentials = credentials(), !credentials.username.isEmpty, !credentials.password.isEmpty else {
            throw HermesAuthError.missingCredentials
        }
        isSignedIn = false
        let (_, response) = try await post("auth/password-login", [
            "provider": "basic", "username": .string(credentials.username), "password": .string(credentials.password),
        ])
        switch response.statusCode {
        case 200: isSignedIn = true
        case 401: throw HermesAuthError.invalidCredentials
        case 404: throw HermesAuthError.passwordSignInUnavailable
        case 429: throw HermesAuthError.tooManyAttempts
        default: throw HermesAuthError.unexpectedStatus(response.statusCode)
        }
    }

    /// A ticket for one WebSocket, or nil when the host does not accept the session.
    private func mintTicket() async throws -> String? {
        let (data, response) = try await post("api/auth/ws-ticket", [:])
        switch response.statusCode {
        case 200:
            guard let ticket = (try? JSONValue.parse(String(decoding: data, as: UTF8.self)))?["ticket"]?.stringValue, !ticket.isEmpty else {
                throw HermesAuthError.sessionNotAccepted
            }
            return ticket
        case 401, 403:
            isSignedIn = false
            return nil
        default:
            throw HermesAuthError.unexpectedStatus(response.statusCode)
        }
    }

    private func post(_ path: String, _ body: JSONValue) async throws -> (Data, HTTPURLResponse) {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = Data(try body.serialized().utf8)
        return try await loader.data(for: request)
    }
}
