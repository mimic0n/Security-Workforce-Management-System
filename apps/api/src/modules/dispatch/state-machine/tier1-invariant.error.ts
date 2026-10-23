export class Tier1InvariantError extends Error {
  public readonly postId: string;
  public readonly attemptedStatus: string;

  constructor(postId: string, attemptedStatus: string, details?: string) {
    super(
      `Tier 1 invariant violation on post '${postId}': Tier 1 posts cannot enter state '${attemptedStatus}'. ${
        details || "Zero-Vacancy invariant forbids PLANNED/PAIR states on Tier 1."
      }`
    );
    this.name = "Tier1InvariantError";
    this.postId = postId;
    this.attemptedStatus = attemptedStatus;
  }
}
