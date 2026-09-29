import { createServer } from 'node:net';

/** Reserve a test port across interfaces, then release it for the isolated app. */
export async function phonePortEnv(): Promise<Record<string, string>> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', resolve);
  });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return { ZCC_E2E_MOBILE_PORT: String(port) };
}
