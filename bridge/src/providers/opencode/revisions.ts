/** Order live changes and overlapping snapshots without retaining old request IDs. */
export class NativeRevisions {
  private clock = 0;
  private readonly reads = new Set<number>();
  private readonly changedAt = new Map<string, number>();

  start(): number {
    const revision = ++this.clock;
    this.reads.add(revision);
    return revision;
  }

  changed(id: string): void {
    const revision = ++this.clock;
    if (this.reads.size) this.changedAt.set(id, revision);
  }

  apply(id: string, revision: number): boolean {
    if ((this.changedAt.get(id) ?? 0) > revision) return false;
    this.changedAt.set(id, revision);
    return true;
  }

  finish(revision: number): void {
    this.reads.delete(revision);
    if (!this.reads.size) this.changedAt.clear();
    else {
      const oldest = Math.min(...this.reads);
      for (const [id, at] of this.changedAt) if (at <= oldest) this.changedAt.delete(id);
    }
  }
}
