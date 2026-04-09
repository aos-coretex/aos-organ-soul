/**
 * Persona Dream Cycle — Soul's periodic consolidation process.
 *
 * Four phases, executed sequentially:
 * Phase 1: Observation pruning — remove redundant/low-value old observations
 * Phase 2: Pattern clustering — group related observations into behavioral_patterns
 * Phase 3: Confidence updates — update persona_relevance based on recurrence
 * Phase 4: Evolution triggers — run consistency checks + evaluate evolution for qualifying personas
 *
 * Schedule: 8:00 AM daily (staggered from Radiant 4:27 AM, Minder 6:30 AM)
 * Default: DISABLED (DREAM_ENABLED=false) — must be explicitly enabled
 *
 * Independent of Radiant and Minder dream cycles. Uses separate LLM calls
 * to avoid contention with Radiant (phase 2) and Minder (deduction/induction).
 */
import { getMemoryPool } from '../server/db/memory-pool.js';
import { getEvolutionPool } from '../server/db/evolution-pool.js';
import { generateEmbedding } from '../lib/vectr-client.js';
import { checkAllPersonas } from './consistency-checker.js';
import { evaluateAllEvolutions } from './evolution-analyst.js';

/**
 * Execute the full dream cycle.
 * @param {object} config — Soul config
 * @returns {Promise<object>} Dream cycle report
 */
export async function runDreamCycle(config) {
  const startedAt = new Date();
  const memPool = getMemoryPool();

  // Get next cycle number
  const cycleResult = await memPool.query(
    'SELECT COALESCE(MAX(cycle_number), 0) + 1 AS next FROM dream_log'
  );
  const cycleNumber = cycleResult.rows[0].next;

  // Create dream log entry
  const logResult = await memPool.query(`
    INSERT INTO dream_log (cycle_number, started_at, status)
    VALUES ($1, $2, 'running') RETURNING id
  `, [cycleNumber, startedAt]);
  const dreamId = logResult.rows[0].id;

  const report = {
    cycle_number: cycleNumber,
    started_at: startedAt.toISOString(),
    phases: {},
    errors: [],
  };

  try {
    // Phase 1: Observation pruning
    const log1 = { timestamp: new Date().toISOString(), event: 'dream_phase_1_start', cycle: cycleNumber };
    process.stdout.write(JSON.stringify(log1) + '\n');
    report.phases.prune = await phase1Prune(memPool, config);

    // Phase 2: Pattern clustering
    const log2 = { timestamp: new Date().toISOString(), event: 'dream_phase_2_start', cycle: cycleNumber };
    process.stdout.write(JSON.stringify(log2) + '\n');
    report.phases.cluster = await phase2Cluster(memPool, config);

    // Phase 3: Confidence updates
    const log3 = { timestamp: new Date().toISOString(), event: 'dream_phase_3_start', cycle: cycleNumber };
    process.stdout.write(JSON.stringify(log3) + '\n');
    report.phases.confidence = await phase3ConfidenceUpdate(memPool);

    // Phase 4: Evolution triggers
    const log4 = { timestamp: new Date().toISOString(), event: 'dream_phase_4_start', cycle: cycleNumber };
    process.stdout.write(JSON.stringify(log4) + '\n');
    report.phases.evolution = await phase4EvolutionTriggers(config);

    // Update dream log
    const completedAt = new Date();
    await memPool.query(`
      UPDATE dream_log SET
        completed_at = $1,
        observations_pruned = $2,
        patterns_updated = $3,
        evolutions_triggered = $4,
        personas_checked = $5,
        summary = $6,
        status = 'completed'
      WHERE id = $7
    `, [
      completedAt,
      report.phases.prune.pruned,
      report.phases.cluster.patterns_updated,
      report.phases.evolution.evolved,
      report.phases.evolution.evaluated,
      JSON.stringify(report),
      dreamId,
    ]);

    report.completed_at = completedAt.toISOString();
    report.duration_ms = completedAt - startedAt;

    const logDone = {
      timestamp: completedAt.toISOString(),
      event: 'dream_cycle_complete',
      cycle: cycleNumber,
      duration_ms: report.duration_ms,
      pruned: report.phases.prune.pruned,
      patterns: report.phases.cluster.patterns_updated,
      evolutions: report.phases.evolution.evolved,
    };
    process.stdout.write(JSON.stringify(logDone) + '\n');

  } catch (err) {
    report.errors.push(err.message);
    await memPool.query(
      "UPDATE dream_log SET status = 'failed', summary = $1, completed_at = NOW() WHERE id = $2",
      [err.message, dreamId]
    );

    const logFail = { timestamp: new Date().toISOString(), event: 'dream_cycle_failed', cycle: cycleNumber, error: err.message };
    process.stdout.write(JSON.stringify(logFail) + '\n');
  }

  return report;
}

/**
 * Phase 1: Observation Pruning
 * Remove old, low-relevance observations to keep soul_memory manageable.
 * Criteria:
 * - Observations older than 90 days with persona_relevance < 0.3 → DELETE
 * - Duplicate observations (same vivan_urn + category + similar content) → keep highest relevance
 */
