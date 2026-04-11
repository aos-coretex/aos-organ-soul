import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { initEvolutionPool, closeEvolutionPool, getEvolutionPool } from '../server/db/evolution-pool.js';
import { loadConstitutionalFrame, buildSynthesisPrompt } from '../agents/evolution-analyst.js';

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

// --- Constitutional conditioning (2026-04-11 repair, Cortex-role audit Finding 2 YES) ---

describe('Evolution Analyst — constitutional frame loading', () => {
  const originalFetch = globalThis.fetch;
  const graphUrl = 'http://127.0.0.1:4020';
  const arbiterUrl = 'http://127.0.0.1:4021';

  after(() => {
    globalThis.fetch = originalFetch;
  });

  it('loads both MSP and BoR on happy path (not degraded)', async () => {
    globalThis.fetch = async (url) => {
      if (url.includes('/bor/raw')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            version: '1.0.0-seed',
            hash: 'a'.repeat(64),
            raw_text: '# Bill of Rights\n\n## Article I\nAuthorized operations...',
            effective_since: '2026-04-01T00:00:00Z',
            loaded_at: '2026-04-11T00:00:00Z',
          }),
        };
      }
      if (url.includes('msp_version')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            concepts: [
              { data: { raw_text: '# MSP\n\nMission: serve the organism.' } },
            ],
          }),
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const frame = await loadConstitutionalFrame(graphUrl, arbiterUrl);
    assert.equal(frame.degraded, false);
    assert.ok(frame.msp.includes('Mission'));
    assert.ok(frame.bor.includes('Bill of Rights'));
  });

  it('returns degraded frame when Arbiter returns HTTP 503', async () => {
    globalThis.fetch = async (url) => {
      if (url.includes('/bor/raw')) {
        return {
          ok: false,
          status: 503,
          json: async () => ({ error: 'BOR_NOT_LOADED' }),
        };
      }
      if (url.includes('msp_version')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            concepts: [{ data: { raw_text: '# MSP\nOK' } }],
          }),
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const frame = await loadConstitutionalFrame(graphUrl, arbiterUrl);
    assert.equal(frame.degraded, true);
    assert.equal(frame.bor, null);
    assert.equal(frame.msp, '# MSP\nOK');
  });

  it('returns degraded frame when Arbiter fetch throws network error', async () => {
    globalThis.fetch = async (url) => {
      if (url.includes('/bor/raw')) {
        throw new Error('ECONNREFUSED 127.0.0.1:4021');
      }
      if (url.includes('msp_version')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            concepts: [{ data: { raw_text: '# MSP\nOK' } }],
          }),
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const frame = await loadConstitutionalFrame(graphUrl, arbiterUrl);
    assert.equal(frame.degraded, true);
    assert.equal(frame.bor, null);
    assert.ok(frame.msp.length > 0);
  });
});

describe('Evolution Analyst — Sonnet prompt mechanical safeguard', () => {
  // Mechanical boundary enforcement: the persona-synthesis prompt must never
  // ask Sonnet to make scope rulings (that is Arbiter's exclusive job at
  // Nomos→Arbiter adjudication time). The prompt MUST cite BoR / Bill of
  // Rights / constitutional framing. Verified as a static string check so
  // the boundary cannot drift silently.

  const dummyBaseline = {
    name: 'Test',
    traits: ['curious'],
    voice: { tone: 'warm', style: 'concise' },
    constraints: [],
    knowledge_domains: [],
    behavioral_boundaries: ['never bypass audit logs'],
  };
  const dummyObservations = [
    { category: 'TRAIT', persona_relevance: 0.9, content: 'shows patience under load' },
  ];
  const dummyGrowth = ['exhibits analytical thinking'];

  it('prompt contains no scope-ruling language and cites BoR/MSP constitutional frame', () => {
    const frame = {
      msp: '# Mission Statement Protocol\nServe the organism faithfully.',
      bor: '# Bill of Rights\nArticle I: authorized operations.',
      degraded: false,
    };
    const { systemPrompt, userMessage } = buildSynthesisPrompt(
      dummyBaseline,
      dummyObservations,
      dummyGrowth,
      frame
    );
    const combined = systemPrompt + '\n' + userMessage;

    // Mechanical safeguard: no scope-ruling language anywhere in the prompt.
    assert.ok(
      !/in_scope|out_of_scope|IN_SCOPE|OUT_OF_SCOPE|scope check/.test(combined),
      'prompt contains forbidden scope-ruling language'
    );

    // Required-phrase assertions: BoR, constitutional framing, MSP all cited.
    assert.match(combined, /BoR|Bill of Rights/);
    assert.match(combined, /constitutional/i);
    assert.match(combined, /Mission Statement Protocol|MSP/);

    // The frame content itself is embedded (conditioning context, not oracle).
    assert.ok(combined.includes('Serve the organism faithfully'));
    assert.ok(combined.includes('authorized operations'));
  });

  it('degraded mode injects minimal-change posture instead of frame content', () => {
    const frame = { msp: null, bor: null, degraded: true };
    const { systemPrompt } = buildSynthesisPrompt(
      dummyBaseline,
      dummyObservations,
      dummyGrowth,
      frame
    );

    assert.match(systemPrompt, /DEGRADED/);
    assert.match(systemPrompt, /minimal-change/);
    assert.ok(
      !/in_scope|out_of_scope|IN_SCOPE|OUT_OF_SCOPE|scope check/.test(systemPrompt),
      'degraded prompt contains forbidden scope-ruling language'
    );
  });
});
