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
  it('defaults to unconfigured and rejects local network setup', () => {
    expect(new MobileConnectionStore().view()).toEqual({ mode: 'unconfigured', hasRelayToken: false });
    expect(() => validate({ mode: 'local', publicUrl: 'bad', relayToken: token })).toThrow('Local-network');
    expect(new MobileConnectionStore(path()).read()).toEqual({ mode: 'unconfigured' });
  });
  it('accepts relay HTTPS origins', () => {
    expect(validate({ mode: 'relay', publicUrl: 'https://example.herokuapp.com', relayToken: token })).toMatchObject({ mode: 'relay', relayToken: token });
  });
  it.each(['tailscale', 'local'])('rejects removed %s configurations without rewriting them or revealing the old address', async mode => {
    const file = path();
    const legacy = JSON.stringify({ mode, publicUrl: 'https://private-machine.example', relayToken: token });
    writeFileSync(file, legacy);
    const store = new MobileConnectionStore(file);
    expect(() => validate(JSON.parse(legacy))).toThrow('Open Remote access');
    expect(() => store.read()).toThrow('connections are no longer supported');
    expect(() => store.view()).toThrow('Open Remote access');
    expect(readFileSync(file, 'utf8')).toBe(legacy);
    await store.write(validate({ mode: 'unconfigured' }, undefined, true));
    expect(new MobileConnectionStore(file).view()).toEqual({ mode: 'unconfigured', hasRelayToken: false });
  });
  it.each([null, {}, { mode: 'unknown' }, { mode: 'relay' }, { mode: 'relay', publicUrl: `https://${'a'.repeat(2048)}` }, { mode: 'relay', publicUrl: 'not a url' },
    { mode: 'tailscale', publicUrl: 'https://private-machine.example' },
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
    await store.write({ mode: 'unconfigured' }); expect(new MobileConnectionStore(file).view().hasRelayToken).toBe(false);
  });
  it('reports malformed and oversized private files without echoing their contents', () => {
    const file = path(); writeFileSync(file, token); expect(() => new MobileConnectionStore(file).read()).toThrow('Could not read phone connection configuration');
    writeFileSync(file, ' '.repeat(4097)); expect(() => new MobileConnectionStore(file).read()).toThrow('Could not read phone connection configuration');
  });
});
