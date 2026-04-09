/**
 * Analysis routes — consistency checking via HTTP.
 * These supplement the Spine-triggered checks with manual HTTP access.
 */
import { Router } from 'express';
import { checkConsistency, checkAllPersonas } from '../../agents/consistency-checker.js';

export function createAnalysisRoutes(config) {
  const router = Router();

  /**
   * POST /personas/:urn/analyze — Run consistency check for one persona.
   * Body: { since: ISO date (optional), limit: number (optional) }
   */
  router.post('/:urn/analyze', async (req, res) => {
    try {
      const { urn } = req.params;
      const since = req.body.since ? new Date(req.body.since) : undefined;
      const limit = req.body.limit ? parseInt(req.body.limit, 10) : undefined;

      const result = await checkConsistency(urn, config, { since, limit });
      if (result.errors.length > 0 && result.check_id === null) {
        return res.status(400).json({ error: result.errors[0] });
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /analyze/all — Run consistency checks for all active personas.
   * Used by dream cycle and manual sweep.
   */
  router.post('/all', async (req, res) => {
    try {
      const result = await checkAllPersonas(config);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
