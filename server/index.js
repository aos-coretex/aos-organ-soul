/**
 * Soul (#90) — Persona Memory (Monad Leg 5)
 *
 * "Who am I?" — Tracks Vivan behavior, maintains consistency against
 * persona baselines, drives persona evolution.
 *
 * Dual database: soul_memory (prunable observations) + soul_evolution (permanent definitions)
 * Internal agents: behavioral observer, consistency checker, evolution analyst, dream cycle
 */
import { createOrgan } from '@coretex/organ-boot';
import config from './config.js';
import { initMemoryPool, closeMemoryPool, getMemoryPool } from './db/memory-pool.js';
import { initEvolutionPool, closeEvolutionPool, getEvolutionPool } from './db/evolution-pool.js';
import { verifySchema } from './db/schema.js';
import { createPersonaRoutes } from './routes/personas.js';
import { createAnalysisRoutes } from './routes/analysis.js';
import { handleDirectedMessage } from './handlers/spine-commands.js';
import { onConversationCompleted, onSessionEnd } from '../agents/behavioral-observer.js';
import { isVectrAvailable } from '../lib/vectr-client.js';

let spineRef = null;

// Initialize both databases
const memStats = await initMemoryPool();
const evoStats = await initEvolutionPool();
await verifySchema();

const services = { config };

const organ = await createOrgan({
  name: config.name,
  port: config.port,
  binding: config.binding,
  spineUrl: config.spineUrl,

  dependencies: ['Spine', 'Hippocampus', 'Vectr', 'Graph'],

  routes: (app) => {
    app.use('/personas', createPersonaRoutes(config));
    app.use('/personas', createAnalysisRoutes(config));

    // Dream trigger via HTTP
    app.post('/dream', async (req, res) => {
      try {
        const { runDreamCycle } = await import('../agents/dream-cycle.js');
        const report = await runDreamCycle(config);
        res.json(report);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
  },

  onMessage: async (envelope) => handleDirectedMessage(envelope, services),

  onBroadcast: async (envelope) => {
    const eventType = envelope.payload?.event_type || envelope.event_type;

    switch (eventType) {
      case 'conversation_completed': {
        const log = {
          timestamp: new Date().toISOString(),
          event: 'broadcast_received',
          type: 'conversation_completed',
          conversation: envelope.payload?.conversation_urn,
        };
        process.stdout.write(JSON.stringify(log) + '\n');

        // Fire-and-forget: behavioral observer processes asynchronously
        onConversationCompleted(envelope.payload || envelope, config).catch(err => {
          const errLog = { timestamp: new Date().toISOString(), event: 'observer_error', type: 'conversation_completed', error: err.message };
          process.stdout.write(JSON.stringify(errLog) + '\n');
        });
        break;
      }

      case 'session_end': {
        const log = {
          timestamp: new Date().toISOString(),
          event: 'broadcast_received',
          type: 'session_end',
          session: envelope.payload?.session_id,
        };
        process.stdout.write(JSON.stringify(log) + '\n');

        // Fire-and-forget: behavioral observer processes asynchronously
        onSessionEnd(envelope.payload || envelope, config).catch(err => {
          const errLog = { timestamp: new Date().toISOString(), event: 'observer_error', type: 'session_end', error: err.message };
          process.stdout.write(JSON.stringify(errLog) + '\n');
        });
        break;
      }
    }
  },

  subscriptions: [
    { event_type: 'conversation_completed', source: 'Hippocampus' },
    { event_type: 'session_end' },
  ],

  onStartup: async ({ spine }) => {
    spineRef = spine;
  },

  healthCheck: async () => {
    // Dual database health
    let memOk = false, evoOk = false;
    let activePersonas = 0, totalObservations = 0, embeddedObservations = 0;

    try {
      const memPool = getMemoryPool();
      const memResult = await memPool.query(`
        SELECT
          (SELECT COUNT(*) FROM persona_observations) AS total_obs,
          (SELECT COUNT(*) FROM persona_observations WHERE embedding IS NOT NULL) AS embedded_obs,
          (SELECT COUNT(*) FROM behavioral_patterns) AS patterns,
          (SELECT COUNT(*) FROM consistency_checks) AS checks
      `);
      totalObservations = parseInt(memResult.rows[0].total_obs, 10);
      embeddedObservations = parseInt(memResult.rows[0].embedded_obs, 10);
      memOk = true;
    } catch { /* soul_memory unavailable */ }

    try {
      const evoPool = getEvolutionPool();
      const evoResult = await evoPool.query(`
        SELECT
          (SELECT COUNT(*) FROM persona_registry WHERE status = 'active') AS active,
          (SELECT COUNT(*) FROM persona_definitions) AS versions,
          (SELECT COUNT(*) FROM evolution_events) AS evolutions
      `);
      activePersonas = parseInt(evoResult.rows[0].active, 10);
      evoOk = true;
    } catch { /* soul_evolution unavailable */ }

    const embeddingCoverage = totalObservations > 0
      ? Math.round((embeddedObservations / totalObservations) * 100)
      : 100;

    return {
      soul_memory: memOk ? 'ok' : 'down',
      soul_evolution: evoOk ? 'ok' : 'down',
      active_personas: activePersonas,
      total_observations: totalObservations,
      embedding_coverage_pct: embeddingCoverage,
      vectr_available: await isVectrAvailable(config.vectrUrl),
      dream_enabled: config.dreamEnabled,
    };
  },

  introspectCheck: async () => {
    return {
      connected_producers: {
        Hippocampus: 'subscribed',
        Vectr: (await isVectrAvailable(config.vectrUrl)) ? 'available' : 'unavailable',
      },
      connected_consumers: ['Thalamus', 'Phi', 'Axon'],
      db_stats: {
        soul_memory: memStats,
        soul_evolution: evoStats,
      },
      dream_enabled: config.dreamEnabled,
      thresholds: config.thresholds,
      evolution_config: config.evolution,
    };
  },

  onShutdown: async () => {
    await closeMemoryPool();
    await closeEvolutionPool();
  },
});
