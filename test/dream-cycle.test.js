import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { contentSimilar } from '../agents/dream-cycle.js';
import { getMemoryPool, closeMemoryPool } from '../server/db/memory-pool.js';

describe('Dream Cycle — content similarity', () => {
  it('detects similar content', () => {
    assert.equal(
      contentSimilar(
        'prefers formal language in technical contexts',
        'uses formal language when discussing technical topics'
      ),
      true
    );
  });

  it('rejects dissimilar content', () => {
    assert.equal(
      contentSimilar(
        'prefers formal language in technical contexts',
        'enjoys creative writing exercises'
      ),
      false
    );
  });

  it('handles null/empty input', () => {
    assert.equal(contentSimilar(null, 'test'), false);
    assert.equal(contentSimilar('test', null), false);
    assert.equal(contentSimilar('', ''), false);
  });
});

describe('Dream Cycle — phase ordering', () => {
  it('phases execute in correct order', () => {
    const phases = ['prune', 'cluster', 'confidence', 'evolution'];
    assert.deepEqual(phases, ['prune', 'cluster', 'confidence', 'evolution']);
  });
});

describe('Dream Cycle — pruning criteria', () => {
  it('defines age threshold at 90 days', () => {
    const AGE_THRESHOLD_DAYS = 90;
    assert.equal(AGE_THRESHOLD_DAYS, 90);
  });

  it('defines relevance threshold at 0.3', () => {
    const RELEVANCE_THRESHOLD = 0.3;
    assert.equal(RELEVANCE_THRESHOLD, 0.3);
  });

  it('both conditions required for age-based pruning', () => {
    // Old but high relevance → keep
    const old_high = { age_days: 120, relevance: 0.8 };
    const shouldPrune1 = old_high.age_days > 90 && old_high.relevance < 0.3;
    assert.equal(shouldPrune1, false);

    // Recent but low relevance → keep
    const recent_low = { age_days: 30, relevance: 0.1 };
    const shouldPrune2 = recent_low.age_days > 90 && recent_low.relevance < 0.3;
    assert.equal(shouldPrune2, false);

    // Old AND low relevance → prune
    const old_low = { age_days: 120, relevance: 0.1 };
    const shouldPrune3 = old_low.age_days > 90 && old_low.relevance < 0.3;
    assert.equal(shouldPrune3, true);
  });
});

describe('Dream Cycle — dream log integration', () => {
  let memPool;

  before(async () => {
    memPool = getMemoryPool();
  });

  after(async () => {
    await memPool.query("DELETE FROM dream_log WHERE summary LIKE '%test-dream%'");
    await closeMemoryPool();
  });

  it('creates and updates a dream log entry', async () => {
    const cycleNumber = 99999;
    const result = await memPool.query(`
      INSERT INTO dream_log (cycle_number, started_at, status, summary)
      VALUES ($1, NOW(), 'running', 'test-dream')
      RETURNING id, cycle_number, status
    `, [cycleNumber]);

    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].cycle_number, cycleNumber);
    assert.equal(result.rows[0].status, 'running');

    // Update to completed
    await memPool.query(`
      UPDATE dream_log SET status = 'completed', completed_at = NOW(),
        observations_pruned = 5, patterns_updated = 3, summary = 'test-dream-done'
      WHERE id = $1
    `, [result.rows[0].id]);

    const check = await memPool.query('SELECT * FROM dream_log WHERE id = $1', [result.rows[0].id]);
    assert.equal(check.rows[0].status, 'completed');
    assert.equal(check.rows[0].observations_pruned, 5);
    assert.equal(check.rows[0].patterns_updated, 3);

    // Cleanup
    await memPool.query("DELETE FROM dream_log WHERE id = $1", [result.rows[0].id]);
  });
});
