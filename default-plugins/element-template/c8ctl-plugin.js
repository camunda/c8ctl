/**
 * c8ctl-plugin-element-template
 *
 * Apply Camunda element templates to BPMN elements and inspect template properties.
 *
 * Usage:
 *   c8ctl element-template apply <template> <element-id> [<file.bpmn>] [--in-place] [--set key=value]
 *   c8ctl element-template list-properties <template>
 *   c8ctl element-template search <query>
 *   c8ctl element-template sync [--prune]
 *
 * <template> can be a local path, an https:// URL, or an OOTB template id
 * (optionally pinned, e.g. io.camunda.connectors.HttpJson.v2@13).
 * GitHub blob URLs are auto-rewritten to raw.githubusercontent.com.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applySetOverrides,
  getBindingName,
  getBindingTypeShorthand,
  getSettableProperties,
  parseArgs,
  readFileOrUrl,
  warnUnmetConditions,
} from './helpers.js';
import {
  bootstrapIfNeeded,
  findById,
  nudgeIfStale,
  pickVersion,
  searchTemplates,
  syncTemplates,
} from './marketplace.js';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export const metadata = {
  name: 'element-template',
  description: 'Apply and inspect Camunda element templates',
  commands: {
    'element-template': {
      description: 'Apply Camunda element templates and inspect template properties',
      helpDescription:
        'Apply Camunda element templates to BPMN elements, list settable properties, ' +
        'search the out-of-the-box template catalogue, and manage the local template cache.\n\n' +
        '<template> is a local path, an https:// URL, or an OOTB template id (optionally @<version>).',
      subcommands: [
        { name: 'apply', description: 'Apply a Camunda element template to a BPMN element' },
        { name: 'list-properties', description: 'List settable properties of an element template', aliases: ['props'] },
        { name: 'search', description: 'Search out-of-the-box element templates' },
        { name: 'sync', description: 'Refresh the local OOTB element template cache' },
      ],
      flags: {
        'in-place': { type: 'boolean', short: 'i', description: 'Modify the BPMN file in place (apply only)' },
        set: { type: 'string', description: 'Set a template property value (repeatable, apply only)' },
        prune: { type: 'boolean', description: 'Drop cached entries no longer in the index (sync only)' },
      },
      examples: [
        {
          command: 'c8ctl element-template search "AWS S3"',
          description: 'Search OOTB templates by name',
        },
        {
          command: 'c8ctl element-template apply io.camunda.connectors.HttpJson.v2 Task_1 process.bpmn',
          description: 'Apply an OOTB template (latest compatible with the BPMN engine version)',
        },
        {
          command: 'c8ctl element-template apply io.camunda.connectors.HttpJson.v2@13 Task_1 process.bpmn',
          description: 'Apply a specific OOTB template version',
        },
        {
          command: 'c8ctl element-template apply template.json Task_1 process.bpmn',
          description: 'Apply a template from a local file or URL',
        },
        {
          command: 'c8ctl element-template list-properties io.camunda.connectors.HttpJson.v2',
          description: 'List settable properties of an OOTB template',
        },
        {
          command: 'c8ctl element-template sync',
          description: 'Refresh the local OOTB element template cache',
        },
      ],
    },
  },
};

// ---------------------------------------------------------------------------
// Runtime helpers
// ---------------------------------------------------------------------------

function getLogger() {
  if (globalThis.c8ctl) return globalThis.c8ctl.getLogger();
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
      if (error.code !== 'EAGAIN' && error.code !== 'EWOULDBLOCK') throw error;
    }
    if (!xml.trim()) return null;
    return { xml, source: 'stdin' };
  }

  return null;
}

/**
 * Classify a template argument as one of:
 *   - { kind: 'url', value }
 *   - { kind: 'path', value }
 *   - { kind: 'id', id, version? }
 *
 * Detection rules (in order):
 *   1. starts with http:// or https://  → URL
 *   2. contains / or \, starts with `.`, or ends with .json → path
 *   3. matches `<id>` or `<id>@<n>`  → id
 */
