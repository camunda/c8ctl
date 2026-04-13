/**
 * c8ctl-plugin-bpmn
 *
 * Lint BPMN diagrams and apply element templates.
 *
 * Usage:
 *   c8ctl bpmn lint <file.bpmn>
 *   cat file.bpmn | c8ctl bpmn lint
 *   c8ctl bpmn apply-element-template <template.json> <element-id> <file.bpmn>
 *   c8ctl bpmn apply-element-template -i <template.json> <element-id> <file.bpmn>
 *   cat file.bpmn | c8ctl bpmn apply-element-template <template.json> <element-id>
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { createRequire } from 'node:module';

// bpmnlint is CJS — use createRequire to load it and its resolver
const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export const metadata = {
  name: 'bpmn',
  description: 'Lint BPMN diagrams and apply element templates',
  commands: {
    'bpmn': {
      description: 'BPMN tooling — lint diagrams and apply element templates',
      examples: [
        { command: 'c8ctl bpmn lint process.bpmn', description: 'Lint a BPMN file with Camunda rules' },
        { command: 'cat process.bpmn | c8ctl bpmn lint', description: 'Lint from stdin' },
        { command: 'c8ctl bpmn apply-element-template template.json Task_1 process.bpmn', description: 'Apply an element template' },
        { command: 'c8ctl bpmn apply-element-template --in-place template.json Task_1 process.bpmn', description: 'Apply in-place' },
      ],
    },
  },
};

// ---------------------------------------------------------------------------
// Helpers
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
    json: (data) => console.log(JSON.stringify(data, null, 2)),
  };
}

function isJsonMode() {
  return globalThis.c8ctl?.outputMode === 'json';
}

/**
 * Read BPMN XML from a file path or stdin.
 * Returns null if no input is available.
 */
