#!/usr/bin/env node
/**
 * Soul dream cycle — standalone runner for LaunchAgent or CLI.
 * Usage: DREAM_ENABLED=true node scripts/run-dream.js
 */
import { initMemoryPool, closeMemoryPool } from '../server/db/memory-pool.js';
import { initEvolutionPool, closeEvolutionPool } from '../server/db/evolution-pool.js';
import { runDreamCycle } from '../agents/dream-cycle.js';
import config from '../server/config.js';

if (!config.dreamEnabled) {
  const log = { timestamp: new Date().toISOString(), event: 'dream_skipped', reason: 'DREAM_ENABLED=false' };
  process.stdout.write(JSON.stringify(log) + '\n');
  process.exit(0);
}

async function main() {
  try {
    await initMemoryPool();
    await initEvolutionPool();

    const report = await runDreamCycle(config);

    const log = {
      timestamp: new Date().toISOString(),
      event: 'dream_script_complete',
      cycle: report.cycle_number,
      duration_ms: report.duration_ms,
      errors: report.errors.length,
    };
    process.stdout.write(JSON.stringify(log) + '\n');

    process.exit(report.errors.length > 0 ? 1 : 0);
  } catch (err) {
    const log = { timestamp: new Date().toISOString(), event: 'dream_script_error', error: err.message };
    process.stdout.write(JSON.stringify(log) + '\n');
    process.exit(1);
  } finally {
    await closeMemoryPool();
    await closeEvolutionPool();
  }
}

main();
