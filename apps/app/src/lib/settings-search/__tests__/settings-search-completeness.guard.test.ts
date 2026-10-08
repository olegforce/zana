import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SETTINGS_SECTIONS } from '@/views/settings/settings-navigation';
import { deriveNavEntries } from '../registry';
import { normalize } from '../corpus';
import { ALLOWED_FILES, ALLOWED_STRINGS } from '../completeness-allowlist';
import { REQUIRE_ALL_SECTIONS, SECTION_SOURCES, SETTINGS_SOURCE_DIRS, type SearchSection } from '../guard-config';
import type { SettingsSearchEntry } from '../types';

// Completeness guard (design §3.5): every user-visible literal in the Settings
// UI must be findable through some entry of its section. Enforced page by page.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Ts = any;

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * TypeScript 7 (the repo's `typescript`) is the native port and exposes no
 * synchronous in-process parser, so find a JS compiler that does (a transitive
 * 5.x/6.x in the pnpm store). Test-only.
 */
function loadTs(): Ts {
  const req = createRequire(import.meta.url);
  const usable = (m: Ts) => (typeof m?.createSourceFile === 'function' ? m : undefined);
  try {
    const direct = usable(req('typescript'));
    if (direct) return direct;
  } catch {
    /* fall through to the pnpm store */
  }
  let dir = SRC_ROOT;
  for (let i = 0; i < 8; i += 1, dir = dirname(dir)) {
    const store = join(dir, 'node_modules', '.pnpm');
    if (!existsSync(store)) continue;
    const candidates = readdirSync(store)
      .filter((d) => /^(typescript@\d|@typescript\+typescript6@)/.test(d))
      .sort()
      .reverse();
    for (const c of candidates) {
      const pkg = c.startsWith('@') ? join('@typescript', 'typescript6') : 'typescript';
      try {
        const found = usable(req(join(store, c, 'node_modules', pkg)));
        if (found) return found;
      } catch {
        /* try next */
      }
    }
  }
  throw new Error('No JS TypeScript compiler with createSourceFile found for the settings-search guard');
}

const ts = loadTs();

/** Settings primitives plus the page-local row components. */
export const ROW_COMPONENTS = new Set([
  'Section', 'Field', 'ToggleSwitch', 'CheckboxField', 'SettingsActionRow', 'ChipField', 'TextArgsField',
  'PField', 'OpenerRow', 'HarnessRow'
]);
const TEXT_ATTRS = new Set(['label', 'title', 'help', 'desc']);

function staticString(node: Ts): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isJsxExpression(node)) return staticString(node.expression);
  if (ts.isParenthesizedExpression(node)) return staticString(node.expression);
  return undefined;
}

function jsxText(node: Ts, out: string[]): void {
  if (ts.isJsxText(node)) {
    out.push(node.text);
    return;
  }
  const str = ts.isJsxExpression(node) ? staticString(node) : undefined;
  if (str !== undefined) {
    out.push(str);
    return;
  }
  ts.forEachChild(node, (c: Ts) => jsxText(c, out));
}

/** Collect the searchable literals from one source text (exported shape for fixtures). */
export function collectLiterals(sourceText: string, fileName = 'fixture.tsx'): string[] {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const add = (raw: string | undefined) => {
    const n = normalize(raw ?? '');
    if (n) out.push(n);
  };

  const visitOptionsArray = (node: Ts) => {
    const walk = (n: Ts) => {
      if (ts.isPropertyAssignment(n) && n.name && (n.name.text === 'label' || n.name.text === 'title')) add(staticString(n.initializer));
      ts.forEachChild(n, walk);
    };
    walk(node);
  };

  const visit = (node: Ts) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sf);
      const isRow = ROW_COMPONENTS.has(tag);
      for (const attr of node.attributes.properties) {
        if (!ts.isJsxAttribute(attr)) continue;
        const name = attr.name.getText(sf);
        if (isRow && TEXT_ATTRS.has(name)) {
          const s = staticString(attr.initializer);
          if (s !== undefined) add(s);
          else if (attr.initializer && ts.isJsxExpression(attr.initializer) && attr.initializer.expression) {
            const parts: string[] = [];
            jsxText(attr.initializer.expression, parts);
            add(parts.join(' '));
          }
        } else if (name === 'options' && attr.initializer) {
          visitOptionsArray(attr.initializer);
        } else if (tag === 'option' && name === 'label') {
          add(staticString(attr.initializer));
        }
      }
    }
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(sf) === 'option') {
      const parts: string[] = [];
      for (const c of node.children) jsxText(c, parts);
      add(parts.join(' '));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...new Set(out)];
}

function listSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name !== '__tests__') walk(full);
      } else if (name.endsWith('.tsx') && !/\.(test|spec)\.tsx$/.test(name)) {
        out.push(relative(SRC_ROOT, full).split(sep).join('/'));
      }
    }
  };
  for (const d of SETTINGS_SOURCE_DIRS) walk(join(SRC_ROOT, d));
  return out.sort();
}

const entryModules = import.meta.glob<{ default?: readonly SettingsSearchEntry[]; entries?: readonly SettingsSearchEntry[] }>(
  '../entries/*.ts',
  { eager: true }
);