async function phase1Prune(memPool, config) {
  let pruned = 0;

  // Remove old low-relevance observations
  const ageResult = await memPool.query(`
    DELETE FROM persona_observations
    WHERE created_at < NOW() - INTERVAL '90 days'
      AND persona_relevance < 0.3
    RETURNING id
  `);
  pruned += ageResult.rowCount;

  // Remove exact-content duplicates (keep most recent per vivan+category+content)
  const dupResult = await memPool.query(`
    DELETE FROM persona_observations
    WHERE id IN (
      SELECT id FROM (
        SELECT id,
          ROW_NUMBER() OVER (PARTITION BY vivan_urn, category, content ORDER BY persona_relevance DESC, created_at DESC) AS rn
        FROM persona_observations
      ) ranked
      WHERE rn > 1
    )
    RETURNING id
  `);
  pruned += dupResult.rowCount;

  return { pruned, age_pruned: ageResult.rowCount, duplicate_pruned: dupResult.rowCount };
}

/**
 * Phase 2: Pattern Clustering
 * Group related observations into behavioral_patterns.
 * For each active persona:
 * - Load observations not yet assigned to a pattern
 * - Group by category
 * - Within each category, check if observation matches existing pattern (content similarity)
 * - If match: increment evidence_count, add to observation_ids, update last_seen
 * - If no match: create new pattern from the observation
 */
async function phase2Cluster(memPool, config) {
  let patternsCreated = 0;
  let patternsExistingUpdated = 0;

  const evoPool = getEvolutionPool();
  const personas = await evoPool.query(
    "SELECT vivan_urn FROM persona_registry WHERE status = 'active'"
  );

  for (const persona of personas.rows) {
    const urn = persona.vivan_urn;

    // Load existing patterns
    const patterns = await memPool.query(
      'SELECT * FROM behavioral_patterns WHERE vivan_urn = $1',
      [urn]
    );
    const existingPatterns = patterns.rows;

    // Load observations not yet in any pattern
    const existingIds = existingPatterns.flatMap(p => p.observation_ids || []);
    let obsQuery = `
      SELECT id, category, content, persona_relevance
      FROM persona_observations
      WHERE vivan_urn = $1
    `;
    const params = [urn];

    if (existingIds.length > 0) {
      obsQuery += ` AND id != ALL($2)`;
      params.push(existingIds);
    }

    const observations = await memPool.query(obsQuery, params);

    for (const obs of observations.rows) {
      // Try to match with existing pattern (same category, similar content)
      const matchingPattern = existingPatterns.find(p =>
        p.category === obs.category &&
        contentSimilar(p.pattern_description, obs.content)
      );

      if (matchingPattern) {
        // Update existing pattern
        const updatedIds = [...(matchingPattern.observation_ids || []), obs.id];
        await memPool.query(`
          UPDATE behavioral_patterns
          SET evidence_count = evidence_count + 1,
              observation_ids = $1,
              last_seen = NOW()
          WHERE id = $2
        `, [updatedIds, matchingPattern.id]);
        matchingPattern.observation_ids = updatedIds;
        patternsExistingUpdated++;
      } else {
        // Create new pattern
        const embedding = await generateEmbedding(obs.content, config.vectrUrl);
        await memPool.query(`
          INSERT INTO behavioral_patterns
            (vivan_urn, pattern_description, category, evidence_count, observation_ids, embedding)
          VALUES ($1, $2, $3, 1, $4, $5)
        `, [urn, obs.content, obs.category, [obs.id], embedding]);
        patternsCreated++;
      }
    }
  }

  return {
    patterns_created: patternsCreated,
    existing_updated: patternsExistingUpdated,
    patterns_updated: patternsCreated + patternsExistingUpdated,
  };
}

/**
 * Simple content similarity check (substring-based).
 * Future: replace with Vectr embedding cosine similarity.
 */
function contentSimilar(a, b) {
  if (!a || !b) return false;
  const aLower = a.toLowerCase();
  const bLower = b.toLowerCase();
  // Check if key phrases overlap (>50% word overlap)
  const aWords = new Set(aLower.split(/\s+/).filter(w => w.length > 3));
  const bWords = new Set(bLower.split(/\s+/).filter(w => w.length > 3));
  if (aWords.size === 0 || bWords.size === 0) return false;
  const intersection = [...aWords].filter(w => bWords.has(w));
  const overlap = intersection.length / Math.min(aWords.size, bWords.size);
  return overlap > 0.5;
}

/**
 * Phase 3: Confidence Updates
 * Adjust persona_relevance for observations that recur across multiple conversations.
 * Observations that appear in patterns with high evidence_count get a relevance boost.
 */
async function phase3ConfidenceUpdate(memPool) {
  let updated = 0;

  // Boost relevance for observations in patterns with evidence_count >= 3
  const patterns = await memPool.query(`
    SELECT observation_ids FROM behavioral_patterns WHERE evidence_count >= 3
  `);

  const boostedIds = new Set();
  for (const pattern of patterns.rows) {
    for (const id of (pattern.observation_ids || [])) {
      boostedIds.add(id);
    }
  }

  if (boostedIds.size > 0) {
    const result = await memPool.query(`
      UPDATE persona_observations
      SET persona_relevance = LEAST(persona_relevance + 0.1, 1.0)
      WHERE id = ANY($1) AND persona_relevance < 0.9
      RETURNING id
    `, [Array.from(boostedIds)]);
    updated = result.rowCount;
  }

  return { updated };
}

/**
 * Phase 4: Evolution Triggers
 * Run consistency checks for all active personas, then evaluate evolution.
 */
async function phase4EvolutionTriggers(config) {
  // Step 1: Run consistency checks
  const checkResult = await checkAllPersonas(config);

  // Step 2: Evaluate evolution
  const evoResult = await evaluateAllEvolutions(config);

  return {
    ...checkResult,
    ...evoResult,
  };
}

export { phase1Prune, phase2Cluster, phase3ConfidenceUpdate, phase4EvolutionTriggers, contentSimilar };
