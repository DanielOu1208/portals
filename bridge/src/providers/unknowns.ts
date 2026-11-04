// What an agent sends that the bridge does not know is let pass, so that a newer agent
// breaks nothing; the person is told nothing of it. Each kind of it is said once in the
// host's log, so that what a newer agent sends is heard of before it matters, not only
// once something breaks.

/** Tells `report` of each kind it is given, the first time only, unless it is one the bridge lets pass on purpose. */
export class Unknowns {
  private readonly report: (kind: string) => void;
  private readonly known: ReadonlySet<string>;
  private readonly seen = new Set<string>();

  /** `known`: what the bridge knows the agent sends, and lets pass on purpose. */
  constructor(report: (kind: string) => void, known: ReadonlySet<string> = new Set()) {
    this.report = report;
    this.known = known;
  }

  /** Something of kind `kind` was let pass. One with no kind (not a string) says nothing new. */
  note(kind: unknown): void {
    if (typeof kind !== "string" || this.known.has(kind) || this.seen.has(kind)) return;
    this.seen.add(kind);
    this.report(kind);
  }
}
