/**
 * Persona management routes — CRUD + version history.
 * All persona state lives in soul_evolution database.
 * Observation counts come from soul_memory (cross-DB read).
 */
import { Router } from 'express';
import { getEvolutionPool } from '../db/evolution-pool.js';
import { getMemoryPool } from '../db/memory-pool.js';
import { parseTemplate } from '../../lib/template-parser.js';
import { mintVivanUrn } from '../../lib/graph-adapter.js';
import { readFileSync } from 'node:fs';

export function createPersonaRoutes(config) {
  const router = Router();

  /**
   * POST /personas — Instantiate persona from template.
   * Body: { template_path: string } OR { template_content: string }
   * Returns: { urn, version, baseline, status }
   */
  router.post('/', async (req, res) => {
    try {
      const { template_path, template_content } = req.body;

      let content;
      if (template_content) {
        content = template_content;
      } else if (template_path) {
        try {
          content = readFileSync(template_path, 'utf-8');
        } catch (err) {
          return res.status(400).json({ error: `Cannot read template: ${err.message}` });
        }
      } else {
        return res.status(400).json({ error: 'Provide template_path or template_content' });
      }

      // Parse template
      const { baseline, errors } = parseTemplate(content);
      if (errors.length > 0) {
        return res.status(400).json({ error: 'Template validation failed', details: errors });
      }

      // Mint URN via Graph organ (fail-open: local URN if Graph unavailable)
      const urn = await mintVivanUrn(config.graphUrl, { name: baseline.name });
      const version = 1;

      const pool = getEvolutionPool();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Insert persona definition v1
        await client.query(`
          INSERT INTO persona_definitions (vivan_urn, version, baseline_json, status)
          VALUES ($1, $2, $3, 'active')
        `, [urn, version, JSON.stringify(baseline)]);

        // Insert persona registry entry
        await client.query(`
          INSERT INTO persona_registry (vivan_urn, current_version, status, template_source)
          VALUES ($1, $2, 'active', $3)
        `, [urn, version, template_path || 'inline']);

        await client.query('COMMIT');

        res.status(201).json({
          urn,
          version,
          baseline,
          status: 'active',
          template_source: template_path || 'inline',
        });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /personas/:urn — Retrieve persona definition.
   * Query params: ?version=N (optional, defaults to current active)
   * Returns: { urn, version, baseline, status, observations, consistency_score }
   */
  router.get('/:urn', async (req, res) => {
    try {
      const { urn } = req.params;
      const requestedVersion = req.query.version ? parseInt(req.query.version, 10) : null;

      const evoPool = getEvolutionPool();

      // Get registry entry
      const registryResult = await evoPool.query(
        'SELECT * FROM persona_registry WHERE vivan_urn = $1',
        [urn]
      );
      if (registryResult.rows.length === 0) {
        return res.status(404).json({ error: 'Persona not found' });
      }
      const registry = registryResult.rows[0];

      // Get definition (specific version or current)
      const version = requestedVersion || registry.current_version;
      const defResult = await evoPool.query(
        'SELECT * FROM persona_definitions WHERE vivan_urn = $1 AND version = $2',
        [urn, version]
      );
      if (defResult.rows.length === 0) {
        return res.status(404).json({ error: `Version ${version} not found` });
      }
      const definition = defResult.rows[0];

      // Get observation count from soul_memory (cross-DB read)
      let observationCount = registry.total_observations;
      try {
        const memPool = getMemoryPool();
        const obsResult = await memPool.query(
          'SELECT COUNT(*) AS count FROM persona_observations WHERE vivan_urn = $1',
          [urn]
        );
        observationCount = parseInt(obsResult.rows[0].count, 10);
      } catch {
        // soul_memory unavailable — use cached count from registry
      }

      res.json({
        urn,
        version: definition.version,
        is_current: definition.version === registry.current_version,
        baseline: definition.baseline_json,
        status: definition.status,
        persona_status: registry.status,
        total_observations: observationCount,
        last_consistency_score: registry.last_consistency_score,
        last_evolved_at: registry.last_evolved_at,
        created_at: definition.created_at,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /personas/:urn/history — Retrieve version history.
   * Returns: array of { version, status, created_at, superseded_at, changes_summary }
   */
  router.get('/:urn/history', async (req, res) => {
    try {
      const { urn } = req.params;
      const pool = getEvolutionPool();

      const result = await pool.query(
        `SELECT version, status, created_at, superseded_at, changes_summary
         FROM persona_definitions
         WHERE vivan_urn = $1
         ORDER BY version DESC`,
        [urn]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Persona not found' });
      }

      // Get evolution events for context
      const events = await pool.query(
        `SELECT from_version, to_version, trigger_source, reason, created_at
         FROM evolution_events
         WHERE vivan_urn = $1
         ORDER BY created_at DESC`,
        [urn]
      );

      res.json({
        urn,
        versions: result.rows,
        evolution_events: events.rows,
        total_versions: result.rows.length,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /personas — List all personas.
   * Query params: ?status=active (optional filter)
   * Returns: array of registry entries
   */
  router.get('/', async (req, res) => {
    try {
      const { status } = req.query;
      const pool = getEvolutionPool();

      let query = 'SELECT * FROM persona_registry';
      const params = [];

      if (status) {
        query += ' WHERE status = $1';
        params.push(status);
      }

      query += ' ORDER BY updated_at DESC';

      const result = await pool.query(query, params);
      res.json({ personas: result.rows, count: result.rows.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * PATCH /personas/:urn/status — Update persona status.
   * Body: { status: 'active' | 'inactive' | 'archived' }
   */
  router.patch('/:urn/status', async (req, res) => {
    try {
      const { urn } = req.params;
      const { status } = req.body;
      const valid = ['active', 'inactive', 'archived'];
      if (!valid.includes(status)) {
        return res.status(400).json({ error: `Invalid status. Must be one of: ${valid.join(', ')}` });
      }

      const pool = getEvolutionPool();
      const result = await pool.query(
        `UPDATE persona_registry SET status = $1, updated_at = NOW()
         WHERE vivan_urn = $2 RETURNING *`,
        [status, urn]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Persona not found' });
      }

      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
