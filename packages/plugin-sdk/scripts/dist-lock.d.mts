/** Serialize a build or package operation with the SDK dist directory lock. */
export function withPluginSdkDistLock<T>(fn: () => T | Promise<T>): Promise<T>;
