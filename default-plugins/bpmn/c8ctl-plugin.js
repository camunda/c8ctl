/**
 * c8ctl-plugin-bpmn
 *
 * Lint BPMN diagrams against recommended and Camunda rules.
 *
 * Usage:
 *   c8ctl bpmn lint <file.bpmn>
 *   cat file.bpmn | c8ctl bpmn lint
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export const metadata = {
  name: 'bpmn',
  description: 'Lint BPMN diagrams',
  commands: {
    bpmn: {
      description: 'BPMN tooling — lint diagrams (supports stdin piping)',
      subcommands: [
        { name: 'lint', description: 'Lint a BPMN diagram against recommended and Camunda rules' },
      ],
      examples: [
        { command: 'c8ctl bpmn lint process.bpmn', description: 'Lint a BPMN file with Camunda rules' },
        { command: 'cat process.bpmn | c8ctl bpmn lint', description: 'Lint from stdin' },
      ],
    },
  },
};

// ---------------------------------------------------------------------------
// Runtime helpers
// ---------------------------------------------------------------------------

function getLogger() {
  if (globalThis.c8ctl) {
    return globalThis.c8ctl.getLogger();
  }
  return {
    info: console.log,
    warn: console.warn,
    error: console.error,
    debug: () => {},
    output: console.log,
    json: (data) => console.log(JSON.stringify(data, null, 2)),
  };
}

function isJsonMode() {
  return globalThis.c8ctl?.outputMode === 'json';
}

/**
 * Read BPMN XML from a file path or stdin. Returns null if no input is available.
 */
