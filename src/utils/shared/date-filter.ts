/**
 * Date range filter utilities for --between <from>..<to> flag.
 *
 * Supports ISO 8601 datetime strings and short date strings (YYYY-MM-DD).
 * Short dates are expanded: 'from' gets T00:00:00.000Z, 'to' gets T23:59:59.999Z.
 * Open-ended ranges are supported: '..<to>' (everything until a date) or '<from>..' (everything from a date).
 */

/**
 * Parse a `--between` value of the form `<from>..<to>`.
 * Either side may be omitted for an open-ended range (e.g. `..2024-12-31` or `2024-01-01..`).
 * Returns `{ from?, to? }` as ISO 8601 strings, or null on parse failure.
 * Returns null if the separator `..` is absent or if both sides are empty.
 */
export function parseBetween(
	value: string,
): { from?: string; to?: string } | null {
	const separatorIndex = value.indexOf("..");
	if (separatorIndex < 0) return null;

	const rawFrom = value.slice(0, separatorIndex).trim();
	const rawTo = value.slice(separatorIndex + 2).trim();
	if (!rawFrom && !rawTo) return null;

	const from = rawFrom
		? (expandDate(rawFrom, "start") ?? undefined)
		: undefined;
	const to = rawTo ? (expandDate(rawTo, "end") ?? undefined) : undefined;
	if (rawFrom && !from) return null;
	if (rawTo && !to) return null;

	return { from, to };
}

/**
 * Build an AdvancedDateTimeFilter object for a `--between` range.
 * Only includes `$gte`/`$lte` fields when the corresponding bound is provided,
 * supporting open-ended ranges.
 */
export function buildDateFilter(
	from?: string,
	to?: string,
): { $gte?: string; $lte?: string } {
	const filter: { $gte?: string; $lte?: string } = {};
	if (from) filter.$gte = from;
	if (to) filter.$lte = to;
	return filter;
}

/**
 * Expand a date string to a full ISO 8601 datetime string.
 * If it already contains a 'T', it is treated as a full datetime string.
 * Short dates (YYYY-MM-DD) are expanded:
 *   - 'start' boundary: T00:00:00.000Z
 *   - 'end' boundary: T23:59:59.999Z
 */
function expandDate(value: string, boundary: "start" | "end"): string | null {
	if (value.includes("T")) {
		// Validate as a datetime
		const d = new Date(value);
		if (Number.isNaN(d.getTime())) return null;
		return value;
	}

	// Expect YYYY-MM-DD
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
	const d = new Date(`${value}T00:00:00.000Z`);
	if (Number.isNaN(d.getTime())) return null;

	return boundary === "start"
		? `${value}T00:00:00.000Z`
		: `${value}T23:59:59.999Z`;
}
