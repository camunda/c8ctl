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
 * A property is "required" if either `optional: false` or
 * `constraints.notEmpty: true`. The element-template schema accepts both
 * forms; templates in the wild use them interchangeably.
 */
export function isPropertyRequired(prop) {
  if (prop.optional === false) return true;
  if (prop.constraints?.notEmpty === true) return true;
  return false;
}

/**
 * Render an element-template `condition` object as a human-readable
 * expression. Handles the common forms (`equals`, `oneOf`, `isActive`)
 * and best-effort handles `allMatch`. Returns null for unrecognised
 * shapes so the caller can fall back to a generic "(conditional)"
 * marker.
 *
 * Examples:
 *   { property: "method", equals: "POST" }        → 'method = "POST"'
 *   { property: "method", oneOf: ["POST","PUT"] } → 'method ∈ {"POST", "PUT"}'
 *   { property: "auth", isActive: true }          → 'auth is active'
 */
export function formatCondition(condition) {
  if (!condition) return null;
  if (Array.isArray(condition.allMatch)) {
    const parts = condition.allMatch.map(formatCondition).filter(Boolean);
    return parts.length > 0 ? parts.join(' AND ') : null;
  }
  if (!condition.property) return null;
  if (Object.hasOwn(condition, 'equals')) {
    return `${condition.property} = ${formatConditionValue(condition.equals)}`;
  }
  if (Array.isArray(condition.oneOf)) {
    return `${condition.property} ∈ {${condition.oneOf.map(formatConditionValue).join(', ')}}`;
  }
  if (condition.isActive === true) return `${condition.property} is active`;
  if (condition.isActive === false) return `${condition.property} is inactive`;
  return null;
}

function formatConditionValue(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  return JSON.stringify(value);
}

/**
 * Build the structured property descriptor used by both text and JSON
 * output of `list-properties`. Surfaces every field an agent or human
 * needs to pick a value without re-reading the raw template:
 *   - name, type, choices, default, group, label, description
 *   - required (derived), feel support, condition expression, pattern
 *   - binding type (always — JSON consumers shouldn't have to guess
 *     the default zeebe:input)
 */
export function getPropertyDetail(prop, groupLabelMap) {
  const bindingName = getBindingName(prop);
  const bindingType = prop.binding?.type;
  return {
    // `id` is the schema's stable identifier — optional in the spec
    // (~37% of OOTB properties don't have one) but the only reliable
    // discriminator for properties that share binding name + type
    // (operation-conditional duplicates).
    id: prop.id,
    name: bindingName,
    type: prop.type,
    label: prop.label,
    description: prop.description,
    // Both `groupId` (raw template id, used by --group filtering) and
    // `group` (user-facing label) are exposed so callers can filter
    // by the stable id without giving up the readable display string.
    groupId: prop.group,
    group: prop.group ? (groupLabelMap?.get(prop.group) ?? prop.group) : undefined,
    bindingType,
    bindingShorthand: bindingType ? getBindingTypeShorthand(bindingType) : undefined,
    required: isPropertyRequired(prop),
    feel: prop.feel,
    default: prop.value,
    choices: prop.choices?.map((c) => ({ value: c.value, label: c.name })),
    condition: prop.condition ?? undefined,
    conditionText: formatCondition(prop.condition),
    pattern: prop.constraints?.pattern
      ? { value: prop.constraints.pattern.value, message: prop.constraints.pattern.message }
      : undefined,
  };
}

/**
 * Compile a shell-style glob to a regex. Only `*` is special — every
 * other character matches literally. Used for `show-properties auth*`
 * style positional matching.
 *
 *   "auth*"   → /^auth.*$/
 *   "url"     → /^url$/
 *   "a.b.*c"  → /^a\.b\..*c$/
 */
export function globToRegex(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*')}$`);
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
 * Find every template property matching a binding name, optionally
 * filtered by binding type. Returns a non-empty array — the caller
 * applies the value to ALL matches.
 *
 * Multi-match handling:
 *   - Same name + SAME binding type → conditional duplicates (template
 *     authors use these to vary defaults/labels per operation while
 *     all targeting the same `<zeebe:input target="x">`). Apply the
 *     value to all; the engine's condition evaluation drops inactive
 *     ones at apply time.
 *   - Same name + DIFFERENT binding types → genuine ambiguity (e.g.
 *     `correlationKey` as both `zeebe:input` and `zeebe:taskHeader`
 *     writes to two different BPMN locations). Throw, ask the user
 *     to qualify with `<binding-type>:<name>`.
 */
export function findPropertiesByBindingName(properties, name, bindingTypeFilter) {
  const settable = getSettableProperties(properties);

  const matches = settable.filter((p) => {
    if (getBindingName(p) !== name) return false;
    if (bindingTypeFilter && p.binding?.type !== bindingTypeFilter) return false;
    return true;
  });

  if (matches.length === 0) {
    const available = [...new Set(settable.map(getBindingName).filter(Boolean))];
    throw new Error(
      `Unknown property "${name}". Available properties for --set:\n  ${available.join(', ')}`,
    );
  }

  // Multi-match across binding types is genuinely ambiguous — different
  // binding types write to different BPMN locations.
  const types = new Set(matches.map((p) => p.binding?.type));
  if (types.size > 1) {
    const qualified = [...types].map(
      (t) => `${getBindingTypeShorthand(t ?? '')}:${name}`,
    );
    throw new Error(
      `Ambiguous property "${name}" matches ${matches.length} bindings across ${types.size} binding types. ` +
        `Use a qualified name: ${qualified.join(', ')}`,
    );
  }

  return matches;
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
 * Apply --set overrides to template properties. Mutates the template
 * in place. When a name matches multiple conditional duplicates, the
 * value is set on all of them — the engine's condition evaluation
 * picks the active one at apply time. Returns the list of binding
 * names that were set (deduped) for the post-apply unmet-condition
 * warning check.
 */
export function applySetOverrides(properties, setArgs) {
  const setBindingNames = new Set();

  for (const arg of setArgs) {
    const { bindingTypeFilter, name, value } = parseSetArg(arg);
    const matches = findPropertiesByBindingName(
      properties,
      name,
      bindingTypeFilter,
    );

    for (const prop of matches) {
      if (prop.choices) validateDropdownValue(prop, name, value);
      prop.value = value;
      const bindingName = getBindingName(prop);
      if (bindingName) setBindingNames.add(bindingName);
    }
  }

  return [...setBindingNames];
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

    if (arg.startsWith('-')) {
      result.error = `Unknown flag: ${arg}`;
      return result;
    }

    result.positionals.push(arg);
  }

  return result;
}
