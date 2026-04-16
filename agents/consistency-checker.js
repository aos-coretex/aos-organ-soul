/**
 * Consistency Checker — Soul's second internal agent.
 *
 * Compares observed Vivan behavior against the persona baseline
 * and classifies each deviation:
 * - DRIFT: undesirable deviation from baseline (error, degradation)
 * - GROWTH: desirable evolution beyond baseline (enhancement, emergence)
 *
 * Consistency score (0-1):
 * - > stable threshold (default 0.8): persona is consistent — log only
 * - monitor..stable (default 0.5-0.8): persona is drifting — flag for review
 * - < monitor threshold (default 0.5): persona is inconsistent — intervene
 *
 * Model: Sonnet (needs nuanced judgment for drift vs growth classification)
 *
 * Note: thinking config is set for documentation of intent. The current
 * llm-client does not propagate client config to chat() options. When
 * llm-client is upgraded, thinking/temperature conflict must be resolved
 * (Anthropic API requires temperature omitted when thinking is enabled).
 */
import { getMemoryPool } from '../server/db/memory-pool.js';
import { getEvolutionPool } from '../server/db/evolution-pool.js';

// MP-CONFIG-1 R7 — loader-derived LLM client (Sonnet + thinking budget 8000 per D9)
// injected at boot via setLLMClient(). Unavailable-stub default preserves test imports
// that don't exercise the LLM path.
let checker = {
  isAvailable: () => false,
  chat: async () => {
    const err = new Error('Soul consistency-checker: no LLM client wired; boot path must inject one (MP-CONFIG-1 R7)');
    err.code = 'LLM_UNAVAILABLE';
    throw err;
  },
  getUsage: () => ({}),
};

export function setLLMClient(client) {
  checker = client;
}

/**
 * Run consistency check for a single Vivan.
 * @param {string} vivanUrn — The persona URN
 * @param {object} config — Soul config (with thresholds)
 * @param {object} [options] — { since: Date, limit: number }
 * @returns {Promise<{check_id: string, consistency_score: number, classification: string, drift_items: object[], growth_items: object[], errors: string[]}>}
 */
export async function checkConsistency(vivanUrn, config, options = {}) {
  const errors = [];

  // 1. Load current baseline from soul_evolution
  const evoPool = getEvolutionPool();
  const registryResult = await evoPool.query(
    'SELECT * FROM persona_registry WHERE vivan_urn = $1',
    [vivanUrn]
  );
  if (registryResult.rows.length === 0) {
    return { check_id: null, consistency_score: null, classification: null, drift_items: [], growth_items: [], errors: [`Persona ${vivanUrn} not found`] };
  }
  const registry = registryResult.rows[0];

  const baselineResult = await evoPool.query(
    'SELECT baseline_json, version FROM persona_definitions WHERE vivan_urn = $1 AND version = $2',
    [vivanUrn, registry.current_version]
  );
  if (baselineResult.rows.length === 0) {
    return { check_id: null, consistency_score: null, classification: null, drift_items: [], growth_items: [], errors: [`Baseline v${registry.current_version} not found for ${vivanUrn}`] };
  }
  const baseline = baselineResult.rows[0].baseline_json;
  const baselineVersion = baselineResult.rows[0].version;

  // 2. Load recent observations from soul_memory
  const memPool = getMemoryPool();
  const since = options.since || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // Default: last 7 days
  const limit = options.limit || 100;

  const obsResult = await memPool.query(`
    SELECT id, category, content, persona_relevance, source_conversation_urn, created_at
    FROM persona_observations
    WHERE vivan_urn = $1 AND created_at >= $2
    ORDER BY created_at DESC
    LIMIT $3
  `, [vivanUrn, since, limit]);

  const observations = obsResult.rows;
  if (observations.length === 0) {
    // No observations — persona is trivially consistent (no behavior to compare)
    const checkId = await storeCheck(vivanUrn, baselineVersion, 1.0, 'stable', [], [], memPool);
    return { check_id: checkId, consistency_score: 1.0, classification: 'stable', drift_items: [], growth_items: [], errors: [] };
  }

  // 3. Run LLM comparison
  if (!checker.isAvailable()) {
    return { check_id: null, consistency_score: null, classification: null, drift_items: [], growth_items: [], errors: ['LLM unavailable (ANTHROPIC_API_KEY not set)'] };
  }

  const { score, driftItems, growthItems } = await classifyDeviations(baseline, observations);

  // 4. Classify by threshold
  const { stable, monitor } = config.thresholds;
  let classification;
  if (score >= stable) {
    classification = 'stable';
  } else if (score >= monitor) {
    classification = 'monitor';
  } else {
    classification = 'intervene';
  }

  // 5. Store result in soul_memory.consistency_checks
  const checkId = await storeCheck(vivanUrn, baselineVersion, score, classification, driftItems, growthItems, memPool);

  // 6. Update persona_registry
  try {
    await evoPool.query(
      'UPDATE persona_registry SET last_consistency_score = $1, updated_at = NOW() WHERE vivan_urn = $2',
      [score, vivanUrn]
    );
  } catch (err) {
    errors.push(`Failed to update registry: ${err.message}`);
  }

  const log = {
    timestamp: new Date().toISOString(),
    event: 'consistency_check',
    vivan: vivanUrn,
    baseline_version: baselineVersion,
    observations_analyzed: observations.length,
    score,
    classification,
    drift_count: driftItems.length,
    growth_count: growthItems.length,
  };
  process.stdout.write(JSON.stringify(log) + '\n');

  return { check_id: checkId, consistency_score: score, classification, drift_items: driftItems, growth_items: growthItems, errors };
}

