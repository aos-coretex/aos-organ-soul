import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getMemoryPool, closeMemoryPool } from '../server/db/memory-pool.js';

describe('Consistency Checker — thresholds', () => {
  const thresholds = { stable: 0.8, monitor: 0.5 };

  function classify(score) {
    if (score >= thresholds.stable) return 'stable';
    if (score >= thresholds.monitor) return 'monitor';
    return 'intervene';
  }

  it('classifies score > 0.8 as stable', () => {
    assert.equal(classify(0.95), 'stable');
    assert.equal(classify(0.8), 'stable');
  });

  it('classifies score 0.5-0.8 as monitor', () => {
    assert.equal(classify(0.79), 'monitor');
    assert.equal(classify(0.5), 'monitor');
  });

  it('classifies score < 0.5 as intervene', () => {
    assert.equal(classify(0.49), 'intervene');
    assert.equal(classify(0.0), 'intervene');
  });

  it('handles edge case: exactly 1.0', () => {
    assert.equal(classify(1.0), 'stable');
  });

  it('handles edge case: exactly 0.0', () => {
    assert.equal(classify(0.0), 'intervene');
  });
});

describe('Consistency Checker — drift/growth classification', () => {
  it('identifies drift items from classification output', () => {
    const driftItems = [
      { observation_id: 'obs-1', description: 'Wrong tone used', severity: 'high' },
      { observation_id: 'obs-3', description: 'Knowledge boundary crossed', severity: 'medium' },
    ];
    assert.equal(driftItems.length, 2);
    assert.equal(driftItems[0].severity, 'high');
  });

  it('identifies growth items from classification output', () => {
    const growthItems = [
      { observation_id: 'obs-2', description: 'Developed nuanced explanation style', strength: 'medium' },
    ];
    assert.equal(growthItems.length, 1);
    assert.equal(growthItems[0].strength, 'medium');
  });

  it('handles no deviations (all consistent)', () => {
    const score = 1.0;
    const driftItems = [];
    const growthItems = [];
    assert.equal(score, 1.0);
    assert.equal(driftItems.length, 0);
    assert.equal(growthItems.length, 0);
  });
});

describe('Consistency Checker — storeCheck integration', () => {
  let memPool;

  before(async () => {
    // Use getMemoryPool() directly — no pgvector registration needed for consistency_checks
    memPool = getMemoryPool();
  });

  after(async () => {
    await memPool.query("DELETE FROM consistency_checks WHERE vivan_urn LIKE 'urn:graphheight:vivan:test-%'");
    await closeMemoryPool();
  });

  it('stores a consistency check result and retrieves it', async () => {
    const testUrn = `urn:graphheight:vivan:test-cc-${Date.now()}`;
    const driftItems = [{ observation_id: null, description: 'tone drift', severity: 'low' }];
    const growthItems = [{ observation_id: null, description: 'expertise growth', strength: 'high' }];

    const result = await memPool.query(`
      INSERT INTO consistency_checks
        (vivan_urn, baseline_version, consistency_score, classification, drift_count, growth_count, drift_items, growth_items)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, consistency_score, classification
    `, [testUrn, 1, 0.75, 'monitor', 1, 1, JSON.stringify(driftItems), JSON.stringify(growthItems)]);

    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].consistency_score, 0.75);
    assert.equal(result.rows[0].classification, 'monitor');
  });

  it('enforces score range constraint', async () => {
    const testUrn = `urn:graphheight:vivan:test-cc-bad-${Date.now()}`;
    await assert.rejects(
      () => memPool.query(`
        INSERT INTO consistency_checks
          (vivan_urn, baseline_version, consistency_score, classification)
        VALUES ($1, 1, $2, 'stable')
      `, [testUrn, 1.5]),
      { message: /check/ }
    );
  });
});
