/**
 * Chaos test runner — shuffles test files into a random order before execution.
 *
 * Usage:
 *   node tests/utils/chaos-runner.mjs <test-dir> [--setup-first <setup-file>]
 *
 * Environment:
 *   CHAOS_SEED  Integer seed for reproducible ordering. Printed on every run
 *               so failures can be reproduced with:
 *               CHAOS_SEED=<seed> npm run test:integration:chaos
 *
 * Examples:
 *   node tests/utils/chaos-runner.mjs tests/integration
 *   node tests/utils/chaos-runner.mjs tests/unit --setup-first tests/unit/setup.test.ts
 *   CHAOS_SEED=42 node tests/utils/chaos-runner.mjs tests/integration
 */

import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Fisher-Yates shuffle driven by a simple 32-bit seed (mulberry32 hash step).
 * Deterministic for a given seed so failures are reproducible.
 */
function shuffleWithSeed(arr, seed) {
  const a = [...arr];
  let s = seed >>> 0;
  for (let i = a.length - 1; i > 0; i--) {
    // Advance the state
    s = (s + 0x9e3779b9) >>> 0;
    s = (s ^ (s >>> 16)) >>> 0;
    s = Math.imul(s, 0x45d9f3b) >>> 0;
    s = (s ^ (s >>> 16)) >>> 0;
    s = Math.imul(s, 0x45d9f3b) >>> 0;
    s = (s ^ (s >>> 16)) >>> 0;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// --- Parse arguments -------------------------------------------------------

const args = process.argv.slice(2);
const testDir = args[0];

if (!testDir) {
  console.error('Usage: node chaos-runner.mjs <test-dir> [--setup-first <setup-file>]');
  process.exit(1);
}

let setupFirst = null;
const setupIdx = args.indexOf('--setup-first');
if (setupIdx !== -1) {
  setupFirst = resolve(args[setupIdx + 1]);
}

// --- Build file list -------------------------------------------------------

const allFiles = readdirSync(testDir)
  .filter(f => f.endsWith('.test.ts'))
  .map(f => join(testDir, f));

const filesToShuffle = setupFirst
  ? allFiles.filter(f => resolve(f) !== setupFirst)
  : allFiles;

// --- Shuffle ---------------------------------------------------------------

const seed = process.env.CHAOS_SEED !== undefined
  ? (parseInt(process.env.CHAOS_SEED, 10) >>> 0)
  : Math.floor(Math.random() * 2 ** 32);

const shuffled = shuffleWithSeed(filesToShuffle, seed);
const orderedFiles = setupFirst ? [setupFirst, ...shuffled] : shuffled;

// --- Print order for reproducibility --------------------------------------

const basename = f => f.split('/').pop();
const scriptName = process.env.npm_lifecycle_event ?? 'test:integration:chaos';
console.log(`\n🎲  Chaos seed: ${seed}`);
console.log(`   Reproduce: CHAOS_SEED=${seed} npm run ${scriptName}`);
console.log(`   Order: ${orderedFiles.map(basename).join(' → ')}\n`);

// --- Run -------------------------------------------------------------------

// --test-concurrency=1 is intentional: files must run sequentially so the
// shuffled order is actually observed and ordering dependencies are exposed.
const result = spawnSync('node', ['--test', '--test-concurrency=1', ...orderedFiles], {
  stdio: 'inherit',
  env: { ...process.env, CHAOS_SEED: String(seed) },
});

process.exit(result.status ?? 1);
