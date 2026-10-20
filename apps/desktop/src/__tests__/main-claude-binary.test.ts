import { describe, it, expect } from 'vitest';
import type { AppConfig } from '@zana-ai/zcc-domain/product';
import { mainClaudeBinary, mainClaudeBinaryGetter } from '../main-claude-binary.js';

const cfg = (c: unknown): AppConfig => c as AppConfig;

describe('mainClaudeBinary', () => {
  it('prefers the canonical harness binary over the flat field', () => {
    expect(mainClaudeBinary(cfg({ claudeBinary: '/flat', harnesses: { byId: { claude: { binary: '/canon' } } } }))).toBe('/canon');
  });
  it('uses the flat field when there is no canonical binary', () => {
    expect(mainClaudeBinary(cfg({ claudeBinary: '/flat', harnesses: { byId: { claude: {} } } }))).toBe('/flat');
  });
  it('trims whitespace', () => {
    expect(mainClaudeBinary(cfg({ claudeBinary: '  /flat  ' }))).toBe('/flat');
  });
  it('defaults to claude for an empty config', () => {
    expect(mainClaudeBinary(cfg({}))).toBe('claude');
  });
});

describe('mainClaudeBinaryGetter', () => {
  it('re-reads the store on every call', () => {
    let current = cfg({ claudeBinary: '/one' });
    const get = mainClaudeBinaryGetter({ getConfig: () => current });
    expect(get()).toBe('/one');
    current = cfg({ claudeBinary: '/two' });
    expect(get()).toBe('/two');
  });
});
