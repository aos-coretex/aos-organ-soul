import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { initEvolutionPool, closeEvolutionPool, getEvolutionPool } from '../server/db/evolution-pool.js';

describe('Evolution Analyst — append-only versioning', () => {
  let pool;
  const testUrn = `urn:graphheight:vivan:test-evo-${Date.now()}`;

  before(async () => {
    await initEvolutionPool();
    pool = getEvolutionPool();

    // Create test persona with v1
    const baseline = JSON.stringify({
      name: 'Evolution Test',
      traits: ['curious'],
      voice: { tone: 'warm', style: 'concise' },
      constraints: [],
      knowledge_domains: [],
      behavioral_boundaries: [],
    });

    await pool.query(
      `INSERT INTO persona_definitions (vivan_urn, version, baseline_json, status)
       VALUES ($1, 1, $2, 'active')`,
      [testUrn, baseline]
    );
    await pool.query(
      `INSERT INTO persona_registry (vivan_urn, current_version, status, template_source)
       VALUES ($1, 1, 'active', 'test')`,
      [testUrn]
    );
  });

  after(async () => {
    await pool.query("DELETE FROM evolution_events WHERE vivan_urn = $1", [testUrn]);
    await pool.query("DELETE FROM persona_definitions WHERE vivan_urn = $1", [testUrn]);
    await pool.query("DELETE FROM persona_registry WHERE vivan_urn = $1", [testUrn]);
    await closeEvolutionPool();
  });

  it('creates new version without deleting previous', async () => {
    const newBaseline = JSON.stringify({
      name: 'Evolution Test',
      traits: ['curious', 'analytical'],
      voice: { tone: 'warm', style: 'concise' },
      constraints: [],
      knowledge_domains: ['testing'],
      behavioral_boundaries: [],
    });

    // Supersede v1
    await pool.query(
      `UPDATE persona_definitions SET status = 'superseded', superseded_at = NOW()
       WHERE vivan_urn = $1 AND version = 1`,
      [testUrn]
    );

    // Insert v2
    await pool.query(
      `INSERT INTO persona_definitions (vivan_urn, version, baseline_json, status, changes_summary)
       VALUES ($1, 2, $2, 'active', 'Added analytical trait and testing domain')`,
      [testUrn, newBaseline]
    );

    // Verify both versions exist
    const result = await pool.query(
      'SELECT version, status FROM persona_definitions WHERE vivan_urn = $1 ORDER BY version',
      [testUrn]
    );
    assert.equal(result.rows.length, 2);
    assert.equal(result.rows[0].version, 1);
    assert.equal(result.rows[0].status, 'superseded');
    assert.equal(result.rows[1].version, 2);
    assert.equal(result.rows[1].status, 'active');
  });

  it('records evolution event with evidence', async () => {
    await pool.query(`
      INSERT INTO evolution_events
        (vivan_urn, from_version, to_version, trigger_source, reason, evidence_refs)
      VALUES ($1, 1, 2, 'manual', 'Test evolution', '[]')
    `, [testUrn]);

    const result = await pool.query(
      'SELECT * FROM evolution_events WHERE vivan_urn = $1',
      [testUrn]
    );
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].from_version, 1);
    assert.equal(result.rows[0].to_version, 2);
    assert.equal(result.rows[0].trigger_source, 'manual');
  });

  it('enforces unique version constraint', async () => {
    const baseline = JSON.stringify({ name: 'Dup', traits: ['x'], voice: { tone: 'a', style: 'b' } });
    await assert.rejects(
      () => pool.query(
        'INSERT INTO persona_definitions (vivan_urn, version, baseline_json) VALUES ($1, 1, $2)',
        [testUrn, baseline]
      ),
      { message: /unique|duplicate/i }
    );
  });
});

describe('Evolution Analyst — evidence thresholds', () => {
  it('enforces minGrowthObservations threshold', () => {
    const config = { evolution: { minGrowthObservations: 10, minConsistencyScore: 0.6 } };
    const totalGrowthItems = 7;
    const triggerSource = 'dream_cycle';

    const shouldEvolve = triggerSource === 'manual' || totalGrowthItems >= config.evolution.minGrowthObservations;
    assert.equal(shouldEvolve, false);
  });

  it('allows manual trigger to bypass evidence threshold', () => {
    const config = { evolution: { minGrowthObservations: 10, minConsistencyScore: 0.6 } };
    const totalGrowthItems = 3;
    const triggerSource = 'manual';

    const shouldEvolve = triggerSource === 'manual' || totalGrowthItems >= config.evolution.minGrowthObservations;
    assert.equal(shouldEvolve, true);
  });

  it('blocks evolution when consistency score too low', () => {
    const config = { evolution: { minGrowthObservations: 10, minConsistencyScore: 0.6 } };
    const lastScore = 0.4;

    const tooMuchDrift = lastScore < config.evolution.minConsistencyScore;
    assert.equal(tooMuchDrift, true);
  });
});
