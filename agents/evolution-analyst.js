/**
 * Evolution Analyst — Soul's third internal agent.
 *
 * Determines when a persona should evolve and generates updated
 * baseline definitions. Triggered by:
 * - Dream cycle (automatic — growth threshold reached)
 * - Manual request (POST /personas/:urn/evolve)
 * - Consistency threshold crossing (intervene → requires evolution)
 *
 * Evidence threshold (configurable):
 * - minGrowthObservations: N growth-classified observations since last evolution (default 10)
 * - minConsistencyScore: persona must have >= this score to evolve (default 0.6)
 *   Below this score means too much drift — fix drift first, don't evolve
 *
 * Model: Sonnet (needs to synthesize persona definitions)
 *
 * Note: thinking config set for intent documentation. Current llm-client
 * does not propagate client config to chat() options. Same note as u7h-4.
 */
import { createLLMClient } from '@coretex/organ-boot/llm-client';
import { getMemoryPool } from '../server/db/memory-pool.js';
import { getEvolutionPool } from '../server/db/evolution-pool.js';
import { queryActiveMSP } from '../lib/graph-adapter.js';

const analyst = createLLMClient({
  agentName: 'evolution-analyst',
  defaultModel: 'claude-sonnet-4-6',
  defaultProvider: 'anthropic',
  apiKeyEnvVar: 'ANTHROPIC_API_KEY',
  maxTokens: 4096,
  thinking: true,
  thinkingBudget: 10000,
});

// --- C2A-03: degraded-streak tracking (dream-cycle granularity) ---
//
// Tracks consecutive dream cycles where the constitutional frame is degraded.
// Incremented once per dream cycle (in evaluateAllEvolutions), not per-persona.
// Reset to 0 when a non-degraded cycle completes. Exposed via /introspect so
// Vigil can assert the streak stays below threshold.

let degradedStreak = 0;
let lastDegradedAt = null;

/**
 * Read the current degraded-cycle streak. Consumed by introspectCheck.
 * @returns {{ streak: number, last_degraded_at: string|null }}
 */
export function getDegradedStreak() {
  return { streak: degradedStreak, last_degraded_at: lastDegradedAt };
}

/**
 * Reset streak to zero. Exported for test isolation only.
 */
export function resetDegradedStreak() {
  degradedStreak = 0;
  lastDegradedAt = null;
}

// --- Constitutional conditioning (2026-04-11 repair, Cortex-role audit Finding 2 YES) ---
//
// The evolution analyst is the point where a persona-level declaration is
// synthesized ("this Vivan will henceforth behave this way"). Without
// constitutional context, a persona could legitimately evolve in a BoR-
// contradictory direction that the consistency checker — blind to
// institutional identity — would classify as growth. Loading MSP + BoR
// raw text as conditioning context (NOT as a scope oracle) closes the gap.
// Arbiter retains exclusive scope-ruling authority at Nomos→Arbiter
// adjudication time; this layer only ensures persona synthesis is aware
// of the institution the Vivan lives inside.

/**
 * Fetch the Bill of Rights raw text from Arbiter's HTTP surface.
 * Fail-open: returns null on any error. Caller treats null as degraded.
 *
 * @param {string} arbiterUrl - Arbiter organ base URL
 * @returns {Promise<string|null>}
 */
async function loadBoRRawText(arbiterUrl) {
  try {
    const response = await fetch(`${arbiterUrl}/bor/raw`);
    if (!response.ok) return null;
    const body = await response.json();
    return typeof body.raw_text === 'string' && body.raw_text.length > 0
      ? body.raw_text
      : null;
  } catch (error) {
    process.stdout.write(JSON.stringify({
      timestamp: new Date().toISOString(),
      event: 'bor_load_failed',
      error: error.message,
    }) + '\n');
    return null;
  }
}

/**
 * Load the mission + constitutional frame for persona synthesis.
 *
 * @param {string} graphUrl - Graph organ base URL (for active MSP)
 * @param {string} arbiterUrl - Arbiter organ base URL (for active BoR)
 * @returns {Promise<{msp: string|null, bor: string|null, degraded: boolean}>}
 */
export async function loadConstitutionalFrame(graphUrl, arbiterUrl) {
  const [msp, bor] = await Promise.all([
    queryActiveMSP(graphUrl),
    loadBoRRawText(arbiterUrl),
  ]);
  return { msp, bor, degraded: msp === null || bor === null };
}