function entriesBySection(): Map<string, SettingsSearchEntry[]> {
  const out = new Map<string, SettingsSearchEntry[]>();
  for (const [path, mod] of Object.entries(entryModules)) {
    const section = path.replace(/^.*\//, '').replace(/\.ts$/, '');
    out.set(section, [...(mod.entries ?? mod.default ?? [])]);
  }
  return out;
}

/** Normalised label/help/option texts an entry set can satisfy. */
function haystack(entries: readonly SettingsSearchEntry[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    out.push(normalize(e.label));
    if (e.help) out.push(normalize(e.help));
    for (const o of e.options ?? []) out.push(normalize(o));
  }
  return out;
}

export function findUncovered(literals: readonly string[], entries: readonly SettingsSearchEntry[], allowed: ReadonlySet<string>): string[] {
  const hay = haystack(entries);
  return literals.filter((l) => !allowed.has(l) && !hay.some((h) => h.includes(l)));
}

function allowedFor(section: string): Set<string> {
  return new Set(ALLOWED_STRINGS.filter((a) => a.section === section).map((a) => normalize(a.text)));
}

const navEntries = deriveNavEntries();

function checkSection(section: SearchSection, entries: readonly SettingsSearchEntry[]): string[] {
  const pool = [...navEntries.filter((e) => e.section === section), ...entries];
  const missing: string[] = [];
  for (const file of SECTION_SOURCES[section] ?? []) {
    const full = join(SRC_ROOT, file);
    if (!existsSync(full)) {
      missing.push(`${file}: mapped in guard-config.ts but does not exist`);
      continue;
    }
    for (const l of findUncovered(collectLiterals(readFileSync(full, 'utf8'), file), pool, allowedFor(section))) {
      missing.push(`${file}: "${l}"`);
    }
  }
  return missing;
}

describe('settings-search completeness guard', () => {
  const bySection = entriesBySection();
  const allSections: SearchSection[] = [...SETTINGS_SECTIONS.map((s) => s.id), 'project'];

  it('only enforces sections that have an entries file (REQUIRE_ALL_SECTIONS gates the rest)', () => {
    const problems: string[] = [];
    for (const section of allSections) {
      const entries = bySection.get(section);
      if (!entries) {
        if (REQUIRE_ALL_SECTIONS) problems.push(`missing entries/${section}.ts`);
        continue;
      }
      problems.push(...checkSection(section, entries).map((m) => `[${section}] ${m}`));
    }
    expect(problems).toEqual([]);
  });

  it('knows no entries file for an unknown section', () => {
    for (const section of bySection.keys()) expect(allSections).toContain(section);
  });

  it('maps every scanned source file to a section when REQUIRE_ALL_SECTIONS is on', () => {
    if (!REQUIRE_ALL_SECTIONS) return;
    const mapped = new Set(Object.values(SECTION_SOURCES).flat());
    const allowed = new Set(ALLOWED_FILES.map((a) => a.file));
    const unmapped = listSourceFiles().filter(
      (f) => !mapped.has(f) && !allowed.has(f) && collectLiterals(readFileSync(join(SRC_ROOT, f), 'utf8'), f).length > 0
    );
    expect(unmapped).toEqual([]);
  });

  it('keeps allowlist entries justified', () => {
    for (const a of [...ALLOWED_STRINGS, ...ALLOWED_FILES]) expect(a.reason.trim().length).toBeGreaterThan(10);
  });

  it('keeps every mapped source file on disk', () => {
    for (const files of Object.values(SECTION_SOURCES)) for (const f of files) expect(existsSync(join(SRC_ROOT, f))).toBe(true);
  });

  describe('fixtures', () => {
    const entry = (over: Partial<SettingsSearchEntry>): SettingsSearchEntry => ({
      id: 'x.y', section: 'global', label: 'Theme', kind: 'setting', ...over
    });

    it('collects literals from primitives, help JSX, options and page-local rows', () => {
      const lits = collectLiterals(`
        const a = <Field label="Theme" help={<>Pick <b>a</b> theme</>}>
          <select><option>Dark</option><option label="Light" /></select></Field>;
        const b = <ToggleSwitch label={'Auto close'} desc="Closes idle agents" />;
        const c = <HarnessRow title="Claude" />;
        const d = <SegmentedControl options={[{ label: 'Compact' }]} />;
        const e = <div label="ignored" />;
      `);
      expect(lits).toEqual(expect.arrayContaining(['theme', 'pick a theme', 'dark', 'light', 'auto close', 'closes idle agents', 'claude', 'compact']));
      expect(lits).not.toContain('ignored');
    });

    it('ignores dynamic expressions', () => {
      expect(collectLiterals('const a = <Field label={name} help={`x ${y}`} />;')).toEqual([]);
    });

    it('FAILS when a literal has no entry', () => {
      const lits = collectLiterals('<Field label="Theme" help="Brand new help"/>');
      expect(findUncovered(lits, [entry({})], new Set())).toEqual(['brand new help']);
    });

    it('passes when label, help or options cover the literals (case/diacritics-insensitive)', () => {
      const lits = collectLiterals('<Field label="Thème" help="Pick one"><option>Dark</option></Field>');
      const covered = [entry({ label: 'theme', help: 'Please PICK one now', options: ['dark'] })];
      expect(findUncovered(lits, covered, new Set())).toEqual([]);
    });

    it('lets the allowlist exclude a literal', () => {
      const lits = collectLiterals('<Field label="Theme" help="Internal"/>');
      expect(findUncovered(lits, [entry({})], new Set(['internal']))).toEqual([]);
    });
  });
});
