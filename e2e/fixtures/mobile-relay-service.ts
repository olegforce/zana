import { execFileSync } from 'node:child_process';
import { request } from 'node:http';
import { randomUUID } from 'node:crypto';
import { startRelay } from '../../services/mobile-relay/server.mjs';

/** With ZCC_MOBILE_DOCKER_IMAGE, exercise the actual website image, not a substitute server. */
export async function mobileRelayService(publicUrl: string, token: string, port = 0) {
  const image = process.env.ZCC_MOBILE_DOCKER_IMAGE;
  if (!image) return startRelay({ publicUrl, token, host: '127.0.0.1', port });
  const name = `zcc-mobile-e2e-${randomUUID().slice(0, 8)}`;
  const docker = (args: string[]) => execFileSync('docker', args, {
    encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, MOBILE_RELAY_TOKEN: token, MOBILE_RELAY_PUBLIC_URL: publicUrl }
  }).trim();
  docker(['run', '--detach', '--platform', 'linux/amd64', '--name', name, '--publish', `127.0.0.1:${port || ''}:4321`,
    '--env', 'MOBILE_RELAY_TOKEN', '--env', 'MOBILE_RELAY_PUBLIC_URL', image]);
  try {
    const boundPort = Number(docker(['inspect', '--format', '{{(index (index .NetworkSettings.Ports "4321/tcp") 0).HostPort}}', name]));
    return {
      port: boundPort,
      connected: () => new Promise<boolean>(resolve => {
        const req = request({ hostname: '127.0.0.1', port: boundPort, path: '/_relay/health',
          headers: { host: new URL(publicUrl).host, 'x-forwarded-proto': 'https' }, timeout: 2000 }, res => {
          let body = ''; res.on('data', chunk => { body += chunk; });
          res.on('end', () => { try { resolve(JSON.parse(body).connected === true); } catch { resolve(false); } });
        });
        req.on('error', () => resolve(false)); req.on('timeout', () => req.destroy()); req.end();
      }),
      close: async () => { docker(['rm', '--force', name]); }
    };
  } catch (error) { docker(['rm', '--force', name]); throw error; }
}