/**
 * Pure prompt builder for persona synthesis. Extracted so tests can
 * verify prompt structure without invoking the Sonnet client.
 *
 * Adds a constitutional frame block to the existing u7h-5 synthesis
 * prompt. In degraded mode (either MSP or BoR unavailable), injects
 * a minimal-change posture instruction per MP-11 Senate/Nomos
 * fail-closed pattern. Never asks Sonnet to make scope rulings —
 * Arbiter owns IN_SCOPE/OUT_OF_SCOPE/AMBIGUOUS determinations.
 *
 * @param {object} currentBaseline - current persona baseline JSON
 * @param {Array} observations - persona observations
 * @param {Array<string>} growthDescriptions - growth indicators
 * @param {{msp: string|null, bor: string|null, degraded: boolean}} constitutionalFrame
 * @returns {{systemPrompt: string, userMessage: string}}
 */
export function buildSynthesisPrompt(currentBaseline, observations, growthDescriptions, constitutionalFrame) {
  const obsText = observations.map((obs, i) =>
    `[${i + 1}] (${obs.category}, relevance=${obs.persona_relevance}) ${obs.content}`
  ).join('\n');

  const growthText = growthDescriptions.length > 0
    ? `\nGROWTH INDICATORS (from consistency checks):\n${growthDescriptions.map((g) => `- ${g}`).join('\n')}`
    : '';

  const frame = constitutionalFrame || { msp: null, bor: null, degraded: true };

  const constitutionalBlock = frame.degraded
    ? `CONSTITUTIONAL FRAME (DEGRADED — institutional identity sources unavailable this cycle):
The active Mission Statement Protocol and Bill of Rights could not be loaded. Produce a
persona synthesis that is minimal-change relative to the current baseline; avoid novel
behavioral additions until constitutional context is recoverable. Prefer stability over
growth when the institutional frame is missing.`
    : `CONSTITUTIONAL FRAME (institutional identity and mission — conditioning context only):

ACTIVE MISSION STATEMENT PROTOCOL (MSP):
${frame.msp}

ACTIVE BILL OF RIGHTS (BoR):
${frame.bor}

Use the MSP and BoR as conditioning context that shapes the persona update so the evolved
persona remains an institutionally coherent member of the organism. You are NOT ruling on
whether any specific behavior is permitted under the BoR — Arbiter owns that determination
when individual actions are proposed. You are ensuring the synthesized persona is aware of
the institution it lives inside.`;

  const systemPrompt = `You are Soul's evolution analyst. You update an AI persona's baseline definition
to incorporate observed growth while preserving core identity and institutional coherence.

CURRENT BASELINE:
${JSON.stringify(currentBaseline, null, 2)}

${constitutionalBlock}

RULES:
- PRESERVE core identity: name, fundamental traits, behavioral boundaries
- INCORPORATE growth: add new traits, refine voice, expand knowledge domains
- CORRECT drift patterns: strengthen constraints where drift was observed
- NEVER remove traits or boundaries — only ADD or REFINE
- REMAIN COHERENT with the institutional identity expressed in the BoR and the mission
  expressed in the MSP. If a growth indicator would push the persona in a direction that
  contradicts the constitutional frame, decline that indicator and note the reason in
  changes_summary.
- If changes are trivial (cosmetic rewording only), return null
- The updated baseline must be a complete persona definition (same structure as input)

OUTPUT FORMAT (JSON):
{
  "new_baseline": { ... complete baseline_json ... },
  "changes_summary": "Brief description of what changed and why (1-3 sentences)",
  "significant": true
}

If no meaningful evolution is warranted, return:
{ "new_baseline": null, "changes_summary": "No significant evolution warranted", "significant": false }

Return ONLY the JSON. No wrapping text.`;

  const userMessage = `Based on these ${observations.length} observations and growth indicators, evolve the persona baseline:

OBSERVATIONS:
${obsText}
${growthText}`;

  return { systemPrompt, userMessage };
}

/**
 * Check if a persona qualifies for evolution and execute if so.
 * @param {string} vivanUrn
 * @param {object} config — Soul config (evolution thresholds)
 * @param {string} triggerSource — 'dream_cycle' | 'manual' | 'threshold'
 * @param {{msp: string|null, bor: string|null, degraded: boolean}} [preloadedFrame]
 *   Optional pre-loaded constitutional frame. When called from evaluateAllEvolutions(),
 *   the frame is loaded once per dream cycle and passed to all persona evaluations.
 *   Manual triggers load their own frame.
 * @returns {Promise<{evolved: boolean, new_version: number|null, reason: string, errors: string[]}>}
 */