function parseTemplateRef(arg) {
  if (!arg) return null;
  if (/^https?:\/\//.test(arg)) return { kind: 'url', value: arg };
  if (
    arg.includes('/') ||
    arg.includes('\\') ||
    arg.startsWith('.') ||
    arg.toLowerCase().endsWith('.json')
  ) {
    return { kind: 'path', value: arg };
  }
  const match = arg.match(/^([^@\s]+?)(?:@(\d+))?$/);
  if (!match) return { kind: 'path', value: arg };
  return {
    kind: 'id',
    id: match[1],
    version: match[2] !== undefined ? Number(match[2]) : undefined,
  };
}

function getExecutionPlatformVersion(xml) {
  const match = xml.match(/modeler:executionPlatformVersion\s*=\s*["']([^"']+)["']/);
  return match ? match[1] : null;
}

async function readTemplateFromPathOrUrl(input) {
  const content = await readFileOrUrl(input);
  return JSON.parse(content);
}

/**
 * Resolve an `<id>[@<v>]` reference to a single template object using the
 * local cache, bootstrapping if needed. `executionPlatformVersion` (from the
 * BPMN file) drives version selection when no explicit version is pinned.
 */
async function resolveOotbTemplate(ref, { executionPlatformVersion } = {}) {
  const logger = getLogger();
  await bootstrapIfNeeded({ logger });
  nudgeIfStale(logger);

  const candidates = findById(ref.id);
  if (candidates.length === 0) {
    throw new Error(
      `Template '${ref.id}' not found. Run 'c8ctl element-template sync' to refresh the cache, ` +
        `or use 'c8ctl element-template search <query>' to find an id.`,
    );
  }

  const picked = pickVersion(candidates, {
    version: ref.version,
    executionPlatformVersion,
  });
  if (!picked) {
    if (ref.version !== undefined) {
      const known = candidates.map((t) => t.version).sort((a, b) => Number(a) - Number(b));
      throw new Error(
        `Template '${ref.id}' has no version ${ref.version}. Available: ${known.join(', ')}.`,
      );
    }
    throw new Error(
      `Template '${ref.id}' has no version compatible with execution platform ` +
        `${executionPlatformVersion}. Available: ${candidates
          .map((t) => `${t.version} (${t.engines?.camunda || 'any'})`)
          .join(', ')}.`,
    );
  }
  return picked;
}

// ---------------------------------------------------------------------------
// Vendor bundle resolution
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Locate the prebuilt vendor bundle. Plugins live in two places:
 *   - dev:        default-plugins/element-template/c8ctl-plugin.js
 *                 vendor: ../../dist/vendor/bpmn-element-templates.cjs
 *   - production: dist/default-plugins/element-template/c8ctl-plugin.js
 *                 vendor: ../../vendor/bpmn-element-templates.cjs
 */
function resolveVendorBundle() {
  const candidates = [
    resolvePath(__dirname, '..', '..', 'dist', 'vendor', 'bpmn-element-templates.cjs'),
    resolvePath(__dirname, '..', '..', 'vendor', 'bpmn-element-templates.cjs'),
  ];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  throw new Error(
    'Vendor bundle not found. Run `npm run build:vendor` to build it.\n' +
      `Searched: ${candidates.join(', ')}`,
  );
}

/**
 * Apply an element template to a BPMN element using bpmn-js-headless and
 * bpmn-js-element-templates (same libraries as Web/Desktop Modeler).
 *
 * Loaded from a prebuilt CJS vendor bundle since the upstream libraries
 * use extensionless ESM imports that Node.js can't resolve without a bundler.
 */
async function applyElementTemplate(xml, template, elementId) {
  const vendorPath = resolveVendorBundle();
  const vendor = require(vendorPath);
  const { Modeler, CloudElementTemplatesCoreModule, ZeebeModdleExtension } = vendor;

  const modeler = new Modeler({
    additionalModules: [CloudElementTemplatesCoreModule],
    moddleExtensions: { zeebe: ZeebeModdleExtension },
  });

  await modeler.importXML(xml);

  const elementRegistry = modeler.get('elementRegistry');
  const element = elementRegistry.get(elementId);
  if (!element) {
    throw new Error(`Element "${elementId}" not found in the BPMN diagram`);
  }

  const elementTemplates = modeler.get('elementTemplates');
  elementTemplates.set([template]);
  elementTemplates.applyTemplate(element, template);

  const result = await modeler.saveXML({ format: true });
  return result.xml;
}

// ---------------------------------------------------------------------------
// Subcommand: apply
// ---------------------------------------------------------------------------

async function applySubcommand(args) {
  const logger = getLogger();
  const parsed = parseArgs(args);

  if (parsed.help) {
    const logger = getLogger();
    logger.output(
      'Usage: c8ctl element-template apply <template> <element-id> [<file.bpmn>] [--in-place] [--set key=value]',
    );
    return;
  }

  if (parsed.error) {
    throw new Error(parsed.error);
  }

  const [templateArg, elementId, bpmnFilePath] = parsed.positionals;

  if (!templateArg) {
    throw new Error('Missing template argument. Usage: c8ctl element-template apply <template> <element-id> [<file.bpmn>]');
  }
  if (!elementId) {
    throw new Error('Missing element-id argument. Usage: c8ctl element-template apply <template> <element-id> [<file.bpmn>]');
  }

  const input = readBpmnInput(bpmnFilePath);
  if (!input) {
    throw new Error('No BPMN input provided. Pass a file path or pipe BPMN XML via stdin.');
  }

  if (parsed.inPlace && !bpmnFilePath) {
    throw new Error('--in-place cannot be used with stdin input');
  }

  const ref = parseTemplateRef(templateArg);
  let template;
  if (ref.kind === 'id') {
    const executionPlatformVersion = getExecutionPlatformVersion(input.xml);
    template = await resolveOotbTemplate(ref, { executionPlatformVersion });
    if (!ref.version && !executionPlatformVersion) {
      logger.warn(
        `BPMN has no modeler:executionPlatformVersion — applying latest version ` +
          `(${template.version}) of ${ref.id}.`,
      );
    }
  } else {
    template = await readTemplateFromPathOrUrl(ref.value);
  }

  let setBindingNames = [];
  if (parsed.setArgs.length > 0) {
    setBindingNames = applySetOverrides(template.properties, parsed.setArgs);
  }

  let resultXml;
  try {
    resultXml = await applyElementTemplate(input.xml, template, elementId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const hint = message.includes('Cannot read properties of undefined')
      ? `Element '${elementId}' not found in the BPMN diagram`
      : message;
    throw new Error(`Error applying template: ${hint}`);
  }

  if (setBindingNames.length > 0) {
    warnUnmetConditions(logger, resultXml, setBindingNames, template.properties);
  }

  if (parsed.inPlace && bpmnFilePath) {
    writeFileSync(resolvePath(bpmnFilePath), resultXml, 'utf-8');
    logger.info(`Updated ${bpmnFilePath}`);
    return;
  }

  process.stdout.write(resultXml);
}

// ---------------------------------------------------------------------------
// Subcommand: list-properties
// ---------------------------------------------------------------------------

async function listPropertiesSubcommand(args) {
  const logger = getLogger();

  // Handle --help/-h and skip global flags before interpreting the template arg
  let templateArg;
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      logger.output('Usage: c8ctl element-template list-properties <template>');
      return;
    }
    if (arg.startsWith('-')) {
      continue;
    }
    templateArg = arg;
    break;
  }

  if (!templateArg) {
    throw new Error('Missing template argument. Usage: c8ctl element-template list-properties <template>');
  }

  const ref = parseTemplateRef(templateArg);
  let template;
  if (ref.kind === 'id') {
    template = await resolveOotbTemplate(ref);
    if (!ref.version) {
      logger.warn(
        `Showing latest version (${template.version}) of ${ref.id}. ` +
          `Pin a version with ${ref.id}@<n> if needed.`,
      );
    }
  } else {
    template = await readTemplateFromPathOrUrl(ref.value);
  }

  const settable = getSettableProperties(template.properties);
  const groupLabelMap = new Map((template.groups ?? []).map((g) => [g.id, g.label]));

  if (isJsonMode()) {
    const properties = settable.map((p) => {
      const bindingName = getBindingName(p);
      const bindingType = p.binding?.type;
      return {
        name: bindingName,
        group: p.group ? (groupLabelMap.get(p.group) ?? p.group) : undefined,
        type: p.type,
        bindingType: bindingType ? getBindingTypeShorthand(bindingType) : undefined,
        ...(p.value !== undefined && { default: p.value }),
        ...(p.choices && { choices: p.choices.map((c) => c.value) }),
        ...(p.condition ? { conditional: true } : {}),
      };
    });
    logger.json({
      name: template.name,
      id: template.id,
      version: template.version,
      properties,
    });
    return;
  }

  const grouped = new Map();
  const ungrouped = [];
  for (const prop of settable) {
    if (prop.group) {
      const list = grouped.get(prop.group) ?? [];
      list.push(prop);
      grouped.set(prop.group, list);
    } else {
      ungrouped.push(prop);
    }
  }

  const templateLabel = template.name
    ? `${template.name}${template.id ? ` (${template.id})` : ''}${
        template.version !== undefined ? ` v${template.version}` : ''
      }`
    : templateArg;
  logger.output(templateLabel);
  logger.output('');

  const formatProp = (prop) => {
    const bindingName = getBindingName(prop) ?? '?';
    const parts = [];

    if (prop.type === 'Dropdown' && prop.choices) {
      parts.push(`Dropdown [${prop.choices.map((c) => c.value).join(', ')}]`);
    } else if (prop.type) {
      parts.push(prop.type);
    }

    const bt = prop.binding?.type;
    if (bt && bt !== 'zeebe:input') {
      parts.push(`[${getBindingTypeShorthand(bt)}]`);
    }

    if (prop.value !== undefined && prop.value !== '') {
      parts.push(`(default: ${String(prop.value)})`);
    }

    if (prop.condition) parts.push('(conditional)');

    const nameCol = bindingName.padEnd(36);
    return `    ${nameCol} ${parts.join('  ')}`;
  };

  const printGroup = (label, props) => {
    logger.output(`  ${label}:`);
    for (const prop of props) logger.output(formatProp(prop));
    logger.output('');
  };

  for (const [groupId, props] of grouped) {
    const label = groupLabelMap.get(groupId) ?? groupId;
    printGroup(label, props);
  }

  if (ungrouped.length > 0) printGroup('Other', ungrouped);
}

