import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MobileConnectionStore, validateMobileConnection as validate } from './connection.js';

const dirs: string[] = [];
const token = 'x'.repeat(43);
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function path() { const dir = mkdtempSync(join(tmpdir(), 'mobile-settings-')); dirs.push(dir); return join(dir, 'connection.json'); }
describe('phone connection configuration', () => {
  it('keeps local as the default and strips irrelevant URLs/secrets', () => {
    expect(new MobileConnectionStore().view()).toEqual({ mode: 'local', hasRelayToken: false });
    expect(validate({ mode: 'local', publicUrl: 'bad', relayToken: token })).toEqual({ mode: 'local' });
    expect(new MobileConnectionStore(path()).read()).toEqual({ mode: 'local' });
  });
  it('accepts private Tailscale HTTPS origins and relay HTTPS origins', () => {
    expect(validate({ mode: 'tailscale', publicUrl: 'https://mac.test.ts.net/' })).toEqual({ mode: 'tailscale', publicUrl: 'https://mac.test.ts.net' });
    expect(validate({ mode: 'relay', publicUrl: 'https://example.herokuapp.com', relayToken: token })).toMatchObject({ mode: 'relay', relayToken: token });
  });
  it.each([null, {}, { mode: 'unknown' }, { mode: 'relay' }, { mode: 'relay', publicUrl: `https://${'a'.repeat(2048)}` }, { mode: 'relay', publicUrl: 'not a url' },
    { mode: 'tailscale', publicUrl: 'https://public.example' }, { mode: 'tailscale', publicUrl: 'https://ts.net' },
    ...['http://example.test', 'https://user:pass@example.test', 'https://example.test/path', 'https://example.test?q=x', 'https://example.test#x'].map(publicUrl => ({ mode: 'relay', publicUrl, relayToken: token })),
    { mode: 'relay', publicUrl: 'https://example.test', relayToken: 'short' }])('rejects malformed or unsafe configuration %#', input => { expect(() => validate(input)).toThrow(); });
  it('only reuses a saved secret for the same relay origin', () => {
    const previous = validate({ mode: 'relay', publicUrl: 'https://one.test', relayToken: token });
    expect(validate({ mode: 'relay', publicUrl: 'https://one.test', relayToken: '' }, previous).relayToken).toBe(token);
    expect(() => validate({ mode: 'relay', publicUrl: 'https://two.test' }, previous)).toThrow(/secret/);
  });
  it('persists privately and never returns the secret in its public view', async () => {
    const file = path(); const store = new MobileConnectionStore(file);
    await store.write(validate({ mode: 'relay', publicUrl: 'https://one.test', relayToken: token }));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8')).relayToken).toBe(token);
    expect(JSON.stringify(store.view())).not.toContain(token);
    expect(new MobileConnectionStore(file).view()).toEqual({ mode: 'relay', publicUrl: 'https://one.test', hasRelayToken: true });
    await store.write({ mode: 'local' }); expect(new MobileConnectionStore(file).view().hasRelayToken).toBe(false);
  });
  it('reports malformed and oversized private files without echoing their contents', () => {
    const file = path(); writeFileSync(file, token); expect(() => new MobileConnectionStore(file).read()).toThrow('Could not read phone connection configuration');
    writeFileSync(file, ' '.repeat(4097)); expect(() => new MobileConnectionStore(file).read()).toThrow('Could not read phone connection configuration');
  });
});
