import { startRelay } from './server.mjs';

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const relay = await startRelay({ token: process.env.MOBILE_RELAY_TOKEN, publicUrl: process.env.MOBILE_RELAY_PUBLIC_URL, port });
console.log(`Zana mobile relay listening on port ${relay.port}`);
let closing = false;
async function stop() {
  if (closing) return;
  closing = true;
  await relay.close();
}
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());