function readBpmnInput(filePath) {
  if (filePath) {
    const resolved = resolvePath(filePath);
    if (!existsSync(resolved)) {
      throw new Error(`File not found: ${filePath}`);
    }
    return { xml: readFileSync(resolved, 'utf-8'), source: resolved };
  }

  // Read from stdin if not connected to a terminal. readFileSync(0) reads
  // from file descriptor 0 (stdin) — portable across platforms.
  if (!process.stdin.isTTY) {
    let xml = '';
    try {
      xml = readFileSync(0, 'utf-8');
    } catch (error) {
      // EAGAIN/EWOULDBLOCK: non-blocking stdin pipe with no data (e.g. spawned
      // via execFile without a writer). Treat as no input.
      if (error.code !== 'EAGAIN' && error.code !== 'EWOULDBLOCK') throw error;
    }
    if (!xml.trim()) return null;
    return { xml, source: 'stdin' };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Lint internals
// ---------------------------------------------------------------------------

function detectCamundaCloudVersion(rootElement) {
  const attrs = rootElement.$attrs ?? {};
  const platform = attrs['modeler:executionPlatform'];
  const version = attrs['modeler:executionPlatformVersion'];
  if (platform !== 'Camunda Cloud' || !version) return null;
  const match = version.match(/^(\d+\.\d+)/);
  return match ? match[1] : null;
}

function resolveCamundaCompatConfig(version) {
  const plugin = require('bpmnlint-plugin-camunda-compat');
  const configs = plugin.configs;

  const configName = `camunda-cloud-${version.replace('.', '-')}`;
  if (configs[configName]) {
    return `plugin:camunda-compat/${configName}`;
  }

  const cloudConfigs = Object.keys(configs)
    .filter((k) => k.startsWith('camunda-cloud-'))
    .sort();

  if (cloudConfigs.length > 0) {
    return `plugin:camunda-compat/${cloudConfigs[cloudConfigs.length - 1]}`;
  }

  return null;
}

function buildLintConfig(rootElement) {
  const rcPath = resolvePath('.bpmnlintrc');
  if (existsSync(rcPath)) {
    return JSON.parse(readFileSync(rcPath, 'utf-8'));
  }

  const config = { extends: ['bpmnlint:recommended'] };

  const version = detectCamundaCloudVersion(rootElement);
  if (version) {
    const compatConfig = resolveCamundaCompatConfig(version);
    if (compatConfig) config.extends.push(compatConfig);
  }

  return config;
}

function formatLintResults(results) {
  let errorCount = 0;
  let warningCount = 0;
  const lines = [];
  const issues = [];

  for (const [ruleName, reports] of Object.entries(results)) {
    for (const report of reports) {
      const { category, id = '', message, name: reportName, path } = report;

      let elementRef = id;
      if (path) {
        const { pathStringify } = require('@bpmn-io/moddle-utils');
        elementRef = `${id}#${pathStringify(path)}`;
      }

      const displayName = reportName ?? ruleName;
      const prefix = category === 'error' ? 'error' : 'warning';
      lines.push(`  ${elementRef}  ${prefix}  ${message}  ${displayName}`);

      issues.push({
        rule: reportName ?? ruleName,
        elementId: id || null,
        message,
        category: category === 'warn' ? 'warning' : category,
        ...(path ? { path } : {}),
      });

      if (category === 'error') errorCount++;
      else warningCount++;
    }
  }

  return { lines, errorCount, warningCount, issues };
}

// ---------------------------------------------------------------------------
// Subcommand: lint
// ---------------------------------------------------------------------------

async function lintSubcommand(args) {
  const logger = getLogger();
  const filePath = args[0];

  const input = readBpmnInput(filePath);
  if (!input) {
    throw new Error('No BPMN input provided. Pass a file path or pipe BPMN XML via stdin.');
  }

  const BpmnModdle = (await import('bpmn-moddle')).default;
  const zeebeSchema = (
    await import('zeebe-bpmn-moddle/resources/zeebe.json', { with: { type: 'json' } })
  ).default;

  const moddle = new BpmnModdle({ zeebe: zeebeSchema });

  let rootElement;
  try {
    const result = await moddle.fromXML(input.xml);
    rootElement = result.rootElement;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse BPMN: ${message}`);
  }

  const config = buildLintConfig(rootElement);
  const { Linter } = require('bpmnlint');
  const NodeResolver = require('bpmnlint/lib/resolver/node-resolver');

  const linter = new Linter({ config, resolver: new NodeResolver() });
  const results = await linter.lint(rootElement);

  const { lines, errorCount, warningCount, issues } = formatLintResults(results);

  if (isJsonMode()) {
    logger.json({
      file: input.source,
      issues,
      errorCount,
      warningCount,
    });
    if (errorCount > 0) {
      process.exitCode = 1;
    }
    return;
  }

  const problemCount = errorCount + warningCount;
  if (problemCount > 0) {
    logger.output('');
    logger.output(resolvePath(input.source));
    for (const line of lines) logger.output(line);

    const pluralize = (word, count) => (count === 1 ? word : `${word}s`);
    logger.output('');
    logger.output(
      `✖ ${problemCount} ${pluralize('problem', problemCount)} ` +
        `(${errorCount} ${pluralize('error', errorCount)}, ` +
        `${warningCount} ${pluralize('warning', warningCount)})`,
    );
  }

  if (errorCount > 0) {
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Plugin commands export
// ---------------------------------------------------------------------------

const VALID_SUBCOMMANDS = ['lint'];

function printUsage() {
  console.log('Usage:');
  console.log('  c8ctl bpmn lint <file.bpmn>');
  console.log('  cat file.bpmn | c8ctl bpmn lint');
  console.log('');
  console.log('Subcommands:');
  console.log('  lint  Lint a BPMN diagram against recommended and Camunda rules');
  console.log('');
  console.log('Examples:');
  console.log('  c8ctl bpmn lint process.bpmn');
  console.log('  cat process.bpmn | c8ctl bpmn lint');
}

export const commands = {
  bpmn: async (args) => {
    const subcommand = args?.[0];
    const subArgs = args?.slice(1) ?? [];

    if (!subcommand) {
      printUsage();
      return;
    }
    if (!VALID_SUBCOMMANDS.includes(subcommand)) {
      printUsage();
      process.exitCode = 1;
      return;
    }

    try {
      if (subcommand === 'lint') {
        await lintSubcommand(subArgs);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const logger = getLogger();
      logger.error(`Failed to bpmn ${subcommand}: ${message}`);
      process.exitCode = 1;
    }
  },
};
