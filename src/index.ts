#!/usr/bin/env node
/**
 * c8ctl - Camunda 8 CLI
 * Node.js entrypoint
 */

import { runCli } from './cli.ts';

runCli(process.argv.slice(2)).catch((error) => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
