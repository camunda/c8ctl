/**
 * c8ctl-plugin-feel
 *
 * Evaluate FEEL expressions against a Camunda cluster (default) or
 * locally via feelin (--engine local).
 *
 * Usage:
 *   c8ctl feel evaluate '<expression>' [--vars '{...}'] [--tenant <id>] [--engine cluster|local]
 */

import { evaluate as feelinEvaluate } from 'feelin';

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export const metadata = {
  name: 'feel',
  description: 'Evaluate FEEL expressions',
  commands: {
    feel: {
      description: 'Evaluate FEEL expressions against a cluster or locally',
      helpDescription:
        'Evaluate FEEL expressions and return the result. By default uses the connected ' +
        "Camunda cluster's engine (POST /v2/expression/evaluation, requires 8.9+). Use " +
        '--engine local to evaluate offline via feelin (note: feelin does not support ' +
        'all Camunda FEEL extensions; result may differ from cluster).',
      subcommands: [
        { name: 'evaluate', description: 'Evaluate a FEEL expression' },
      ],
      flags: {
        engine: {
          type: 'string',
          description: "Engine: 'cluster' (default) or 'local' (feelin)",
        },
        vars: {
          type: 'string',
          description: 'JSON object of variables (use --var for individual values)',
        },
        var: {
          type: 'string',
          description:
            'Set a single variable (repeatable). Dot paths nest; values parsed as JSON, falling back to string. e.g. --var x=42 --var person.name=Alice --var items=[1,2,3]',
        },
        tenant: {
          type: 'string',
          description: 'Tenant ID (cluster engine only, for tenant-scoped cluster variables)',
        },
      },
      examples: [
        { command: "c8ctl feel evaluate '1 + 2'", description: 'Evaluate a simple expression' },
        { command: "c8ctl feel evaluate '=1 + 2'", description: "Same — leading '=' is optional" },
        {
          command: "c8ctl feel evaluate 'a + b' --var a=1 --var b=2",
          description: 'Set individual variables',
        },
        {
          command: "c8ctl feel evaluate 'person.name' --var person.name=Alice",
          description: 'Dot-path nesting',
        },
        {
          command: "c8ctl feel evaluate 'sum(items)' --var 'items=[1,2,3]'",
          description: 'JSON values (arrays, numbers, booleans, null)',
        },
        {
          command: "c8ctl feel evaluate 'a + b' --vars '{\"a\": 1, \"b\": 2}'",
          description: 'Bulk variables as JSON',
        },
        {
          command: "c8ctl feel evaluate '1 + 2' --engine local",
          description: 'Evaluate offline via feelin',
        },
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

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(args) {
  const result = {
    help: false,
    engine: 'cluster',
    vars: undefined,
    varArgs: [],
    tenant: undefined,
    positionals: [],
    error: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--') {
      result.positionals.push(...args.slice(i + 1));
      break;
    }

    if (arg === '--help' || arg === '-h') {
      result.help = true;
      continue;
    }

    if (arg === '--engine' || arg.startsWith('--engine=')) {
      const value = arg.includes('=') ? arg.slice('--engine='.length) : args[++i];
      if (value !== 'cluster' && value !== 'local') {
        result.error = `Invalid --engine value '${value}'. Expected 'cluster' or 'local'.`;
        return result;
      }
      result.engine = value;
      continue;
    }

    if (arg === '--vars' || arg.startsWith('--vars=')) {
      result.vars = arg.includes('=') ? arg.slice('--vars='.length) : args[++i];
      continue;
    }

    if (arg === '--var') {
      const next = args[i + 1];
      if (next === undefined) {
        result.error = '--var requires a value (e.g. --var x=42)';
        return result;
      }
      result.varArgs.push(next);
      i++;
      continue;
    }
    if (arg.startsWith('--var=')) {
      result.varArgs.push(arg.slice('--var='.length));
      continue;
    }

    if (arg === '--tenant' || arg.startsWith('--tenant=')) {
      result.tenant = arg.includes('=') ? arg.slice('--tenant='.length) : args[++i];
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

/**
 * Camunda treats expressions without a leading `=` as static strings
 * (see https://docs.camunda.io/docs/components/concepts/expressions/#expressions-vs-static-values).
 * This CLI is specifically for evaluating FEEL, so we auto-prefix when
 * the user omits it. Whitespace before `=` would still be treated as a
 * static, so we trim first.
 */
function normalizeExpression(expression) {
  const trimmed = expression.trimStart();
  return trimmed.startsWith('=') ? trimmed : `= ${trimmed}`;
}

function parseVarsJson(vars) {
  if (!vars) return undefined;
  try {
    const parsed = JSON.parse(vars);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('--vars must be a JSON object');
    }
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid --vars JSON: ${message}`);
  }
}

/**
 * Parse a `--var key=value` arg.
 * The value is parsed as JSON; if that fails (e.g. unquoted strings,
 * shell-friendly inputs), the raw text is used as a string literal.
 *
 *   --var x=42              → { path: 'x', value: 42 }
 *   --var x=hello           → { path: 'x', value: 'hello' }
 *   --var x=true            → { path: 'x', value: true }
 *   --var x=null            → { path: 'x', value: null }
 *   --var x=[1,2,3]         → { path: 'x', value: [1,2,3] }
 *   --var person.name=Alice → { path: 'person.name', value: 'Alice' }
 */
function parseVarArg(arg) {
  const eqIdx = arg.indexOf('=');
  if (eqIdx === -1) {
    throw new Error(`Invalid --var format: "${arg}". Expected key=value (e.g. --var x=42)`);
  }
  const path = arg.slice(0, eqIdx);
  const rawValue = arg.slice(eqIdx + 1);

  if (path.length === 0) {
    throw new Error(`Invalid --var format: "${arg}". Path is empty.`);
  }
  if (path.split('.').some((segment) => segment.length === 0)) {
    throw new Error(`Invalid --var path "${path}": empty path segment (consecutive dots or leading/trailing dot).`);
  }

  let value;
  try {
    value = JSON.parse(rawValue);
  } catch {
    value = rawValue;
  }

  return { path, value };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function describeType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Walk a dot path on `target` and assign `value` at the leaf.
 * Throws when an intermediate path segment is already a non-object
 * (you can't nest a property under a scalar/array/null).
 *
 * Replacing an object with a scalar at the leaf is allowed (last
 * write wins) — only nesting into a non-object fails.
 */
function setNestedValue(target, path, value) {
  const keys = path.split('.');
  let cursor = target;

  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    const existing = cursor[key];
    if (existing === undefined) {
      cursor[key] = {};
    } else if (!isPlainObject(existing)) {
      const sofar = keys.slice(0, i + 1).join('.');
      throw new Error(
        `Cannot set --var ${path}: '${sofar}' is of type ${describeType(existing)}; cannot nest a property under it.`,
      );
    }
    cursor = cursor[key];
  }

  cursor[keys[keys.length - 1]] = value;
}

/**
 * Build the final variables context: start from `--vars` (JSON), then
 * apply each `--var` in order. Conflicts (nesting into a scalar)
 * throw immediately with the offending path.
 */
function buildVariables(varsJson, varArgs) {
  const fromJson = parseVarsJson(varsJson);
  if (varArgs.length === 0) return fromJson;

  const merged = fromJson ? structuredClone(fromJson) : {};
  for (const arg of varArgs) {
    const { path, value } = parseVarArg(arg);
    setNestedValue(merged, path, value);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Cluster engine
// ---------------------------------------------------------------------------

const LOCAL_HINT =
  "use `--engine local` to evaluate via feelin (note: feelin doesn't support all Camunda FEEL extensions; result may differ from cluster)";

const PARSE_ERROR_PREFIX_RE = /^Command 'EVALUATE' rejected with code '[A-Z_]+': /;

/**
 * Strip the verbose Zeebe prefix from parse-error details.
 *   "Command 'EVALUATE' rejected with code 'INVALID_ARGUMENT': Failed to parse ..."
 * → "Failed to parse ..."
 */
function cleanParseDetail(detail) {
  return detail.replace(PARSE_ERROR_PREFIX_RE, '');
}

/**
 * Walk the cause chain looking for a network error code.
 * The SDK can wrap errors several layers deep (TypeError →
 * AggregateError → individual fetch errors), so a single-level
 * `error.cause.code` check isn't enough.
 */
function findNetworkErrorCode(error) {
  let cur = error;
  const seen = new Set();
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    if (typeof cur.code === 'string') return cur.code;
    if (Array.isArray(cur.errors)) {
      for (const e of cur.errors) {
        if (e && typeof e === 'object' && typeof e.code === 'string') return e.code;
      }
    }
    cur = cur.cause;
  }
  return undefined;
}

/**
 * Translate a network-level error code into an actionable title.
 * Mirrors the table used by the deployments command for consistency.
 */
function networkErrorMessage(error) {
  const code = findNetworkErrorCode(error);

  if (!code && error?.name === 'AbortError') {
    return 'Request to Camunda cluster timed out or was aborted.';
  }

  switch (code) {
    case 'ECONNREFUSED':
      return 'Cannot connect to Camunda cluster (connection refused). Verify the endpoint URL and that the cluster is reachable.';
    case 'ENOTFOUND':
      return 'Cannot resolve Camunda cluster host. Check the cluster URL and your DNS/network configuration.';
    case 'EHOSTUNREACH':
      return 'Camunda cluster host is unreachable. Check VPN/proxy settings and your network connectivity.';
    case 'ECONNRESET':
      return 'Connection to Camunda cluster was reset. Retry the operation.';
    case 'ETIMEDOUT':
      return 'Request to Camunda cluster timed out.';
    default:
      return undefined;
  }
}

/**
 * Translate an SDK / fetch error into a `{ title, hint }` pair we can render.
 * Returns null if the error wasn't a recognized cluster-side failure.
 */
function classifyClusterError(error) {
  // RFC 9457 Problem Detail (SDK throws plain objects)
  if (error && typeof error === 'object' && 'status' in error) {
    const status = error.status;
    const title = typeof error.title === 'string' ? error.title : undefined;
    const detail = typeof error.detail === 'string' ? error.detail : undefined;

    if (status === 400) {
      const cleaned = detail ? cleanParseDetail(detail) : title || 'Invalid expression';
      return { title: cleaned, hint: null, terminal: true };
    }
    if (status === 401 || title === 'UNAUTHENTICATED') {
      return {
        title: `Authentication failed (${status}). Run \`c8ctl auth login\` to refresh.`,
        hint: LOCAL_HINT,
        terminal: true,
      };
    }
    if (status === 403 || title === 'PERMISSION_DENIED') {
      return {
        title: `Authorization failed (${status}): not permitted to evaluate expressions.`,
        hint: LOCAL_HINT,
        terminal: true,
      };
    }
    if (status === 404 || title === 'NOT_FOUND') {
      return {
        title:
          'Cluster does not support FEEL evaluation (404). Requires Camunda 8.9+.',
        hint: LOCAL_HINT,
        terminal: true,
      };
    }
    if (typeof status === 'number' && status >= 500) {
      const head = detail ? `${title ?? 'Server error'}: ${detail}` : title ?? 'Server error';
      return { title: `Cluster returned ${status}: ${head}`, hint: null, terminal: true };
    }
  }

  // Network-level errors (no HTTP response)
  const networkTitle = networkErrorMessage(error);
  if (networkTitle) {
    return { title: networkTitle, hint: LOCAL_HINT, terminal: true };
  }

  return null;
}

async function evaluateCluster({ expression, variables, tenantId }) {
  if (!globalThis.c8ctl) {
    throw new Error(
      `c8ctl runtime is not available. ${LOCAL_HINT}.`,
    );
  }

  let client;
  try {
    client = globalThis.c8ctl.createClient();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`No cluster configured: ${message}\n${LOCAL_HINT}.`);
  }

  let response;
  try {
    response = await client.evaluateExpression({
      expression: normalizeExpression(expression),
      ...(variables !== undefined ? { variables } : {}),
      ...(tenantId !== undefined ? { tenantId } : {}),
    });
  } catch (error) {
    const classified = classifyClusterError(error);
    if (classified) {
      const lines = [classified.title];
      if (classified.hint) lines.push(`  Hint: ${classified.hint}`);
      const wrapped = new Error(lines.join('\n'));
      wrapped.cause = error;
      throw wrapped;
    }
    throw error;
  }

  return {
    expression,
    result: response.result ?? null,
    warnings: Array.isArray(response.warnings) ? response.warnings : [],
  };
}

// ---------------------------------------------------------------------------
// Local engine (feelin)
// ---------------------------------------------------------------------------

/**
 * Normalize feelin's warnings (unknown shape per release) to `{ message }`.
 */
function normalizeFeelinWarnings(warnings) {
  if (!Array.isArray(warnings)) return [];
  return warnings.map((w) => {
    if (typeof w === 'string') return { message: w };
    if (w && typeof w === 'object') {
      if (typeof w.message === 'string') return { message: w.message };
      // Best effort: stringify unknown shapes.
      return { message: JSON.stringify(w) };
    }
    return { message: String(w) };
  });
}

function evaluateLocal({ expression, variables }) {
  // feelin's `evaluate` expects the expression without the leading `=`.
  // Normalize first so we accept both forms identically across engines.
  const normalized = normalizeExpression(expression);
  const stripped = normalized.slice(1).trimStart();

  const context = variables ?? {};

  let raw;
  try {
    raw = feelinEvaluate(stripped, context);
  } catch (error) {
    // Parse errors throw in feelin; surface as our standard shape.
    const message = error instanceof Error ? error.message : String(error);
    const wrapped = new Error(`Failed to parse expression: ${message}`);
    wrapped.cause = error;
    throw wrapped;
  }

  return {
    expression,
    result: raw?.value === undefined ? null : raw.value,
    warnings: normalizeFeelinWarnings(raw?.warnings),
  };
}

// ---------------------------------------------------------------------------
// Output rendering
// ---------------------------------------------------------------------------

function formatResultForText(result) {
  if (typeof result === 'string') return result;
  if (result === null || result === undefined) return 'null';
  return JSON.stringify(result, null, 2);
}

function renderText(logger, normalized) {
  logger.output(formatResultForText(normalized.result));
  if (normalized.warnings.length > 0) {
    logger.output('');
    for (const w of normalized.warnings) {
      logger.output(`  warning  ${w.message}`);
    }
  }
}

function renderJson(logger, normalized) {
  logger.json(normalized);
}

// ---------------------------------------------------------------------------
// Subcommand: evaluate
// ---------------------------------------------------------------------------

async function evaluateSubcommand(args) {
  const logger = getLogger();
  const parsed = parseArgs(args);

  if (parsed.help) {
    logger.output(
      "Usage: c8ctl feel evaluate '<expression>' [--vars '{...}'] [--tenant <id>] [--engine cluster|local]",
    );
    return;
  }

  if (parsed.error) {
    throw new Error(parsed.error);
  }

  const expression = parsed.positionals[0];
  if (!expression) {
    throw new Error("Missing expression. Usage: c8ctl feel evaluate '<expression>' [...]");
  }
  if (parsed.positionals.length > 1) {
    throw new Error(
      `Unexpected positional argument: ${parsed.positionals[1]}. Wrap multi-word expressions in quotes.`,
    );
  }

  const variables = buildVariables(parsed.vars, parsed.varArgs);

  if (parsed.engine === 'local' && parsed.tenant) {
    logger.warn('--tenant has no effect with --engine local; ignored');
  }

  const normalized =
    parsed.engine === 'cluster'
      ? await evaluateCluster({ expression, variables, tenantId: parsed.tenant })
      : evaluateLocal({ expression, variables });

  if (isJsonMode()) {
    renderJson(logger, normalized);
  } else {
    renderText(logger, normalized);
  }
}

// ---------------------------------------------------------------------------
// Command export
// ---------------------------------------------------------------------------

const VALID_SUBCOMMANDS = ['evaluate'];

function printUsage() {
  const logger = getLogger();
  const cmd = metadata.commands.feel;
  logger.output('Usage: c8ctl feel <subcommand> [options]');
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
  feel: async (args) => {
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
      if (subcommand === 'evaluate') {
        await evaluateSubcommand(subArgs);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const logger = getLogger();
      logger.error(`Failed to feel ${subcommand}: ${message}`);
      process.exitCode = 1;
    }
  },
};
