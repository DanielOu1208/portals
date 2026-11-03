// JSON-RPC errors. The app shows `message` to the user as it is, so it is a sentence.

export const ErrorCode = {
  /** The session named is not loaded for this connection: the app resumes it and tries once more. */
  sessionNotLoaded: 4001,
  /** Not for a connection signed in the way this one is (feature net: a method for the person, or for the Macs). */
  notAllowed: 4003,
  /** No thread with that id. */
  notFound: 4007,
  /** Not a command the bridge runs itself: the app asks `command.dispatch` what it stands for. */
  notTerminalCommand: 4018,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export function invalidParams(message: string): RpcError {
  return new RpcError(ErrorCode.invalidParams, message);
}
