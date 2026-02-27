/**
 * Date range filter utilities for --between <from>..<to> flag.
 *
 * Supports ISO 8601 datetime strings and short date strings (YYYY-MM-DD).
 * Short dates are expanded: 'from' gets T00:00:00.000Z, 'to' gets T23:59:59.999Z.
 */

/**
 * Parse a `--between` value of the form `<from>..<to>`.
 * Returns `{ from, to }` as ISO 8601 strings, or null on parse failure.
 */
export function parseBetween(value: string): { from: string; to: string } | null {
  const separatorIndex = value.indexOf('..');
  if (separatorIndex < 0) return null;

  const rawFrom = value.slice(0, separatorIndex).trim();
  const rawTo = value.slice(separatorIndex + 2).trim();
  if (!rawFrom || !rawTo) return null;

  const from = expandDate(rawFrom, 'start');
  const to = expandDate(rawTo, 'end');
  if (!from || !to) return null;

  return { from, to };
}

/**
 * Build an AdvancedDateTimeFilter object for a `--between` range.
 * Returns `{ $gte: from, $lte: to }` as expected by the Camunda REST API.
 */
export function buildDateFilter(from: string, to: string): { $gte: string; $lte: string } {
  return { $gte: from, $lte: to };
}

/**
 * Expand a date string to a full ISO 8601 datetime string.
 * If it already contains a 'T', it is treated as a full datetime string.
 * Short dates (YYYY-MM-DD) are expanded:
 *   - 'start' boundary: T00:00:00.000Z
 *   - 'end' boundary: T23:59:59.999Z
 */
function expandDate(value: string, boundary: 'start' | 'end'): string | null {
  if (value.includes('T')) {
    // Validate as a datetime
    const d = new Date(value);
    if (isNaN(d.getTime())) return null;
    return value;
  }

  // Expect YYYY-MM-DD
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(value + 'T00:00:00.000Z');
  if (isNaN(d.getTime())) return null;

  return boundary === 'start'
    ? `${value}T00:00:00.000Z`
    : `${value}T23:59:59.999Z`;
}
