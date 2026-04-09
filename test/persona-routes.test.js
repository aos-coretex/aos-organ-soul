import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { initEvolutionPool, closeEvolutionPool, getEvolutionPool } from '../server/db/evolution-pool.js';

/**
 * Integration tests for persona routes.
 * Requires: soul_evolution database running on localhost:5432.
 * These tests hit the real database.
 */
describe('Persona Routes (integration)', () => {
  let pool;

  before(async () => {
    await initEvolutionPool();
    pool = getEvolutionPool();
  });

  after(async () => {
    // Clean up test data
    await pool.query("DELETE FROM evolution_events WHERE vivan_urn LIKE 'urn:graphheight:vivan:test-%'");
    await pool.query("DELETE FROM persona_definitions WHERE vivan_urn LIKE 'urn:graphheight:vivan:test-%'");
    await pool.query("DELETE FROM persona_registry WHERE vivan_urn LIKE 'urn:graphheight:vivan:test-%'");
    await closeEvolutionPool();
  });

  it('creates and retrieves a persona definition round-trip', async () => {
    const testUrn = `urn:graphheight:vivan:test-${Date.now()}`;
    const baseline = {
      name: 'Test Persona',
      traits: ['curious'],
      voice: { tone: 'warm', style: 'concise' },
      constraints: [],
      knowledge_domains: [],
      behavioral_boundaries: [],
    };

    // Insert
    await pool.query(
      `INSERT INTO persona_definitions (vivan_urn, version, baseline_json, status)
       VALUES ($1, 1, $2, 'active')`,
      [testUrn, JSON.stringify(baseline)]
    );
    await pool.query(
      `INSERT INTO persona_registry (vivan_urn, current_version, status, template_source)
       VALUES ($1, 1, 'active', 'test')`,
      [testUrn]
    );

    // Retrieve
    const result = await pool.query(
      'SELECT baseline_json FROM persona_definitions WHERE vivan_urn = $1 AND version = 1',
      [testUrn]
    );
    assert.equal(result.rows.length, 1);
    assert.deepEqual(result.rows[0].baseline_json, baseline);
  });

  it('enforces unique constraint on vivan_urn + version', async () => {
    const testUrn = `urn:graphheight:vivan:test-dup-${Date.now()}`;
    const baseline = JSON.stringify({ name: 'Dup Test', traits: ['x'], voice: { tone: 'a', style: 'b' } });

    await pool.query(
      'INSERT INTO persona_definitions (vivan_urn, version, baseline_json) VALUES ($1, 1, $2)',
      [testUrn, baseline]
    );

    await assert.rejects(
      () => pool.query(
        'INSERT INTO persona_definitions (vivan_urn, version, baseline_json) VALUES ($1, 1, $2)',
        [testUrn, baseline]
      ),
      { message: /unique/ }
    );
  });
});
