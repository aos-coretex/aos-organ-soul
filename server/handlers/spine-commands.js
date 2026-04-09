/**
 * Spine directed OTM message handler for Soul.
 * Maps incoming message event_types to organ operations.
 */
import { getEvolutionPool } from '../db/evolution-pool.js';
import { getMemoryPool } from '../db/memory-pool.js';
import { checkConsistency } from '../../agents/consistency-checker.js';
import { evaluateEvolution } from '../../agents/evolution-analyst.js';
import { runDreamCycle } from '../../agents/dream-cycle.js';

/**
 * Handle a directed OTM message.
 * @param {object} envelope — Spine OTM envelope
 * @param {object} services — { config }
 * @returns {object|null} Response payload (auto-sent via reply_to if set)
 */
export async function handleDirectedMessage(envelope, services) {
  const { payload } = envelope;
  const { config } = services;

  try {
    switch (payload?.event_type) {

      case 'get_persona':
        return await handleGetPersona(payload);

      case 'create_persona':
        return await handleCreatePersona(payload, config);

      case 'get_observations':
        return await handleGetObservations(payload);

      case 'analyze':
        return await handleAnalyze(payload, config);

      case 'evolve':
        return await handleEvolve(payload, config);

      case 'dream':
        return await handleDream(config);

      case 'get_history':
        return await handleGetHistory(payload);

      default:
        return { event_type: 'error', error: `Unknown event_type: ${payload?.event_type}` };
    }
  } catch (err) {
    return { event_type: 'error', error: err.message };
  }
}

async function handleGetPersona(payload) {
  const { vivan_urn, version } = payload;
  if (!vivan_urn) return { event_type: 'error', error: 'vivan_urn required' };

  const evoPool = getEvolutionPool();
  const registry = await evoPool.query(
    'SELECT * FROM persona_registry WHERE vivan_urn = $1', [vivan_urn]
  );
  if (registry.rows.length === 0) {
    return { event_type: 'persona_not_found', vivan_urn };
  }

  const v = version || registry.rows[0].current_version;
  const def = await evoPool.query(
    'SELECT * FROM persona_definitions WHERE vivan_urn = $1 AND version = $2',
    [vivan_urn, v]
  );

  return {
    event_type: 'persona_response',
    vivan_urn,
    version: v,
    baseline: def.rows[0]?.baseline_json || null,
    status: def.rows[0]?.status || null,
    registry: registry.rows[0],
  };
}

async function handleCreatePersona(payload, config) {
  const { template_content, template_path } = payload;
  const { parseTemplate } = await import('../../lib/template-parser.js');
  const { mintVivanUrn } = await import('../../lib/graph-adapter.js');

  const content = template_content || '';
  if (!content && !template_path) {
    return { event_type: 'error', error: 'template_content or template_path required' };
  }

  let raw = content;
  if (template_path && !content) {
    const { readFileSync } = await import('node:fs');
    try { raw = readFileSync(template_path, 'utf-8'); }
    catch (err) { return { event_type: 'error', error: `Cannot read template: ${err.message}` }; }
  }

  const { baseline, errors } = parseTemplate(raw);
  if (errors.length > 0) {
    return { event_type: 'error', error: 'Template validation failed', details: errors };
  }

  // mintVivanUrn is async — registers with Graph organ (fail-open)
  const urn = await mintVivanUrn(config.graphUrl, { name: baseline.name });
  const evoPool = getEvolutionPool();
  const client = await evoPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO persona_definitions (vivan_urn, version, baseline_json, status) VALUES ($1, 1, $2, 'active')`,
      [urn, JSON.stringify(baseline)]
    );
    await client.query(
      `INSERT INTO persona_registry (vivan_urn, current_version, status, template_source) VALUES ($1, 1, 'active', $2)`,
      [urn, template_path || 'spine']
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    return { event_type: 'error', error: err.message };
  } finally {
    client.release();
  }

  return { event_type: 'persona_created', vivan_urn: urn, version: 1, baseline };
}

async function handleGetObservations(payload) {
  const { vivan_urn, category, limit = 50, since } = payload;
  if (!vivan_urn) return { event_type: 'error', error: 'vivan_urn required' };

  const memPool = getMemoryPool();
  let query = 'SELECT * FROM persona_observations WHERE vivan_urn = $1';
  const params = [vivan_urn];
  let paramIdx = 2;

  if (category) {
    query += ` AND category = $${paramIdx++}`;
    params.push(category);
  }
  if (since) {
    query += ` AND created_at >= $${paramIdx++}`;
    params.push(since);
  }

  query += ` ORDER BY created_at DESC LIMIT $${paramIdx}`;
  params.push(limit);

  const result = await memPool.query(query, params);
  return { event_type: 'observations_response', vivan_urn, observations: result.rows, count: result.rows.length };
}

async function handleAnalyze(payload, config) {
  const { vivan_urn } = payload;
  if (!vivan_urn) return { event_type: 'error', error: 'vivan_urn required' };
  const result = await checkConsistency(vivan_urn, config);
  return { event_type: 'analyze_response', ...result };
}

async function handleEvolve(payload, config) {
  const { vivan_urn } = payload;
  if (!vivan_urn) return { event_type: 'error', error: 'vivan_urn required' };
  const result = await evaluateEvolution(vivan_urn, config, 'manual');
  return { event_type: 'evolve_response', ...result };
}

async function handleDream(config) {
  const result = await runDreamCycle(config);
  return { event_type: 'dream_response', ...result };
}

async function handleGetHistory(payload) {
  const { vivan_urn } = payload;
  if (!vivan_urn) return { event_type: 'error', error: 'vivan_urn required' };

  const evoPool = getEvolutionPool();
  const versions = await evoPool.query(
    'SELECT version, status, created_at, superseded_at, changes_summary FROM persona_definitions WHERE vivan_urn = $1 ORDER BY version DESC',
    [vivan_urn]
  );
  const events = await evoPool.query(
    'SELECT * FROM evolution_events WHERE vivan_urn = $1 ORDER BY created_at DESC',
    [vivan_urn]
  );

  return { event_type: 'history_response', vivan_urn, versions: versions.rows, events: events.rows };
}