// ---------------------------------------------------------------------------
// Subcommand: search
// ---------------------------------------------------------------------------

async function searchSubcommand(args) {
  const logger = getLogger();
  const query = args.filter((a) => !a.startsWith('-')).join(' ').trim();
  if (!query) {
    throw new Error('Missing query. Usage: c8ctl element-template search <query>');
  }

  await bootstrapIfNeeded({ logger });
  nudgeIfStale(logger);

  const matches = searchTemplates(query);

  if (isJsonMode()) {
    logger.json(
      matches.map((t) => ({
        id: t.id,
        name: t.name,
        version: t.version,
        description: t.description,
        engineConstraint: t.engines?.camunda,
        category: t.category?.name,
      })),
    );
    return;
  }

  if (matches.length === 0) {
    logger.output(`No element templates match '${query}'.`);
    return;
  }

  // Group by category.name (Modeler-style).
  const byCategory = new Map();
  for (const t of matches) {
    const category = t.category?.name || 'Uncategorized';
    const list = byCategory.get(category) ?? [];
    list.push(t);
    byCategory.set(category, list);
  }

  const categories = [...byCategory.keys()].sort();
  for (const category of categories) {
    logger.output(category);
    const items = byCategory.get(category).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    for (const t of items) {
      const nameCol = (t.name || '(unnamed)').padEnd(40);
      const idCol = t.id.padEnd(50);
      const version = t.version !== undefined ? `v${t.version}` : '';
      logger.output(`  ${nameCol}  ${idCol}  ${version}`);
      if (t.description) {
        logger.output(`    ${t.description}`);
      }
    }
    logger.output('');
  }
  logger.output(`${matches.length} match${matches.length === 1 ? '' : 'es'}.`);
}

