import { BoundedKeyedQueue } from '../bounded-keyed-queue.js';

const queue = new BoundedKeyedQueue(4, 100, 'Too many pending library operations');
/** One selected product server serializes each project's shared library mutations. */
export async function withProjectLibrary<T>(key: string, operation: () => Promise<T>, retainedBytes = 0): Promise<T> {
  return queue.run(key, operation, retainedBytes);
}
export async function withProjectLibraries<T>(keys: readonly string[], operation: () => Promise<T>): Promise<T> {
  return queue.runMany(keys, operation);
}
