/**
 * Helpers for the element-template plugin: --set parsing, file/URL fetching.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

// ---------------------------------------------------------------------------
// File / URL fetching
// ---------------------------------------------------------------------------

export function isUrl(input) {
  return input.startsWith('https://') || input.startsWith('http://');
}

/**
 * Rewrite a GitHub blob URL to the raw content URL.
 *   https://github.com/<owner>/<repo>/blob/<ref>/<path>
 * → https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>
 */
export function toRawGitHubUrl(url) {
  const match = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
  if (match) {
    const [, owner, repo, rest] = match;
    return `https://raw.githubusercontent.com/${owner}/${repo}/${rest}`;
  }
  return url;
}

export async function readFileOrUrl(input) {
  if (isUrl(input)) {
    const resolvedUrl = toRawGitHubUrl(input);
    const response = await fetch(resolvedUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${resolvedUrl}: HTTP ${response.status}`);
    }
    return response.text();
  }
  const resolved = resolvePath(input);
  if (!existsSync(resolved)) {
    throw new Error(`File not found: ${input}`);
  }
  return readFileSync(resolved, 'utf-8');
}

// ---------------------------------------------------------------------------
// --set flag: template property mutation
// ---------------------------------------------------------------------------

/** Binding type shorthand prefixes for disambiguation. */
export const BINDING_TYPE_SHORTHANDS = {
  input: 'zeebe:input',
  output: 'zeebe:output',
  header: 'zeebe:taskHeader',
  property: 'zeebe:property',
  taskDefinition: 'zeebe:taskDefinition',
};

/** Get the user-facing binding name for a template property. */
export function getBindingName(prop) {
  const b = prop.binding;
  if (!b) return null;
  if (b.name !== undefined) return b.name;
  if (b.key !== undefined) return b.key;
  if (b.property !== undefined) return b.property;
  return null;
}

/** Get the shorthand label for a binding type (e.g. "zeebe:taskHeader" → "header"). */
export function getBindingTypeShorthand(bindingType) {
  const entry = Object.entries(BINDING_TYPE_SHORTHANDS).find(([, v]) => v === bindingType);
  return entry ? entry[0] : bindingType;
}

/** Return only the properties that can be targeted by --set. */
export function getSettableProperties(properties) {
  return properties.filter((p) => p.type !== 'Hidden' && getBindingName(p) !== null);
}

/**
 * Parse a --set key=value string. If key contains a `:` prefix,
 * resolve the binding type shorthand.
 */
export function parseSetArg(arg) {
  const eqIndex = arg.indexOf('=');
  if (eqIndex === -1) {
    throw new Error(
      `Invalid --set format: "${arg}". Expected key=value (e.g. --set method=POST)`,
    );
  }

  const key = arg.slice(0, eqIndex);
  const value = arg.slice(eqIndex + 1);

  const colonIndex = key.indexOf(':');
  if (colonIndex !== -1) {
    const prefix = key.slice(0, colonIndex);
    const name = key.slice(colonIndex + 1);
    const bindingType = BINDING_TYPE_SHORTHANDS[prefix];
    if (!bindingType) {
      const valid = Object.keys(BINDING_TYPE_SHORTHANDS).join(', ');
      throw new Error(`Unknown binding type prefix "${prefix}". Valid prefixes: ${valid}`);
    }
    return { bindingTypeFilter: bindingType, name, value };
  }

  return { bindingTypeFilter: null, name: key, value };
}

/**
 * Find a template property by binding name, optionally filtered by binding type.
 * Throws on ambiguity or unknown names.
 */
export function findPropertyByBindingName(properties, name, bindingTypeFilter) {
  const settable = getSettableProperties(properties);

  const matches = settable.filter((p) => {
    if (getBindingName(p) !== name) return false;
    if (bindingTypeFilter && p.binding?.type !== bindingTypeFilter) return false;
    return true;
  });

  if (matches.length === 1) return matches[0];

  if (matches.length > 1) {
    const qualified = matches.map((p) => {
      const prefix = getBindingTypeShorthand(p.binding?.type ?? '');
      return `${prefix}:${name}`;
    });
    throw new Error(
      `Ambiguous property "${name}" matches ${matches.length} bindings. Use a qualified name: ${qualified.join(', ')}`,
    );
  }

  const available = [...new Set(settable.map(getBindingName).filter(Boolean))];
  throw new Error(
    `Unknown property "${name}". Available properties for --set:\n  ${available.join(', ')}`,
  );
}

export function validateDropdownValue(prop, name, value) {
  if (!prop.choices) return;
  const validValues = prop.choices.map((c) => c.value);
  if (!validValues.includes(value)) {
    throw new Error(
      `Invalid value "${value}" for "${name}". Valid choices: ${validValues.join(', ')}`,
    );
  }
}

/**
 * Apply --set overrides to template properties. Mutates the template in place.
 * Returns the list of binding names that were set.
 */
export function applySetOverrides(properties, setArgs) {
  const setBindingNames = [];

  for (const arg of setArgs) {
    const { bindingTypeFilter, name, value } = parseSetArg(arg);
    const prop = findPropertyByBindingName(properties, name, bindingTypeFilter);

    if (prop.choices) validateDropdownValue(prop, name, value);

    prop.value = value;
    const bindingName = getBindingName(prop);
    if (bindingName) setBindingNames.push(bindingName);
  }

  return setBindingNames;
}

/**
 * Check which --set bindings actually made it into the output XML.
 * Warn for any that were dropped (unmet condition).
 */
export function warnUnmetConditions(logger, resultXml, setBindingNames, properties) {
  for (const name of setBindingNames) {
    const prop = properties.find((p) => getBindingName(p) === name);
    if (!prop?.binding) continue;

    const bt = prop.binding.type;
    let present = false;
    if (bt === 'zeebe:input') present = resultXml.includes(`target="${name}"`);
    else if (bt === 'zeebe:taskHeader') present = resultXml.includes(`key="${name}"`);
    else if (bt === 'zeebe:taskDefinition') present = true;
    else present = resultXml.includes(name);

    if (!present) {
      logger.warn(
        `Property "${name}" was set but not applied (unmet condition). Check that controlling properties are also set.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Plugin arg parser — extracts --set, --in-place/-i, and positionals
// ---------------------------------------------------------------------------

/**
 * Parse plugin args, separating flags from positionals.
 * - `--set foo=bar` (or `--set=foo=bar`) is repeatable, collected into setArgs[]
 * - `--in-place` / `-i` is a boolean
 * - `--help` / `-h` is a boolean
 * - everything else is a positional
 *
 * Unknown flags return { error: '...' } so the caller can warn and exit.
 */
export function parseArgs(args) {
  const result = {
    inPlace: false,
    help: false,
    setArgs: [],
    positionals: [],
    error: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--') {
      result.positionals.push(...args.slice(i + 1));
      break;
    }

    if (arg === '--in-place' || arg === '-i') {
      result.inPlace = true;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      result.help = true;
      continue;
    }

    if (arg === '--set') {
      const next = args[i + 1];
      if (next === undefined) {
        result.error = '--set requires a value (e.g. --set method=POST)';
        return result;
      }
      result.setArgs.push(next);
      i++;
      continue;
    }

    if (arg.startsWith('--set=')) {
      result.setArgs.push(arg.slice('--set='.length));
      continue;
    }

    // Skip known global flags (--profile, --verbose, --dry-run, --fields, --version)
    // so plugins don't reject them when the user places them after the verb.
    if (arg === '--profile' || arg === '--fields' || arg === '--version' || arg === '-v') {
      // These are string-type global flags — skip the next arg (their value)
      i++;
      continue;
    }
    if (arg === '--verbose' || arg === '--dry-run') {
      continue;
    }

    if (arg.startsWith('-')) {
      result.error = `Unknown flag: ${arg}`;
      return result;
    }

    result.positionals.push(arg);
  }

  return result;
}
