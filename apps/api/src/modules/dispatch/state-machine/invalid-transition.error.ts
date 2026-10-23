export class InvalidTransitionError extends Error {
  public readonly fromStatus: string;
  public readonly event: string;
  public readonly reason: string;

  constructor(fromStatus: string, event: string, reason?: string) {
    super(
      `Invalid transition: cannot process event '${event}' from state '${fromStatus}'${
        reason ? `: ${reason}` : ""
      }`
    );
    this.name = "InvalidTransitionError";
    this.fromStatus = fromStatus;
    this.event = event;
    this.reason = reason || "Transition not allowed by state machine table";
  }
}