// ---------------------------------------------------------------------------
// Subcommand: sync
// ---------------------------------------------------------------------------

async function syncSubcommand(args) {
  const logger = getLogger();
  const prune = args.includes('--prune');

  const summary = await syncTemplates({ logger, prune });

  if (isJsonMode()) {
    logger.json(summary);
  }
}

// ---------------------------------------------------------------------------
// Plugin commands export
// ---------------------------------------------------------------------------

const VALID_SUBCOMMANDS = ['apply', 'list-properties', 'search', 'sync'];
const SUBCOMMAND_ALIASES = { props: 'list-properties' };

function printUsage() {
  const logger = getLogger();
  const cmd = metadata.commands['element-template'];
  logger.output('Usage: c8ctl element-template <subcommand> [options]');
  logger.output('');
  if (cmd.helpDescription) {
    for (const line of cmd.helpDescription.split('\n')) {
      logger.output(line);
    }
    logger.output('');
  }
  logger.output('Subcommands:');
  for (const sub of cmd.subcommands) {
    const aliasNote = sub.aliases?.length ? ` (alias: ${sub.aliases.join(', ')})` : '';
    logger.output(`  ${sub.name.padEnd(20)} ${sub.description}${aliasNote}`);
  }
  logger.output('');
  if (cmd.flags) {
    logger.output('Options:');
    for (const [name, def] of Object.entries(cmd.flags)) {
      const shortStr = def.short ? `-${def.short}, ` : '    ';
      logger.output(`  ${shortStr}--${name.padEnd(16)} ${def.description}`);
    }
    logger.output('');
  }
  logger.output('Examples:');
  for (const ex of cmd.examples) {
    logger.output(`  ${ex.command}`);
  }
}

export const commands = {
  'element-template': async (args) => {
    const rawSubcommand = args?.[0];
    const subcommand = SUBCOMMAND_ALIASES[rawSubcommand] ?? rawSubcommand;
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
      if (subcommand === 'apply') {
        await applySubcommand(subArgs);
      } else if (subcommand === 'list-properties') {
        await listPropertiesSubcommand(subArgs);
      } else if (subcommand === 'search') {
        await searchSubcommand(subArgs);
      } else if (subcommand === 'sync') {
        await syncSubcommand(subArgs);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const logger = getLogger();
      logger.error(`Failed to element-template ${subcommand}: ${message}`);
      process.exitCode = 1;
    }
  },
};