function readBpmnInput(filePath) {
  if (filePath) {
    const resolved = resolvePath(filePath);
    if (!existsSync(resolved)) {
      throw new Error(`File not found: ${filePath}`);
    }
    return { xml: readFileSync(resolved, 'utf-8'), source: resolved };
  }

  // Read from stdin if not a TTY
  if (!process.stdin.isTTY) {
    const chunks = [];
    const fd = require('fs').openSync('/dev/stdin', 'r');
    const buf = Buffer.alloc(65536);
    let bytesRead;
    while ((bytesRead = require('fs').readSync(fd, buf, 0, buf.length)) > 0) {
      chunks.push(buf.subarray(0, bytesRead));
    }
    require('fs').closeSync(fd);
    const xml = Buffer.concat(chunks).toString('utf-8');
    if (!xml.trim()) {
      return null;
    }
    return { xml, source: 'stdin' };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Lint
// ---------------------------------------------------------------------------

/**
 * Extract executionPlatformVersion from BPMN definitions attributes.
 * Returns e.g. "8.8" or null if not present / not Camunda Cloud.
 */
function detectCamundaCloudVersion(rootElement) {
  const attrs = rootElement.$attrs || {};
  const platform = attrs['modeler:executionPlatform'];
  const version = attrs['modeler:executionPlatformVersion'];

  if (platform !== 'Camunda Cloud' || !version) {
    return null;
  }

  // Extract major.minor from e.g. "8.9.0"
  const match = version.match(/^(\d+\.\d+)/);
  return match ? match[1] : null;
}

/**
 * Resolve the camunda-compat config name for a given version.
 * Falls back to the highest available config if the exact version isn't supported.
 */
function resolveCamundaCompatConfig(version) {
  const plugin = require('bpmnlint-plugin-camunda-compat');
  const configs = plugin.configs;

  // Try exact match: "8.8" -> "camunda-cloud-8-8"
  const configName = `camunda-cloud-${version.replace('.', '-')}`;
  if (configs[configName]) {
    return `plugin:camunda-compat/${configName}`;
  }

  // Fall back to highest available camunda-cloud config
  const cloudConfigs = Object.keys(configs)
    .filter(k => k.startsWith('camunda-cloud-'))
    .sort();

  if (cloudConfigs.length > 0) {
    const fallback = cloudConfigs[cloudConfigs.length - 1];
    return `plugin:camunda-compat/${fallback}`;
  }

  return null;
}

/**
 * Build linter config: use local .bpmnlintrc if present, otherwise
 * build defaults based on the BPMN file's executionPlatformVersion.
 */
function buildLintConfig(rootElement) {
  // Check for local .bpmnlintrc
  const rcPath = resolvePath('.bpmnlintrc');
  if (existsSync(rcPath)) {
    return JSON.parse(readFileSync(rcPath, 'utf-8'));
  }

  const config = {
    extends: ['bpmnlint:recommended'],
  };

  const version = detectCamundaCloudVersion(rootElement);
  if (version) {
    const compatConfig = resolveCamundaCompatConfig(version);
    if (compatConfig) {
      config.extends.push(compatConfig);
    }
  }

  return config;
}

/**
 * Format and print lint results in bpmnlint's table format.
 */
function printLintResultsText(source, results) {
  let errorCount = 0;
  let warningCount = 0;
  const rows = [];

  for (const [ruleName, reports] of Object.entries(results)) {
    for (const report of reports) {
      const { category, id = '', message, name: reportName, path } = report;

      let elementRef = id;
      if (path) {
        const { pathStringify } = require('@bpmn-io/moddle-utils');
        elementRef = `${id}#${pathStringify(path)}`;
      }

      const displayName = reportName || ruleName;
      const categoryLabel = category === 'warn' ? 'warning' : category;

      rows.push({ elementRef, categoryLabel, message, displayName, category });

      if (category === 'error') {
        errorCount++;
      } else {
        warningCount++;
      }
    }
  }

  if (rows.length > 0) {
    console.log();
    console.log(resolvePath(source));

    for (const row of rows) {
      const prefix = row.category === 'error' ? 'error' : 'warning';
      console.log(`  ${row.elementRef}  ${prefix}  ${row.message}  ${row.displayName}`);
    }
  }

  return { errorCount, warningCount };
}

/**
 * Format lint results as JSON.
 */
function printLintResultsJson(source, results) {
  let errorCount = 0;
  let warningCount = 0;
  const issues = [];

  for (const [ruleName, reports] of Object.entries(results)) {
    for (const report of reports) {
      const { category, id, message, name: reportName, path } = report;

      issues.push({
        rule: reportName || ruleName,
        elementId: id || null,
        message,
        category: category === 'warn' ? 'warning' : category,
        ...(path ? { path } : {}),
      });

      if (category === 'error') {
        errorCount++;
      } else {
        warningCount++;
      }
    }
  }

  const logger = getLogger();
  logger.json({ file: source, issues, errorCount, warningCount });

  return { errorCount, warningCount };
}

async function lintCommand(args) {
  const logger = getLogger();

  // Parse args: remaining positionals are file paths
  const filePath = args.find(a => !a.startsWith('-'));
  const input = readBpmnInput(filePath);

  if (!input) {
    logger.error('Usage: c8ctl bpmn lint <file.bpmn>');
    logger.error('       cat file.bpmn | c8ctl bpmn lint');
    process.exitCode = 1;
    return;
  }

  // Parse BPMN XML
  const BpmnModdle = (await import('bpmn-moddle')).default;
  const zeebeSchema = (await import('zeebe-bpmn-moddle/resources/zeebe.json', { with: { type: 'json' } })).default;

  const moddle = new BpmnModdle({ zeebe: zeebeSchema });

  let rootElement;
  try {
    const result = await moddle.fromXML(input.xml);
    rootElement = result.rootElement;
  } catch (error) {
    logger.error(`Failed to parse BPMN: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  // Build config and lint
  const config = buildLintConfig(rootElement);
  const { Linter } = require('bpmnlint');
  const NodeResolver = require('bpmnlint/lib/resolver/node-resolver');

  const linter = new Linter({ config, resolver: new NodeResolver() });
  const results = await linter.lint(rootElement);

  // Output results
  const { errorCount, warningCount } = isJsonMode()
    ? printLintResultsJson(input.source, results)
    : printLintResultsText(input.source, results);

  const problemCount = errorCount + warningCount;

  if (problemCount && !isJsonMode()) {
    const pluralize = (word, count) => count === 1 ? word : `${word}s`;
    console.log();
    console.log(
      `\u2716 ${problemCount} ${pluralize('problem', problemCount)} ` +
      `(${errorCount} ${pluralize('error', errorCount)}, ` +
      `${warningCount} ${pluralize('warning', warningCount)})`
    );
  }

  if (errorCount > 0) {
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Apply Element Template
// ---------------------------------------------------------------------------

async function applyElementTemplateCommand(args) {
  const logger = getLogger();

  // Parse flags from process.argv since c8ctl's parseArgs strips flags before
  // passing positionals to plugins. Check both -i and --in-place.
  const rawArgs = process.argv.slice(2);
  const inPlace = rawArgs.includes('-i') || rawArgs.includes('--in-place');
  const positionals = args;

  let templatePath, elementId, bpmnFilePath;

  if (process.stdin.isTTY || positionals.length >= 3) {
    // File mode: <template.json> <element-id> <file.bpmn>
    if (positionals.length < 3) {
      logger.error('Usage: c8ctl bpmn apply-element-template <template.json> <element-id> <file.bpmn>');
      logger.error('       c8ctl bpmn apply-element-template --in-place <template.json> <element-id> <file.bpmn>');
      logger.error('       cat file.bpmn | c8ctl bpmn apply-element-template <template.json> <element-id>');
      process.exitCode = 1;
      return;
    }
    [templatePath, elementId, bpmnFilePath] = positionals;
  } else {
    // Stdin mode: <template.json> <element-id>
    if (positionals.length < 2) {
      logger.error('Usage: cat file.bpmn | c8ctl bpmn apply-element-template <template.json> <element-id>');
      process.exitCode = 1;
      return;
    }

    if (inPlace) {
      logger.error('Error: --in-place cannot be used with stdin input');
      process.exitCode = 1;
      return;
    }

    [templatePath, elementId] = positionals;
  }

  // Read inputs
  const input = readBpmnInput(bpmnFilePath);
  if (!input) {
    logger.error('Error: no BPMN input provided');
    process.exitCode = 1;
    return;
  }

  const resolvedTemplatePath = resolvePath(templatePath);
  if (!existsSync(resolvedTemplatePath)) {
    logger.error(`Error: template file not found: ${templatePath}`);
    process.exitCode = 1;
    return;
  }
  const templateJson = readFileSync(resolvedTemplatePath, 'utf-8');

  // Apply template
  const { applyTemplate } = await import('element-templates-cli');

  // Suppress noisy internal "unhandled error in event listener" warnings from the library
  const originalConsoleError = console.error;
  console.error = (...args) => {
    if (typeof args[0] === 'string' && args[0].includes('unhandled error in event listener')) return;
    originalConsoleError(...args);
  };

  let resultXml;
  try {
    resultXml = await applyTemplate(input.xml, templateJson, elementId);
  } catch (error) {
    // The library throws a generic error when the element ID doesn't exist
    const hint = error.message.includes("Cannot read properties of undefined")
      ? `Element '${elementId}' not found in the BPMN diagram`
      : error.message;
    logger.error(`Error applying template: ${hint}`);
    process.exitCode = 1;
    return;
  } finally {
    console.error = originalConsoleError;
  }

  // Output
  if (inPlace) {
    writeFileSync(resolvePath(bpmnFilePath), resultXml, 'utf-8');
    logger.info(`Updated ${bpmnFilePath}`);
  } else {
    process.stdout.write(resultXml);
  }
}

// ---------------------------------------------------------------------------
// Command routing
// ---------------------------------------------------------------------------

export const commands = {
  'bpmn': async (args) => {
    const logger = getLogger();

    const subcommand = args[0];
    const subArgs = args.slice(1);

    switch (subcommand) {
      case 'lint':
        return lintCommand(subArgs);
      case 'apply-element-template':
        return applyElementTemplateCommand(subArgs);
      default:
        console.log('Usage:');
        console.log('  c8ctl bpmn lint <file.bpmn>');
        console.log('  c8ctl bpmn lint                              (reads from stdin)');
        console.log('  c8ctl bpmn apply-element-template <template.json> <element-id> <file.bpmn>');
        console.log('  c8ctl bpmn apply-element-template --in-place <template.json> <element-id> <file.bpmn>');
        console.log('  cat file.bpmn | c8ctl bpmn apply-element-template <template.json> <element-id>');
        console.log('');
        console.log('Subcommands:');
        console.log('  lint                    Lint a BPMN diagram against recommended and Camunda rules');
        console.log('  apply-element-template  Apply a Camunda element template to a BPMN element');
        console.log('');
        console.log('Lint auto-detects the Camunda Cloud version from the BPMN file and applies');
        console.log('the matching camunda-compat ruleset. A local .bpmnlintrc overrides defaults.');
        if (subcommand) {
          process.exitCode = 1;
        }
    }
  },
};