export async function evaluateEvolution(vivanUrn, config, triggerSource = 'manual', preloadedFrame = null) {
  const errors = [];

  // 1. Load current state from soul_evolution
  const evoPool = getEvolutionPool();
  const registryResult = await evoPool.query(
    'SELECT * FROM persona_registry WHERE vivan_urn = $1',
    [vivanUrn]
  );
  if (registryResult.rows.length === 0) {
    return { evolved: false, new_version: null, reason: 'Persona not found', errors: [`${vivanUrn} not registered`] };
  }
  const registry = registryResult.rows[0];

  const baselineResult = await evoPool.query(
    'SELECT * FROM persona_definitions WHERE vivan_urn = $1 AND version = $2',
    [vivanUrn, registry.current_version]
  );
  if (baselineResult.rows.length === 0) {
    return { evolved: false, new_version: null, reason: 'Current baseline not found', errors: ['Missing baseline'] };
  }
  const currentBaseline = baselineResult.rows[0];

  // 2. Check consistency score threshold
  if (registry.last_consistency_score !== null && registry.last_consistency_score < config.evolution.minConsistencyScore) {
    return {
      evolved: false,
      new_version: null,
      reason: `Consistency score too low (${registry.last_consistency_score} < ${config.evolution.minConsistencyScore}) — fix drift before evolving`,
      errors: [],
    };
  }

  // 3. Count growth observations since last evolution
  const memPool = getMemoryPool();
  const since = registry.last_evolved_at || registry.created_at;

  // Get growth items from consistency checks since last evolution
  const checksResult = await memPool.query(`
    SELECT growth_items, growth_count
    FROM consistency_checks
    WHERE vivan_urn = $1 AND checked_at >= $2 AND growth_count > 0
    ORDER BY checked_at DESC
  `, [vivanUrn, since]);

  const totalGrowthItems = checksResult.rows.reduce((sum, r) => sum + r.growth_count, 0);

  // Check evidence threshold (skip for manual triggers — human override)
  if (triggerSource !== 'manual' && totalGrowthItems < config.evolution.minGrowthObservations) {
    return {
      evolved: false,
      new_version: null,
      reason: `Insufficient growth evidence (${totalGrowthItems} < ${config.evolution.minGrowthObservations})`,
      errors: [],
    };
  }

  // 4. Load all observations since last evolution (for synthesis context)
  const obsResult = await memPool.query(`
    SELECT id, category, content, persona_relevance, created_at
    FROM persona_observations
    WHERE vivan_urn = $1 AND created_at >= $2
    ORDER BY persona_relevance DESC, created_at DESC
    LIMIT 50
  `, [vivanUrn, since]);

  // Collect growth descriptions from consistency checks
  const growthDescriptions = checksResult.rows
    .flatMap(r => {
      try { return JSON.parse(typeof r.growth_items === 'string' ? r.growth_items : JSON.stringify(r.growth_items)); }
      catch { return []; }
    })
    .map(g => g.description)
    .filter(Boolean);

  // 5. Synthesize new baseline via LLM
  if (!analyst.isAvailable()) {
    return { evolved: false, new_version: null, reason: 'LLM unavailable', errors: ['ANTHROPIC_API_KEY not set'] };
  }

  // Load constitutional frame (MSP + BoR raw text) before synthesis.
  // Fail-open: null sources trigger degraded-mode minimal-change posture.
  // C2A-03: when called from evaluateAllEvolutions(), frame is pre-loaded once per cycle.
  const constitutionalFrame = preloadedFrame || await loadConstitutionalFrame(config.graphUrl, config.arbiterUrl);
  if (constitutionalFrame.degraded) {
    process.stdout.write(JSON.stringify({
      timestamp: new Date().toISOString(),
      event: 'constitutional_frame_degraded',
      vivan: vivanUrn,
      msp_loaded: constitutionalFrame.msp !== null,
      bor_loaded: constitutionalFrame.bor !== null,
    }) + '\n');
  }

  const { newBaseline, changesSummary } = await synthesizeBaseline(
    currentBaseline.baseline_json,
    obsResult.rows,
    growthDescriptions,
    constitutionalFrame
  );

  if (!newBaseline) {
    return { evolved: false, new_version: null, reason: 'Synthesis produced no changes', errors: [] };
  }

  // 6. Store new version (append-only — NEVER delete or modify previous)
  const newVersion = registry.current_version + 1;
  const client = await evoPool.connect();
  try {
    await client.query('BEGIN');

    // Mark current version as superseded
    await client.query(`
      UPDATE persona_definitions SET status = 'superseded', superseded_at = NOW()
      WHERE vivan_urn = $1 AND version = $2
    `, [vivanUrn, registry.current_version]);

    // Insert new version
    await client.query(`
      INSERT INTO persona_definitions (vivan_urn, version, baseline_json, status, changes_summary)
      VALUES ($1, $2, $3, 'active', $4)
    `, [vivanUrn, newVersion, JSON.stringify(newBaseline), changesSummary]);

    // Update registry pointer
    await client.query(`
      UPDATE persona_registry
      SET current_version = $1, last_evolved_at = NOW(), updated_at = NOW()
      WHERE vivan_urn = $2
    `, [newVersion, vivanUrn]);

    // Record evolution event (audit trail)
    await client.query(`
      INSERT INTO evolution_events
        (vivan_urn, from_version, to_version, trigger_source, reason, evidence_refs,
         consistency_score_before, consistency_score_after)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
    `, [
      vivanUrn,
      registry.current_version,
      newVersion,
      triggerSource,
      changesSummary,
      JSON.stringify(
        obsResult.rows.slice(0, 20).map(o => ({ observation_id: o.id, content_summary: o.content.slice(0, 100) }))
      ),
      registry.last_consistency_score,
    ]);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    return { evolved: false, new_version: null, reason: 'Transaction failed', errors: [err.message] };
  } finally {
    client.release();
  }

  const log = {
    timestamp: new Date().toISOString(),
    event: 'persona_evolved',
    vivan: vivanUrn,
    from_version: registry.current_version,
    to_version: newVersion,
    trigger: triggerSource,
    growth_evidence: totalGrowthItems,
    observations_analyzed: obsResult.rows.length,
  };
  process.stdout.write(JSON.stringify(log) + '\n');

  return {
    evolved: true,
    new_version: newVersion,
    reason: changesSummary,
    errors,
  };
}

