/**
 * Soul configuration — environment-driven, AOS/SAAS aware.
 * Soul has two databases (unique among Monad organs).
 */

const env = process.env.NODE_ENV || 'development';
const isAOS = env !== 'production';

export default {
  name: 'Soul',
  port: parseInt(process.env.SOUL_PORT || (isAOS ? '4009' : '3909'), 10),
  binding: '127.0.0.1',
  spineUrl: process.env.SPINE_URL || (isAOS ? 'http://127.0.0.1:4000' : 'http://127.0.0.1:3900'),
  hippocampusUrl: process.env.HIPPOCAMPUS_URL || (isAOS ? 'http://127.0.0.1:4008' : 'http://127.0.0.1:3908'),
  vectrUrl: process.env.VECTR_URL || (isAOS ? 'http://127.0.0.1:4001' : 'http://127.0.0.1:3901'),
  graphUrl: process.env.GRAPH_URL || (isAOS ? 'http://127.0.0.1:4020' : 'http://127.0.0.1:3920'),
  env,

  // Soul-specific
  dreamEnabled: process.env.DREAM_ENABLED === 'true',  // Default disabled
  dreamCronHour: parseInt(process.env.DREAM_CRON_HOUR || '8', 10),

  // Consistency thresholds (configurable — future genome governance)
  thresholds: {
    stable: parseFloat(process.env.SOUL_THRESHOLD_STABLE || '0.8'),
    monitor: parseFloat(process.env.SOUL_THRESHOLD_MONITOR || '0.5'),
    // Below monitor = intervene
  },

  // Evolution thresholds
  evolution: {
    minGrowthObservations: parseInt(process.env.SOUL_MIN_GROWTH || '10', 10),
    minConsistencyScore: parseFloat(process.env.SOUL_MIN_CONSISTENCY || '0.6'),
  },

  // Observation categories (Soul's own taxonomy — NOT Minder's levels)
  categories: ['PREFERENCE', 'TRAIT', 'PATTERN', 'MOTIVATION', 'PREDICTION'],
};