/**
 * Run consistency checks for ALL active personas.
 * Called by dream cycle (Relay 6) and manual /analyze endpoints.
 * @param {object} config — Soul config
 * @returns {Promise<{checked: number, stable: number, monitor: number, intervene: number, errors: string[]}>}
 */
export async function checkAllPersonas(config) {
  const evoPool = getEvolutionPool();
  const result = await evoPool.query(
    "SELECT vivan_urn FROM persona_registry WHERE status = 'active'"
  );

  let stable = 0, monitor = 0, intervene = 0;
  const allErrors = [];

  for (const row of result.rows) {
    const check = await checkConsistency(row.vivan_urn, config);
    if (check.classification === 'stable') stable++;
    else if (check.classification === 'monitor') monitor++;
    else if (check.classification === 'intervene') intervene++;
    allErrors.push(...check.errors);
  }

  return {
    checked: result.rows.length,
    stable,
    monitor,
    intervene,
    errors: allErrors,
  };
}

/**
 * LLM-based drift/growth classification.
 */
async function classifyDeviations(baseline, observations) {
  const obsText = observations.map((obs, i) =>
    `[${i + 1}] (${obs.category}, relevance=${obs.persona_relevance}) ${obs.content}`
  ).join('\n');

  const systemPrompt = `You are a persona consistency analyst. You compare observed AI persona behavior
against a persona baseline definition and classify each deviation.

PERSONA BASELINE:
${JSON.stringify(baseline, null, 2)}

CLASSIFICATION RULES:
- DRIFT (undesirable): Behavior contradicts baseline traits, violates constraints,
  breaks behavioral boundaries, uses wrong voice/tone, or degrades persona quality.
  Examples: wrong tone, knowledge boundary violation, contradicting stated traits.
- GROWTH (desirable): Behavior extends baseline in positive ways — developing new
  strengths, building domain expertise, refining communication style, demonstrating
  creativity within persona boundaries.
  Examples: nuanced tone development, emerging expertise, creative problem-solving.
- CONSISTENT: Behavior matches baseline expectations — not a deviation at all.

CONSISTENCY SCORE:
Calculate a score between 0.0 and 1.0:
- 1.0 = perfect consistency (all observations match baseline or show growth)
- 0.8+ = stable (minor deviations, mostly growth)
- 0.5-0.8 = monitoring needed (significant drift detected)
- <0.5 = intervention needed (persona is behaving inconsistently)

Weight by persona_relevance: high-relevance observations (>0.6) have more impact on score.

OUTPUT FORMAT (JSON):
{
  "score": 0.85,
  "reasoning": "Brief explanation of overall assessment",
  "drift_items": [
    {"observation_index": 3, "description": "What specifically drifted", "severity": "low|medium|high"}
  ],
  "growth_items": [
    {"observation_index": 1, "description": "What specifically grew", "strength": "low|medium|high"}
  ]
}

Return ONLY the JSON. No wrapping text.`;

  const userMsg = `Analyze these ${observations.length} behavioral observations against the persona baseline:\n\n${obsText}`;

  try {
    // System prompt via options.system (Anthropic API requirement — RFI-2 fix)
    const result = await checker.chat([
      { role: 'user', content: userMsg },
    ], { system: systemPrompt, temperature: 0.2 });

    const text = result.content.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { score: 0.5, driftItems: [], growthItems: [] };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const score = Math.max(0, Math.min(1, parsed.score || 0.5));

    const driftItems = (parsed.drift_items || []).map(item => ({
      observation_id: observations[item.observation_index - 1]?.id || null,
      description: item.description,
      severity: item.severity || 'medium',
    }));

    const growthItems = (parsed.growth_items || []).map(item => ({
      observation_id: observations[item.observation_index - 1]?.id || null,
      description: item.description,
      strength: item.strength || 'medium',
    }));

    return { score, driftItems, growthItems };
  } catch (err) {
    const log = { timestamp: new Date().toISOString(), event: 'consistency_check_error', error: err.message };
    process.stdout.write(JSON.stringify(log) + '\n');
    return { score: 0.5, driftItems: [], growthItems: [] };
  }
}

/**
 * Store consistency check result in soul_memory.
 */
async function storeCheck(vivanUrn, baselineVersion, score, classification, driftItems, growthItems, memPool) {
  const result = await memPool.query(`
    INSERT INTO consistency_checks
      (vivan_urn, baseline_version, consistency_score, classification, drift_count, growth_count, drift_items, growth_items)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING id
  `, [
    vivanUrn,
    baselineVersion,
    score,
    classification,
    driftItems.length,
    growthItems.length,
    JSON.stringify(driftItems),
    JSON.stringify(growthItems),
  ]);
  return result.rows[0].id;
}

export { classifyDeviations };
