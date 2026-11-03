import { randomBytes } from "node:crypto";
import { log } from "../log.ts";

// The questions one session has put to the phone (docs/gateway-protocol.md, section 7).
//
// - A question goes only to the connections that follow the session (created or
//   resumed it) and said they answer questions. The app denies an approval it cannot
//   place, so sending one anywhere else would let a bystander deny the agent.
// - It stays open when those connections drop, and is listed in `open_requests` for
//   whoever resumes the session next. The frame itself is not sent again.
// - The first answer wins. Later ones are ignored. The other followers are then told
//   with `request.cancel` (reason `resolved`), so their cards close; for questions asked
//   without waiting (`async`, feature async_questions), with the `answer` given, which
//   their row shows in place of the message it goes to the agent as.
// - The thread that started this one through the fleet may answer too, following it or
//   not (`answerFor`, feature agent_threads): every follower is told then, and by whom.

/** A connection, as far as questions are concerned. */
export interface Follower {
  /** It declared `server_requests: true` in `client.capabilities`. */
  readonly takesRequests: boolean;
  /**
   * It declared `subagent_requests: true` too (feature subagents): it keeps the card of
   * a question a subagent asks once the turn is over, and can answer it then.
   */
  readonly keepsSubagentRequests?: boolean;
  /**
   * It declared `async_questions: true` too (feature async_questions): it keeps the card
   * of a question an agent asked without waiting once the turn is over, and can answer it then.
   */
  readonly keepsAsyncQuestions?: boolean;
  /** The id the app gave itself (feature answer_owner): `request.cancel` names it as `answered_by` when its answer settled the request. */
  readonly deviceID?: string;
  sendRequest(id: string, method: string, params: Record<string, unknown>): void;
}

/** What came back for a question. */
export type BrokerAnswer =
  | { result: unknown }
  | { error: { code?: number; message?: string } }
  | { withdrawn: string };

export interface OpenRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
  /**
   * Only as a listener is told of it: put again, not asked anew (questions asked without
   * waiting that the bridge found open as it loaded the thread, `Session.askAgain`).
   */
  again?: boolean;
}

interface Waiting extends OpenRequest {
  settle: (answer: BrokerAnswer) => void;
  /** Asked by work that runs on after the turn (a subagent in the background): the turn's end leaves it open. */
  outlivesTurn: boolean;
}

// Request ids are never used twice in one run of the bridge (one replay epoch).
const issued = new Set<string>();

function newRequestID(): string {
  for (;;) {
    const id = `srq-${randomBytes(6).toString("hex")}`;
    if (!issued.has(id)) {
      issued.add(id);
      return id;
    }
  }
}

export interface BrokerOptions {
  sessionID: string;
  /** The connections following the session right now. */
  followers: () => Iterable<Follower>;
  /**
   * Called once a question is settled, to send `request.cancel`: to every follower but
   * `answeredBy`, the connection whose answer settled it. `details` are keys the cancel
   * carries besides: who answered, and how, for an answer not from a follower.
   */
  closed: (id: string, reason: string, answeredBy?: Follower, details?: Record<string, unknown>) => void;
  /** Called once a question has been put to the followers (for notifications). */
  opened?: (request: OpenRequest) => void;
}

export class RequestBroker {
  private readonly options: BrokerOptions;
  private readonly waiting = new Map<string, Waiting>();

  constructor(options: BrokerOptions) {
    this.options = options;
  }

  /**
   * Asks the followers and waits for the first answer. `params` get the session id added.
   * `outlivesTurn`: the one asking may run on after the turn (`withdrawTurn` leaves it).
   */
  ask(method: string, params: Record<string, unknown>, signal?: AbortSignal, outlivesTurn = false): Promise<BrokerAnswer> {
    const id = newRequestID();
    const full = { session_id: this.options.sessionID, ...params };
    return new Promise((resolve) => {
      const onAbort = () => this.withdraw(id, typeof signal?.reason === "string" ? signal.reason : "withdrawn");
      this.waiting.set(id, {
        id,
        method,
        params: full,
        outlivesTurn,
        settle: (answer) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(answer);
        },
      });
      for (const follower of this.options.followers()) {
        if (!follower.takesRequests) continue;
        // One that cannot be sent it costs only itself the question; the others still have it.
        try {
          follower.sendRequest(id, method, full);
        } catch (error) {
          log.error("could not send a question to a device", { session: this.options.sessionID, method, error: (error as Error)?.stack ?? String(error) });
        }
      }
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      this.options.opened?.({ id, method, params: full });
    });
  }

  has(id: string): boolean {
    return this.waiting.has(id);
  }

  /**
   * An answer from a connection. Only a follower's answer counts, and only the first:
   * returns false when the question is settled already or `from` does not follow the
   * session.
   */
  answer(from: Follower, id: string, answer: { result: unknown } | { error: { code?: number; message?: string } }): boolean {
    const waiting = this.waiting.get(id);
    if (!waiting) return false;
    if (![...this.options.followers()].includes(from)) return false;
    // Feature async_questions: the others show the answer, which goes to the agent as a message they show no bubble for.
    const told = waiting.params.async === true && "result" in answer ? { answer: answer.result ?? {} } : undefined;
    this.settle(waiting, answer, "resolved", from, told);
    return true;
  }

  /**
   * An answer from someone who does not follow the session: the thread that started it
   * (feature agent_threads), checked by whoever calls this. Only the first answer counts:
   * false when the question is settled already. Every follower is told it was resolved,
   * with `details` (who answered, and the answer), so their cards close.
   */
  answerFor(id: string, answer: { result: unknown }, details: Record<string, unknown>): boolean {
    const waiting = this.waiting.get(id);
    if (!waiting) return false;
    this.settle(waiting, answer, "resolved", undefined, details);
    return true;
  }

  /** Takes a question back; nobody can answer it any more. */
  withdraw(id: string, reason: string): void {
    const waiting = this.waiting.get(id);
    if (waiting) this.settle(waiting, { withdrawn: reason }, reason);
  }

  withdrawAll(reason: string): void {
    for (const id of [...this.waiting.keys()]) this.withdraw(id, reason);
  }

  /** Takes back the questions of the turn, leaving those asked by work that runs on after it. */
  withdrawTurn(reason: string): void {
    for (const waiting of [...this.waiting.values()]) if (!waiting.outlivesTurn) this.withdraw(waiting.id, reason);
  }

  /** What is waiting, as `open_requests` lists it: the original ids and params. */
  list(): OpenRequest[] {
    return [...this.waiting.values()].map(({ id, method, params }) => ({ id, method, params }));
  }

  private settle(waiting: Waiting, answer: BrokerAnswer, reason: string, answeredBy?: Follower, details?: Record<string, unknown>): void {
    // Recorded and announced in one step, so no second answer can slip in between.
    this.waiting.delete(waiting.id);
    this.options.closed(waiting.id, reason, answeredBy, details);
    waiting.settle(answer);
  }
}
