/**
 * c8ctl-plugin-element-template
 *
 * Apply Camunda element templates to BPMN elements and inspect template properties.
 *
 * Usage:
 *   c8ctl element-template apply <template> <element-id> [<file.bpmn>] [--in-place] [--set key=value]
 *   c8ctl element-template list-properties <template>
 *
 * <template> can be a local path or an https:// URL.
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
      subcommands: [
        { name: 'apply', description: 'Apply a Camunda element template to a BPMN element' },
        { name: 'list-properties', description: 'List settable properties of an element template' },
      ],
      examples: [
        {
          command: 'c8ctl element-template apply template.json Task_1 process.bpmn',
          description: 'Apply an element template to a BPMN element',
        },
        {
          command:
            'c8ctl element-template apply template.json Task_1 process.bpmn --set method=POST --set url=https://example.com',
          description: 'Apply template and set input values',
        },
        {
          command: 'c8ctl element-template apply -i template.json Task_1 process.bpmn',
          description: 'Apply in-place (modifies the BPMN file)',
        },
        {
          command: 'c8ctl element-template list-properties template.json',
          description: 'List settable properties from a template',
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

async function readTemplate(templatePath) {
  const content = await readFileOrUrl(templatePath);
  return JSON.parse(content);
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

  if (parsed.error) {
    throw new Error(parsed.error);
  }

  const [templatePath, elementId, bpmnFilePath] = parsed.positionals;

  if (!templatePath) {
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

  const template = await readTemplate(templatePath);

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
  const templatePath = args[0];

  if (!templatePath) {
    throw new Error('Missing template argument. Usage: c8ctl element-template list-properties <template>');
  }

  const template = await readTemplate(templatePath);
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
    ? `${template.name}${template.id ? ` (${template.id})` : ''}`
    : templatePath;
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
// Plugin commands export
// ---------------------------------------------------------------------------

const VALID_SUBCOMMANDS = ['apply', 'list-properties'];
const SUBCOMMAND_ALIASES = { props: 'list-properties' };

function printUsage() {
  console.log('Usage:');
  console.log('  c8ctl element-template apply <template> <element-id> [<file.bpmn>] [--in-place] [--set key=value]');
  console.log('  c8ctl element-template list-properties <template>');
  console.log('');
  console.log('Subcommands:');
  console.log('  apply             Apply a Camunda element template to a BPMN element');
  console.log('  list-properties   List settable properties of an element template (alias: props)');
  console.log('');
  console.log('Options:');
  console.log('  -i, --in-place    Modify the BPMN file in place (apply only)');
  console.log('  --set key=value   Set a template property value (repeatable)');
  console.log('');
  console.log('Examples:');
  console.log('  c8ctl element-template apply template.json Task_1 process.bpmn');
  console.log('  c8ctl element-template apply template.json Task_1 process.bpmn --set method=POST');
  console.log('  c8ctl element-template list-properties template.json');
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
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const logger = getLogger();
      logger.error(`Failed to element-template ${subcommand}: ${message}`);
      process.exitCode = 1;
    }
  },
};
