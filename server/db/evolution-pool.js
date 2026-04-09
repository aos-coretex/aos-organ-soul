/**
 * PostgreSQL connection pool for soul_evolution.
 * Low-volume permanent persona definition database — NEVER pruned.
 * Encapsulated — only Soul accesses this database.
 */
import pg from 'pg';

const { Pool } = pg;

let pool = null;

export function getEvolutionPool() {
  if (!pool) {
    pool = new Pool({
      host: process.env.PGHOST || 'localhost',
      port: parseInt(process.env.PGPORT || '5432', 10),
      database: 'soul_evolution',
      user: process.env.PGUSER || 'graphheight_sys',
      max: 3,
    });
  }
  return pool;
}

export async function initEvolutionPool() {
  const p = getEvolutionPool();

  const client = await p.connect();
  try {
    const tableCheck = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('persona_definitions', 'persona_registry', 'evolution_events')
      ORDER BY table_name
    `);
    const tables = tableCheck.rows.map(r => r.table_name);
    const required = ['evolution_events', 'persona_definitions', 'persona_registry'];
    const missing = required.filter(t => !tables.includes(t));
    if (missing.length > 0) {
      throw new Error(`soul_evolution schema incomplete — missing: [${missing.join(', ')}]. Run: npm run setup-db`);
    }

    const stats = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM persona_registry) AS total_personas,
        (SELECT COUNT(*) FROM persona_registry WHERE status = 'active') AS active_personas,
        (SELECT COUNT(*) FROM persona_definitions) AS total_versions,
        (SELECT COUNT(*) FROM evolution_events) AS total_evolutions
    `);
    return stats.rows[0];
  } finally {
    client.release();
  }
}

export async function closeEvolutionPool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
