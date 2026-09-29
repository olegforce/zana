import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const schema = new URL('./schema.sql', import.meta.url);
const integrationSchema = new URL('../slack/schema.sql', import.meta.url);
const schemaText = async () => (await readFile(schema, 'utf8')) + '\n' + (await readFile(integrationSchema, 'utf8'));

/** The same persistent database as the website's account/session tables. */
export async function openConnectDatabase(url = process.env.DATABASE_URL, { production = process.env.NODE_ENV === 'production' } = {}) {
  if (/^postgres(ql)?:\/\//.test(url ?? '')) {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: url, max: 8, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
    // pg emits idle-client disconnects outside any query promise. Handle that
    // event so a database restart cannot crash the whole relay process.
    pool.on('error', () => console.error('Connect database connection interrupted; reconnecting on the next query.'));
    const query = async (text, values = []) => (await pool.query(text, values)).rows;
    return {
      query,
      async transaction(owner, run) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          // DDL takes the exclusive form before touching tables. Take its shared
          // counterpart first so cleanup/issuance cannot deadlock a migration
          // by acquiring those tables in a different order.
          await client.query("SELECT pg_advisory_xact_lock_shared(hashtext('connect-schema'))");
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [owner]);
          const result = await run(async (text, values = []) => (await client.query(text, values)).rows);
          await client.query('COMMIT');
          return result;
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
      },
      async migrate() {
        const client = await pool.connect();
        try {
          // Serialize both website migrations and Connect DDL across dyno restarts.
          await client.query("SELECT pg_advisory_lock(hashtext('connect-schema'))");
          const { drizzle } = await import('drizzle-orm/node-postgres');
          const { migrate } = await import('drizzle-orm/node-postgres/migrator');
          await migrate(drizzle(client), { migrationsFolder: resolve(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle', 'pg') });
          await client.query(await schemaText());
        } finally {
          try { await client.query("SELECT pg_advisory_unlock(hashtext('connect-schema'))"); } finally { client.release(); }
        }
      },
      close: () => pool.end()
    };
  }
  if (production) throw new Error('Zana Connect requires a persistent Postgres DATABASE_URL in production');
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(url === ':memory:' ? url : resolve((url ?? 'file:./dev.db').replace(/^file:/, '')));
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  let queue = Promise.resolve();
  const serialized = run => {
    const next = queue.then(run);
    queue = next.catch(() => {});
    return next;
  };
  const execute = async (sql, values = []) => {
    const ordered = [];
    const statement = db.prepare(sql.replace(/\$(\d+)/g, (_, index) => { ordered.push(values[Number(index) - 1]); return '?'; }));
    return statement.reader ? statement.all(...ordered) : (statement.run(...ordered), []);
  };
  return {
    query: (sql, values) => serialized(() => execute(sql, values)),
    transaction: (_owner, run) => serialized(async () => {
      db.exec('BEGIN IMMEDIATE');
      try { const value = await run(execute); db.exec('COMMIT'); return value; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    }),
    async migrate() { const sql = await schemaText(); await serialized(() => db.exec(sql)); },
    close: () => serialized(() => db.close())
  };
}
