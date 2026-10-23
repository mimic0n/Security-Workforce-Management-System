export class OptimisticLockError extends Error {
  public readonly postId: string;
  public readonly expectedVersion: number;

  constructor(postId: string, expectedVersion: number) {
    super(
      `Optimistic lock failure on post '${postId}': expected version ${expectedVersion} was concurrently modified`
    );
    this.name = "OptimisticLockError";
    this.postId = postId;
    this.expectedVersion = expectedVersion;
  }
}
