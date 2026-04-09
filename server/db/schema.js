/**
 * Dual schema verification — run at organ boot to ensure both databases are ready.
 * Cross-validates: every persona_urn in persona_registry has at least version 1
 * in persona_definitions.
 */
import { getMemoryPool } from './memory-pool.js';
import { getEvolutionPool } from './evolution-pool.js';

export async function verifySchema() {
  const results = {};

  // Verify soul_memory
  const memClient = await getMemoryPool().connect();
  try {
    const ext = await memClient.query(
      "SELECT 1 FROM pg_extension WHERE extname = 'vector'"
    );
    if (ext.rows.length === 0) {
      throw new Error('pgvector extension not installed on soul_memory. Run: npm run setup-db');
    }

    const indexes = await memClient.query(`
      SELECT indexname FROM pg_indexes
      WHERE tablename IN ('persona_observations', 'behavioral_patterns',
                          'consistency_checks', 'dream_log')
      ORDER BY indexname
    `);
    results.memory = {
      pgvector: true,
      indexes: indexes.rows.length,
    };
  } finally {
    memClient.release();
  }

  // Verify soul_evolution
  const evoClient = await getEvolutionPool().connect();
  try {
    const indexes = await evoClient.query(`
      SELECT indexname FROM pg_indexes
      WHERE tablename IN ('persona_definitions', 'persona_registry', 'evolution_events')
      ORDER BY indexname
    `);

    // Cross-validate: every registered persona has at least v1
    const orphans = await evoClient.query(`
      SELECT r.vivan_urn FROM persona_registry r
      LEFT JOIN persona_definitions d ON r.vivan_urn = d.vivan_urn AND d.version = 1
      WHERE d.id IS NULL
    `);
    if (orphans.rows.length > 0) {
      const urns = orphans.rows.map(r => r.vivan_urn).join(', ');
      throw new Error(`DUAL_DB_SYNC_ERROR: Registered personas missing v1 definition: ${urns}`);
    }

    results.evolution = {
      indexes: indexes.rows.length,
      cross_validation: 'passed',
    };
  } finally {
    evoClient.release();
  }

  return results;
}
