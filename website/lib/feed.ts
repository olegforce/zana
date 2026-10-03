/**
 * Public served-feed projection (design §6) — turns the `releases` table into
 * the EXACT `RegistryIndex` shape the FROZEN desktop client reads via
 * `fetchRegistryIndex()` (`apps/server/src/services/extensions/extension-registry.ts`) and the website's
 * own `fetchCatalog()` (`lib/registry.ts`). Both gate on `schema === 1 &&
 * Array.isArray(releases)`, so `buildIndex()` must always satisfy that.
 *
 * Two responsibilities live here (kept together since both use
 * the release schema and the same DB access):
 *   - `buildIndex()` → the metadata-only `index.json` body (never archive
 *     bytes — that's what keeps it under the 1 MiB cap, design §6).
 *   - `findArchiveByFilename()` → the exact archive-bytes lookup for
 *     `/extensions/archives/[file]`, matched by DB row (not by parsing the
 *     filename) since an extension id may itself contain `-` characters and a
 *     naive `lastIndexOf('-')` split is ambiguous.
 */
import { sql } from 'drizzle-orm';
import { getDb } from './db/index.ts';
// `@zana-ai/zcc-extension-sdk` (packages/extension-sdk) is not a dependency of
// `website/` (not in the root npm workspace glob, not in package.json) —
// `lib/registry.ts` already established the precedent of a LOCALLY MIRRORED
// type instead of importing the SDK package; reuse that same mirror here so
// there's exactly one copy of the shape inside `website/`.
import type { RegistryIndex, RegistryRelease } from './registry.ts';

/** Explicit metadata projection: index requests must never materialize archive blobs. */
function metadataColumns<T extends typeof import('./db/schema.sqlite.ts').releases | typeof import('./db/schema.pg.ts').releases>(table: T): Pick<T, 'extensionId' | 'version' | 'zccApi' | 'sha256' | 'signature' | 'permissions' | 'title' | 'description' | 'author' | 'icon'> {
  return {
    extensionId: table.extensionId, version: table.version, zccApi: table.zccApi,
    sha256: table.sha256, signature: table.signature, permissions: table.permissions,
    title: table.title, description: table.description, author: table.author, icon: table.icon
  } as Pick<T, 'extensionId' | 'version' | 'zccApi' | 'sha256' | 'signature' | 'permissions' | 'title' | 'description' | 'author' | 'icon'>;
}

async function fetchReleaseMetadata() {
  const conn = await getDb();
  if (conn.dialect === 'pg') return conn.db.select(metadataColumns(conn.schema.releases)).from(conn.schema.releases);
  return conn.db.select(metadataColumns(conn.schema.releases)).from(conn.schema.releases);
}

/** Design §6 guard: the index carries metadata only, never archive bytes. */
export const INDEX_MAX_BYTES = 1 * 1024 * 1024;

/** Base URL this deployment is served from; used to build `release.url` values. */
function publicBaseUrl(): string {
  return (process.env.PUBLIC_BASE_URL ?? 'http://localhost:4321').replace(/\/+$/, '');
}

/** The archive filename a release row projects to: `<id>-<version>.json`. */
export function archiveFilename(extensionId: string, version: string): string {
  return `${extensionId}-${version}.json`;
}

/**
 * Project one `releases` row to a `RegistryRelease`, omitting undefined/null
 * optional fields entirely (never emitting e.g. `"title": null`) — mirrors
 * the `...(cond ? {…} : {})` spread pattern from design §6.
 */
function toRegistryRelease(row: {
  extensionId: string;
  version: string;
  zccApi: string;
  sha256: string;
  signature: string;
  permissions: string | null;
  title: string | null;
  description: string | null;
  author: string | null;
  icon: string | null;
}): RegistryRelease {
  const base = publicBaseUrl();
  const release: RegistryRelease = {
    id: row.extensionId,
    version: row.version,
    zccApi: row.zccApi,
    url: `${base}/extensions/archives/${archiveFilename(row.extensionId, row.version)}`,
    sha256: row.sha256,
    signature: row.signature
  };
  if (row.permissions) {
    try {
      release.permissions = JSON.parse(row.permissions);
    } catch {
      // Malformed stored JSON — omit rather than serve a broken permissions
      // field; the release still round-trips (sha256/signature untouched).
    }
  }
  if (row.title) release.title = row.title;
  if (row.description) release.description = row.description;
  if (row.author) release.author = row.author;
  if (row.icon) release.icon = row.icon;
  return release;
}

/**
 * Read ALL `releases` rows and project them onto the public `RegistryIndex`
 * (`{ schema: 1, releases: RegistryRelease[] }`). Emits every version per id —
 * the client (`pickBestRelease`) picks the best; never-downgrade + permission
 * consent live entirely client-side (design §6).
 *
 * PAGING TODO: at thousands of releases this could approach the 1 MiB cap
 * (`INDEX_MAX_BYTES`) enforced by the client's `fetchRegistryIndex` — if that
 * ever happens, split into per-id or cursor-paged index shards. Metadata-only
 * rows keep this comfortably under cap for any realistic near-term catalog
 * size (design §6 guard).
 */
export async function buildIndex(): Promise<RegistryIndex> {
  const rows = await fetchReleaseMetadata();
  const releases = rows.map(toRegistryRelease);
  return { schema: 1, releases };
}

/**
 * Look up one release's raw archive bytes by the `<id>-<version>.json`
 * filename requested at `/extensions/archives/[file]`. Matches against actual
 * an indexed filename expression rather than
 * parsing the filename — an extension id may itself contain `-`, and version
 * is semver-ish, so a naive split is ambiguous. Returns `null` when no row's
 * filename matches (the route responds 404).
 */
export async function findArchiveByFilename(file: string): Promise<Buffer | null> {
  const conn = await getDb();
  const table = conn.schema.releases;
  // This expression matches the indexed filename exactly without ambiguous
  // splitting of ids or prerelease versions. Fetch at most one archive.
  const match = sql`${table.extensionId} || '-' || ${table.version} || '.json' = ${file}`;
  const rows = conn.dialect === 'pg'
    ? await conn.db.select({ archiveBytes: conn.schema.releases.archiveBytes }).from(conn.schema.releases).where(match).limit(1)
    : await conn.db.select({ archiveBytes: conn.schema.releases.archiveBytes }).from(conn.schema.releases).where(match).limit(1);
  const row = rows[0];
  return row ? Buffer.isBuffer(row.archiveBytes) ? row.archiveBytes : Buffer.from(row.archiveBytes) : null;
}
