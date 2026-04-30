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
import { styleText } from 'node:util';

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
      helpDescription:
        'Lint BPMN diagrams against bpmnlint recommended rules and Camunda-specific rules. ' +
        'Supports file paths and stdin piping. Uses .bpmnlintrc if present, otherwise auto-detects ' +
        'the Camunda execution platform version from the BPMN file.',
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
    .sort((a, b) => {
      const parse = (s) => s.replace('camunda-cloud-', '').split('-').map(Number);
      const va = parse(a);
      const vb = parse(b);
      for (let i = 0; i < Math.max(va.length, vb.length); i++) {
        const diff = (va[i] || 0) - (vb[i] || 0);
        if (diff !== 0) return diff;
      }
      return 0;
    });

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
  const issues = [];
  const rows = [];
  const { pathStringify } = require('@bpmn-io/moddle-utils');

  for (const [ruleName, reports] of Object.entries(results)) {
    for (const report of reports) {
      const { category, id = '', message, name: reportName, path } = report;

      let elementRef = id;
      if (path) {
        elementRef = `${id}#${pathStringify(path)}`;
      }

      const displayName = reportName ?? ruleName;
      const severity = category === 'error' ? 'error' : 'warning';
      rows.push({ elementRef, severity, message, displayName, category });

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

  // Compute column widths from the uncolored values so padding lines up
  // regardless of terminal color support.
  const widths = rows.reduce(
    (acc, r) => ({
      elementRef: Math.max(acc.elementRef, r.elementRef.length),
      severity: Math.max(acc.severity, r.severity.length),
      message: Math.max(acc.message, r.message.length),
    }),
    { elementRef: 0, severity: 0, message: 0 },
  );

  const padEnd = (s, n) => s + ' '.repeat(Math.max(0, n - s.length));

  const lines = rows.map((r) => {
    const severityColor = r.category === 'error' ? 'red' : 'yellow';
    const severityCell = styleText(severityColor, padEnd(r.severity, widths.severity));
    return [
      ' ',
      padEnd(r.elementRef, widths.elementRef),
      severityCell,
      padEnd(r.message, widths.message),
      r.displayName,
    ].join('  ');
  });

  return { lines, errorCount, warningCount, issues };
}

// ---------------------------------------------------------------------------
// Subcommand: lint
// ---------------------------------------------------------------------------

async function lintSubcommand(args) {
  const logger = getLogger();

  const endOfOpts = args.indexOf('--');
  const optionArgs = endOfOpts === -1 ? args : args.slice(0, endOfOpts);
  const positionalArgs = endOfOpts === -1 ? [] : args.slice(endOfOpts + 1);

  // Handle --help/-h before interpreting args as file paths
  if (optionArgs.includes('--help') || optionArgs.includes('-h')) {
    logger.output('Usage: c8ctl bpmn lint [<file.bpmn>]');
    return;
  }

  // Reject unknown flags
  const unknownFlag = optionArgs.find((a) => a.startsWith('-'));
  if (unknownFlag) {
    throw new Error(`Unknown flag: ${unknownFlag}. Usage: c8ctl bpmn lint [<file.bpmn>]`);
  }

  const filePath = positionalArgs[0] ?? optionArgs[0];

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

  // Pass our plugin-scoped `require` to NodeResolver so bpmnlint resolves
  // `bpmnlint-plugin-camunda-compat` from c8ctl's installation, not the
  // user's CWD. Without this, `bpmn lint` only works when run from a
  // directory that happens to have the plugin in its node_modules.
  const linter = new Linter({ config, resolver: new NodeResolver({ require }) });
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
    const sourceLabel = input.source === 'stdin' ? 'stdin' : resolvePath(input.source);
    logger.output('');
    logger.output(styleText('underline', sourceLabel));
    for (const line of lines) logger.output(line);

    const pluralize = (word, count) => (count === 1 ? word : `${word}s`);
    const summary =
      `✖ ${problemCount} ${pluralize('problem', problemCount)} ` +
      `(${errorCount} ${pluralize('error', errorCount)}, ` +
      `${warningCount} ${pluralize('warning', warningCount)})`;
    const summaryColor = errorCount > 0 ? ['bold', 'red'] : ['bold', 'yellow'];
    logger.output('');
    logger.output(styleText(summaryColor, summary));
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
  const logger = getLogger();
  const cmd = metadata.commands.bpmn;
  logger.output('Usage: c8ctl bpmn <subcommand> [options]');
  logger.output('');
  if (cmd.helpDescription) {
    logger.output(cmd.helpDescription);
    logger.output('');
  }
  logger.output('Subcommands:');
  for (const sub of cmd.subcommands) {
    logger.output(`  ${sub.name.padEnd(16)} ${sub.description}`);
  }
  logger.output('');
  logger.output('Examples:');
  for (const ex of cmd.examples) {
    logger.output(`  ${ex.command}`);
  }
}

export const commands = {
  bpmn: async (args) => {
    const subcommand = args?.[0];
    const subArgs = args?.slice(1) ?? [];

    if (!subcommand || subcommand === '--help' || subcommand === '-h') {
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
