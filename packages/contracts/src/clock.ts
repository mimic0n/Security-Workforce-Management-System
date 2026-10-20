export interface Clock {
  now(): Date;
  schedule(at: Date, fn: () => Promise<void> | void, key?: string): () => void;
}
