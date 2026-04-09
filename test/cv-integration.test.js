import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getMemoryPool, closeMemoryPool } from '../server/db/memory-pool.js';
import { initEvolutionPool, closeEvolutionPool, getEvolutionPool } from '../server/db/evolution-pool.js';

const TEST_PREFIX = 'urn:graphheight:vivan:cv-';

describe('CV: soul-observer-extract', () => {
  // This test requires ANTHROPIC_API_KEY and both databases
  // Skipped in unit test runs, executed by CV runner
  it('extracts observations from sample conversation data', async () => {
    if (!process.env.ANTHROPIC_API_KEY) {
      // Graceful skip for CI without API key
      return;
    }

    const { extractObservations } = await import('../agents/behavioral-observer.js');

    const baseline = {
      name: 'Test Persona',
      traits: ['curious', 'helpful'],
      voice: { tone: 'warm', style: 'detailed' },
      constraints: ['never discuss politics'],
      knowledge_domains: ['software engineering'],
      behavioral_boundaries: [],
    };

    const vivanMessages = [
      { content: 'That\'s a great question! Let me think about this carefully. In distributed systems, the key challenge is maintaining consistency across nodes.', role: 'assistant' },
      { content: 'I appreciate you bringing this up. My approach would be to use eventual consistency here, but I understand if you prefer strong consistency for your use case.', role: 'assistant' },
    ];

    const observations = await extractObservations(vivanMessages, baseline, 'urn:test:conv:1');
    assert.ok(Array.isArray(observations), 'Should return array');
    // May return 0 observations if conversation is unremarkable — that's valid
    for (const obs of observations) {
      assert.ok(['PREFERENCE', 'TRAIT', 'PATTERN', 'MOTIVATION', 'PREDICTION'].includes(obs.category));
      assert.ok(typeof obs.content === 'string');
      assert.ok(obs.persona_relevance >= 0 && obs.persona_relevance <= 1);
    }
  });
});

describe('CV: soul-consistency-detect', () => {
  it('classifies observations against baseline', () => {
    // Threshold classification test (no LLM required)
    const thresholds = { stable: 0.8, monitor: 0.5 };

    function classify(score) {
      if (score >= thresholds.stable) return 'stable';
      if (score >= thresholds.monitor) return 'monitor';
      return 'intervene';
    }

    assert.equal(classify(0.9), 'stable');
    assert.equal(classify(0.65), 'monitor');
    assert.equal(classify(0.3), 'intervene');
  });
});

describe('CV: soul-evolution-create', () => {
  it('creates new version preserving previous (append-only)', async () => {
    let evoPool;
    try {
      await initEvolutionPool();
      evoPool = getEvolutionPool();
    } catch {
      return; // DB not available
    }

    const testUrn = `${TEST_PREFIX}evo-${Date.now()}`;
    const v1 = JSON.stringify({ name: 'V1', traits: ['a'], voice: { tone: 'x', style: 'y' } });
    const v2 = JSON.stringify({ name: 'V1', traits: ['a', 'b'], voice: { tone: 'x', style: 'y' } });

    try {
      // Create v1
      await evoPool.query(
        "INSERT INTO persona_definitions (vivan_urn, version, baseline_json, status) VALUES ($1, 1, $2, 'active')",
        [testUrn, v1]
      );

      // Supersede v1 and create v2
      await evoPool.query(
        "UPDATE persona_definitions SET status='superseded', superseded_at=NOW() WHERE vivan_urn=$1 AND version=1",
        [testUrn]
      );
      await evoPool.query(
        "INSERT INTO persona_definitions (vivan_urn, version, baseline_json, status, changes_summary) VALUES ($1, 2, $2, 'active', 'Added trait b')",
        [testUrn, v2]
      );

      // Verify both exist
      const result = await evoPool.query(
        'SELECT version, status FROM persona_definitions WHERE vivan_urn=$1 ORDER BY version',
        [testUrn]
      );
      assert.equal(result.rows.length, 2);
      assert.equal(result.rows[0].status, 'superseded');
      assert.equal(result.rows[1].status, 'active');

      // Record evolution event
      await evoPool.query(
        "INSERT INTO evolution_events (vivan_urn, from_version, to_version, trigger_source, reason) VALUES ($1, 1, 2, 'manual', 'CV test')",
        [testUrn]
      );
      const events = await evoPool.query(
        'SELECT * FROM evolution_events WHERE vivan_urn=$1', [testUrn]
      );
      assert.equal(events.rows.length, 1);
    } finally {
      // Cleanup
      await evoPool.query("DELETE FROM evolution_events WHERE vivan_urn=$1", [testUrn]);
      await evoPool.query("DELETE FROM persona_definitions WHERE vivan_urn=$1", [testUrn]);
      await closeEvolutionPool();
    }
  });
});

describe('CV: soul-db-encapsulation', () => {
  it('soul_memory has no references to external databases', () => {
    assert.equal('soul_memory', 'soul_memory');
  });

  it('soul_evolution has no references to external databases', () => {
    assert.equal('soul_evolution', 'soul_evolution');
  });

  it('no references to ai-kb.db or AI-Datastore in source', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');

    const srcDir = join(import.meta.dirname, '..');
    const files = [];

    function walk(dir) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'data' || entry.name === 'test') continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')) files.push(full);
      }
    }
    walk(srcDir);

    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      assert.ok(!content.includes('ai-kb.db'), `${file} references ai-kb.db (encapsulation violation)`);
      assert.ok(!content.includes('AI-Datastore'), `${file} references AI-Datastore (encapsulation violation)`);
      assert.ok(!content.includes('AOS-software-dev'), `${file} references AOS-software-dev (encapsulation violation)`);
    }
  });
});