/**
 * Evaluate all active personas for evolution eligibility.
 * Called by dream cycle (Relay 6).
 *
 * C2A-03: loads the constitutional frame ONCE per dream cycle, updates the
 * degraded streak, and passes the frame to each persona evaluation. This
 * ensures the streak tracks consecutive dream cycles, not per-persona calls.
 *
 * @param {object} config
 * @returns {Promise<{evaluated: number, evolved: number, skipped: number, constitutional_frame_degraded: boolean, degraded_streak: number, errors: string[]}>}
 */
export async function evaluateAllEvolutions(config) {
  const evoPool = getEvolutionPool();
  const result = await evoPool.query(
    "SELECT vivan_urn FROM persona_registry WHERE status = 'active'"
  );

  // C2A-03: load constitutional frame once per dream cycle for streak tracking.
  const constitutionalFrame = await loadConstitutionalFrame(config.graphUrl, config.arbiterUrl);

  if (constitutionalFrame.degraded) {
    degradedStreak += 1;
    lastDegradedAt = new Date().toISOString();
    process.stdout.write(JSON.stringify({
      timestamp: lastDegradedAt,
      event: 'constitutional_frame_degraded_streak',
      streak: degradedStreak,
      msp_loaded: constitutionalFrame.msp !== null,
      bor_loaded: constitutionalFrame.bor !== null,
    }) + '\n');
  } else {
    if (degradedStreak > 0) {
      process.stdout.write(JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'constitutional_frame_degraded_streak_reset',
        previous_streak: degradedStreak,
      }) + '\n');
    }
    degradedStreak = 0;
  }

  let evolved = 0, skipped = 0;
  const allErrors = [];

  for (const row of result.rows) {
    const evoResult = await evaluateEvolution(row.vivan_urn, config, 'dream_cycle', constitutionalFrame);
    if (evoResult.evolved) evolved++;
    else skipped++;
    allErrors.push(...evoResult.errors);
  }

  return {
    evaluated: result.rows.length,
    evolved,
    skipped,
    constitutional_frame_degraded: constitutionalFrame.degraded,
    degraded_streak: degradedStreak,
    errors: allErrors,
  };
}

/**
 * LLM-based baseline synthesis.
 * Incorporates growth indicators into the existing persona definition,
 * conditioned on the institutional identity expressed in the BoR/MSP
 * (or a minimal-change posture if the constitutional frame is degraded).
 *
 * @param {object} currentBaseline
 * @param {Array} observations
 * @param {Array<string>} growthDescriptions
 * @param {{msp: string|null, bor: string|null, degraded: boolean}} [constitutionalFrame]
 */
async function synthesizeBaseline(currentBaseline, observations, growthDescriptions, constitutionalFrame) {
  const frame = constitutionalFrame || { msp: null, bor: null, degraded: true };
  const { systemPrompt, userMessage } = buildSynthesisPrompt(
    currentBaseline,
    observations,
    growthDescriptions,
    frame
  );

  try {
    // System prompt via options.system (Anthropic API requirement — RFI-2 fix)
    const result = await analyst.chat([
      { role: 'user', content: userMessage },
    ], { system: systemPrompt, temperature: 0.3 });

    const text = result.content.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { newBaseline: null, changesSummary: null };

    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.significant || !parsed.new_baseline) {
      return { newBaseline: null, changesSummary: null };
    }

    return {
      newBaseline: parsed.new_baseline,
      changesSummary: parsed.changes_summary || 'Evolution applied',
    };
  } catch (err) {
    const log = { timestamp: new Date().toISOString(), event: 'synthesis_error', error: err.message };
    process.stdout.write(JSON.stringify(log) + '\n');
    return { newBaseline: null, changesSummary: null };
  }
}

export { synthesizeBaseline };
