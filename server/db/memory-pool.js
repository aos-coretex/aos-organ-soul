/**
 * PostgreSQL connection pool for soul_memory.
 * High-volume behavioral observation database — prunable via dream cycle.
 * Encapsulated — only Soul accesses this database.
 */
import pg from 'pg';
import pgvector from 'pgvector/pg';

const { Pool } = pg;

let pool = null;

export function getMemoryPool() {
  if (!pool) {
    pool = new Pool({
      host: process.env.PGHOST || 'localhost',
      port: parseInt(process.env.PGPORT || '5432', 10),
      database: 'soul_memory',
      user: process.env.PGUSER || 'graphheight_sys',
      max: 3,
    });
  }
  return pool;
}

export async function initMemoryPool() {
  const p = getMemoryPool();

  // Register pgvector type handler
  await pgvector.registerTypes(p);

  // Verify connectivity and schema
  const client = await p.connect();
  try {
    const tableCheck = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('persona_observations', 'behavioral_patterns',
                           'consistency_checks', 'dream_log')
      ORDER BY table_name
    `);
    const tables = tableCheck.rows.map(r => r.table_name);
    const required = ['behavioral_patterns', 'consistency_checks', 'dream_log', 'persona_observations'];
    const missing = required.filter(t => !tables.includes(t));
    if (missing.length > 0) {
      throw new Error(`soul_memory schema incomplete — missing: [${missing.join(', ')}]. Run: npm run setup-db`);
    }

    const stats = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM persona_observations) AS total_observations,
        (SELECT COUNT(*) FROM behavioral_patterns) AS total_patterns,
        (SELECT COUNT(*) FROM consistency_checks) AS total_checks,
        (SELECT COUNT(*) FROM persona_observations WHERE embedding IS NOT NULL) AS embedded_observations
    `);
    return stats.rows[0];
  } finally {
    client.release();
  }
}

export async function closeMemoryPool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
