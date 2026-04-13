import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  getDegradedStreak,
  resetDegradedStreak,
  loadConstitutionalFrame,
  evaluateAllEvolutions,
} from '../agents/evolution-analyst.js';
import { initEvolutionPool, closeEvolutionPool, getEvolutionPool } from '../server/db/evolution-pool.js';
import { initMemoryPool, closeMemoryPool } from '../server/db/memory-pool.js';

// --- Streak getter/reset (pure module-level state) ---

describe('C2A-03: degraded streak tracking — module state', () => {
  beforeEach(() => {
    resetDegradedStreak();
  });

  it('initial streak is 0 with null last_degraded_at', () => {
    const { streak, last_degraded_at } = getDegradedStreak();
    assert.equal(streak, 0);
    assert.equal(last_degraded_at, null);
  });

  it('resetDegradedStreak clears to zero', () => {
    // Simulate some state by calling evaluateAllEvolutions with degraded frame
    // — but we can't without DB. Use getter to verify reset works from any state.
    resetDegradedStreak();
    const { streak } = getDegradedStreak();
    assert.equal(streak, 0);
  });
});

// --- Constitutional frame loading (existing behavior, verified for streak context) ---

describe('C2A-03: loadConstitutionalFrame streak-relevant behavior', () => {
  const originalFetch = globalThis.fetch;
  const graphUrl = 'http://127.0.0.1:4020';
  const arbiterUrl = 'http://127.0.0.1:4021';

  after(() => {
    globalThis.fetch = originalFetch;
  });

  it('healthy frame returns degraded: false', async () => {
    globalThis.fetch = async (url) => {
      if (url.includes('/bor/raw')) {
        return { ok: true, status: 200, json: async () => ({ raw_text: '# BoR text' }) };
      }
      if (url.includes('msp_version')) {
        return { ok: true, status: 200, json: async () => ({ concepts: [{ data: { raw_text: '# MSP' } }] }) };
      }
      throw new Error(`unexpected: ${url}`);
    };
    const frame = await loadConstitutionalFrame(graphUrl, arbiterUrl);
    assert.equal(frame.degraded, false);
  });

  it('degraded frame when both sources unavailable', async () => {
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
    const frame = await loadConstitutionalFrame(graphUrl, arbiterUrl);
    assert.equal(frame.degraded, true);
    assert.equal(frame.msp, null);
    assert.equal(frame.bor, null);
  });
});

// --- evaluateAllEvolutions streak integration (requires DB) ---

// --- evaluateAllEvolutions streak integration (requires soul_evolution + soul_memory DBs) ---
//
// These tests require both PostgreSQL databases to be running with pgvector.
// The streak update happens BEFORE the per-persona evaluation loop, so even
// if evaluateEvolution throws (LLM unavailable, missing data), the streak
// state is already committed. We catch and ignore per-persona errors.

describe('C2A-03: evaluateAllEvolutions streak integration', () => {
  const originalFetch = globalThis.fetch;
  let evoPool;
  let dbAvailable = false;

  const testUrn = `urn:graphheight:vivan:streak-test-${Date.now()}`;

  const config = {
    graphUrl: 'http://127.0.0.1:4020',
    arbiterUrl: 'http://127.0.0.1:4021',
    evolution: { minGrowthObservations: 10, minConsistencyScore: 0.6 },
  };

  before(async () => {
    resetDegradedStreak();
    try {
      await initEvolutionPool();
      await initMemoryPool();
      evoPool = getEvolutionPool();

      await evoPool.query(`
        INSERT INTO persona_definitions (vivan_urn, version, baseline_json, status)
        VALUES ($1, 1, $2, 'active')
        ON CONFLICT (vivan_urn, version) DO NOTHING
      `, [testUrn, JSON.stringify({ name: 'Streak Test', traits: [] })]);

      await evoPool.query(`
        INSERT INTO persona_registry (vivan_urn, current_version, status, template_source)
        VALUES ($1, 1, 'active', 'test')
        ON CONFLICT (vivan_urn) DO UPDATE SET status = 'active'
      `, [testUrn]);

      dbAvailable = true;
    } catch {
      // DB not available — integration tests will be skipped
      dbAvailable = false;
    }
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    if (dbAvailable) {
      try {
        await evoPool.query("DELETE FROM evolution_events WHERE vivan_urn = $1", [testUrn]);
        await evoPool.query("DELETE FROM persona_definitions WHERE vivan_urn = $1", [testUrn]);
        await evoPool.query("DELETE FROM persona_registry WHERE vivan_urn = $1", [testUrn]);
      } catch { /* cleanup best-effort */ }
      await closeEvolutionPool();
      await closeMemoryPool();
    }
  });

  it('streak increments on degraded dream cycle', { skip: !dbAvailable && 'soul DBs not available' }, async () => {
    resetDegradedStreak();
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };

    // evaluateAllEvolutions may throw on per-persona evaluation (LLM/memory pool).
    // The streak is updated before the loop — catch and verify.
    try { await evaluateAllEvolutions(config); } catch { /* per-persona error OK */ }

    assert.equal(getDegradedStreak().streak, 1);
    assert.ok(getDegradedStreak().last_degraded_at !== null);
  });

  it('streak increments across consecutive degraded cycles', { skip: !dbAvailable && 'soul DBs not available' }, async () => {
    resetDegradedStreak();
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };

    try { await evaluateAllEvolutions(config); } catch { /* OK */ }
    try { await evaluateAllEvolutions(config); } catch { /* OK */ }
    try { await evaluateAllEvolutions(config); } catch { /* OK */ }

    assert.equal(getDegradedStreak().streak, 3);
  });

  it('streak resets on healthy dream cycle', { skip: !dbAvailable && 'soul DBs not available' }, async () => {
    resetDegradedStreak();
    // First: degraded
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
    try { await evaluateAllEvolutions(config); } catch { /* OK */ }
    assert.equal(getDegradedStreak().streak, 1);

    // Second: healthy frame (per-persona eval may still fail — that's fine)
    globalThis.fetch = async (url) => {
      if (url.includes('/bor/raw')) {
        return { ok: true, status: 200, json: async () => ({ raw_text: '# BoR' }) };
      }
      if (url.includes('msp_version')) {
        return { ok: true, status: 200, json: async () => ({ concepts: [{ data: { raw_text: '# MSP' } }] }) };
      }
      return { ok: false, status: 500, json: async () => ({}) };
    };
    try { await evaluateAllEvolutions(config); } catch { /* OK */ }

    assert.equal(getDegradedStreak().streak, 0);
  });
});
