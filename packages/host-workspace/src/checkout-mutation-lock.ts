import { withQueuedLock } from './process-local-queued-lock.js';

/** Serialize checkouts (`git switch`) on a given working tree. */
export function withCheckoutMutationLock<T>(cwd: string, run: () => Promise<T>): Promise<T> {
  return withQueuedLock(`checkout:${cwd}`, run);
}

/** Shared by file saves and Git discard so their revision checks cannot race. */
export function withFileMutationLock<T>(path: string, run: () => Promise<T>): Promise<T> {
  return withQueuedLock(`file:${path}`, run);
}
