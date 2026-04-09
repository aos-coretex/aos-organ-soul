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

const analyst = createLLMClient({
  agentName: 'evolution-analyst',
  defaultModel: 'claude-sonnet-4-6',
  defaultProvider: 'anthropic',
  apiKeyEnvVar: 'ANTHROPIC_API_KEY',
  maxTokens: 4096,
  thinking: true,
  thinkingBudget: 10000,
});

/**
 * Check if a persona qualifies for evolution and execute if so.
 * @param {string} vivanUrn
 * @param {object} config — Soul config (evolution thresholds)
 * @param {string} triggerSource — 'dream_cycle' | 'manual' | 'threshold'
 * @returns {Promise<{evolved: boolean, new_version: number|null, reason: string, errors: string[]}>}
 */
export async function evaluateEvolution(vivanUrn, config, triggerSource = 'manual') {
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

  const { newBaseline, changesSummary } = await synthesizeBaseline(
    currentBaseline.baseline_json,
    obsResult.rows,
    growthDescriptions
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
 * @param {object} config
 * @returns {Promise<{evaluated: number, evolved: number, skipped: number, errors: string[]}>}
 */
export async function evaluateAllEvolutions(config) {
  const evoPool = getEvolutionPool();
  const result = await evoPool.query(
    "SELECT vivan_urn FROM persona_registry WHERE status = 'active'"
  );

  let evolved = 0, skipped = 0;
  const allErrors = [];

  for (const row of result.rows) {
    const evoResult = await evaluateEvolution(row.vivan_urn, config, 'dream_cycle');
    if (evoResult.evolved) evolved++;
    else skipped++;
    allErrors.push(...evoResult.errors);
  }

  return {
    evaluated: result.rows.length,
    evolved,
    skipped,
    errors: allErrors,
  };
}

/**
 * LLM-based baseline synthesis.
 * Incorporates growth indicators into the existing persona definition.
 */
async function synthesizeBaseline(currentBaseline, observations, growthDescriptions) {
  const obsText = observations.map((obs, i) =>
    `[${i + 1}] (${obs.category}, relevance=${obs.persona_relevance}) ${obs.content}`
  ).join('\n');

  const growthText = growthDescriptions.length > 0
    ? `\nGROWTH INDICATORS (from consistency checks):\n${growthDescriptions.map((g, i) => `- ${g}`).join('\n')}`
    : '';

  const systemPrompt = `You are a persona evolution specialist. You update an AI persona's baseline definition
to incorporate observed growth while preserving core identity.

CURRENT BASELINE:
${JSON.stringify(currentBaseline, null, 2)}

RULES:
- PRESERVE core identity: name, fundamental traits, behavioral boundaries
- INCORPORATE growth: add new traits, refine voice, expand knowledge domains
- CORRECT drift patterns: strengthen constraints where drift was observed
- NEVER remove traits or boundaries — only ADD or REFINE
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

  const userMsg = `Based on these ${observations.length} observations and growth indicators, evolve the persona baseline:

OBSERVATIONS:
${obsText}
${growthText}`;

  try {
    // System prompt via options.system (Anthropic API requirement — RFI-2 fix)
    const result = await analyst.chat([
      { role: 'user', content: userMsg },
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
