/**
 * The plugin → host version contract (#523).
 *
 * A plugin declares the c8ctl it needs in its own `package.json`:
 *
 * ```json
 * { "engines": { "c8ctl": ">=4.0.0-alpha.1" } }
 * ```
 *
 * `engines` is the conventional home for a host requirement and npm ignores
 * engine keys it does not know, so declaring one changes nothing about how the
 * plugin installs. The field is optional — a plugin that declares nothing is
 * `undeclared` and behaves exactly as it did before this module existed.
 *
 * Why this exists: the plugin runtime grows over time (`c8ctl.npm()` is the
 * case that prompted #523). Without a declared requirement, a plugin built
 * against a newer runtime fails inside the plugin, at command time, with
 * whatever error the missing API happens to raise — usually a bare
 * `TypeError`. With one, c8ctl can say which version is needed, at install
 * time, before anything is run.
 *
 * **Failing open is a design rule, not an oversight.** Three situations mean
 * "cannot evaluate": an unpublished development build of c8ctl, a host version
 * this module cannot parse, and a range this module cannot parse. All three
 * yield `unverifiable` and leave the plugin fully working. Disabling a plugin
 * over a question we could not answer would turn a diagnostic into an outage.
 *
 * **Prereleases participate in ranges**, unlike `npm install`'s default. A host
 * on `4.1.0-alpha.3` satisfies `>=4.0.0-alpha.1` here; npm would exclude it
 * without `includePrerelease`. c8ctl publishes alphas, so the npm default would
 * disable plugins on the exact channel their requirement was written for. `^`
 * and `~` still desugar to npm's prerelease-excluding upper bound (`^4.1.0` is
 * `>=4.1.0 <5.0.0-0`); an explicit `<5.0.0` does not, because it says what it
 * says.
 */

import { isRecord, isUnversionedDevBuild } from "../../core/index.ts";

/** The `engines` key a plugin declares its host requirement under. */
export const HOST_ENGINE_KEY = "c8ctl";

/** The comparator forms {@link satisfiesRange} understands, for error text. */
const SUPPORTED_FORMS = ">=, >, <=, <, ^, ~, an exact version, or *";

/**
 * - `undeclared` — the plugin declared no requirement (the common case).
 * - `satisfied` — the running c8ctl meets it.
 * - `incompatible` — it does not. The plugin's commands are disabled and
 *   `message` explains why.
 * - `unverifiable` — the question could not be answered; the plugin keeps
 *   working and `message` says what was skipped.
 */
export type HostCompatStatus =
	| "undeclared"
	| "satisfied"
	| "incompatible"
	| "unverifiable";

export interface HostCompatVerdict {
	status: HostCompatStatus;
	/** The declared range, verbatim, when there was one. */
	range?: string;
	/** Ready-to-print explanation. Set for `incompatible` and `unverifiable`. */
	message?: string;
	/**
	 * Why the question could not be answered, on `unverifiable` only.
	 *
	 * Callers log these differently on purpose. `unreadable-range` is a mistake
	 * in a published plugin and somebody should hear about it, so it warns.
	 * `dev-build` is the expected state of every source checkout, and
	 * `unreadable-host-version` is a property of the host rather than of the
	 * plugin it would name — warning about either would blame a plugin for
	 * something its author cannot fix, on every single invocation.
	 */
	reason?: "dev-build" | "unreadable-range" | "unreadable-host-version";
}

interface SemverCore {
	major: number;
	minor: number;
	patch: number;
}

interface ParsedVersion extends SemverCore {
	/**
	 * Dot-separated prerelease identifiers, or `null` for a release.
	 *
	 * An empty array is impossible: `1.0.0-` does not parse.
	 */
	prerelease: string[] | null;
}

/**
 * Parse a full `major.minor.patch[-prerelease]` version.
 *
 * Build metadata (`+sha`) is stripped rather than rejected — semver excludes it
 * from precedence entirely, so `4.0.0+build.5` and `4.0.0` are the same version
 * as far as any comparison here is concerned.
 *
 * Partial versions (`4`, `4.1`) are *not* accepted: they are legitimate npm
 * range syntax that this module does not implement, and returning `null` routes
 * them to the fail-open path instead of guessing at a bound.
 */
function parseVersion(version: string): ParsedVersion | null {
	const withoutBuild = version.trim().split("+", 1)[0];
	const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(
		withoutBuild,
	);
	if (!match) return null;
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		prerelease: match[4] === undefined ? null : match[4].split("."),
	};
}

/** Compare two prerelease identifiers per semver §11: numeric < alphanumeric. */
function comparePrereleaseIdentifier(a: string, b: string): number {
	const aNumeric = /^\d+$/.test(a);
	const bNumeric = /^\d+$/.test(b);
	if (aNumeric && bNumeric) return Number(a) - Number(b);
	// "Numeric identifiers always have lower precedence than alphanumeric ones."
	if (aNumeric) return -1;
	if (bNumeric) return 1;
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Three-way version compare implementing semver §11 precedence, including
 * identifier-wise prerelease ordering.
 *
 * Deliberately **not** delegating to `core`'s `isNewer`, which the update
 * notifier uses: that one compares only a prerelease's trailing number and
 * discards the tag, so it reads `4.0.0-rc.1` as older than `4.0.0-alpha.5`.
 * Wrong ordering there costs a mistimed "update available" notice; here it would
 * disable every command of a plugin whose requirement the host actually meets.
 */
function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
	if (a.major !== b.major) return a.major - b.major;
	if (a.minor !== b.minor) return a.minor - b.minor;
	if (a.patch !== b.patch) return a.patch - b.patch;

	// A release outranks any prerelease of the same core version.
	if (a.prerelease === null && b.prerelease === null) return 0;
	if (a.prerelease === null) return 1;
	if (b.prerelease === null) return -1;

	const shared = Math.min(a.prerelease.length, b.prerelease.length);
	for (let i = 0; i < shared; i++) {
		const result = comparePrereleaseIdentifier(
			a.prerelease[i],
			b.prerelease[i],
		);
		if (result !== 0) return result;
	}
	// "A larger set of pre-release fields has a higher precedence."
	return a.prerelease.length - b.prerelease.length;
}

/** Exclusive upper bound for a `^` range, per npm's 0.x carve-outs. */
function caretUpperBound(core: SemverCore): SemverCore {
	if (core.major > 0) return { major: core.major + 1, minor: 0, patch: 0 };
	if (core.minor > 0) return { major: 0, minor: core.minor + 1, patch: 0 };
	return { major: 0, minor: 0, patch: core.patch + 1 };
}

/** Exclusive upper bound for a `~` range. */
function tildeUpperBound(core: SemverCore): SemverCore {
	return { major: core.major, minor: core.minor + 1, patch: 0 };
}

/**
 * The upper bound as a parsed version, carrying the lowest possible prerelease
 * so that prereleases *of* the bound fall outside the range.
 *
 * npm spells this `<5.0.0-0`: `^4.1.0` must not admit `5.0.0-alpha.1`, which is
 * a build of the major this range excludes. c8ctl's own `main` publishes
 * `X.Y.0-alpha.N` of the next version, so anyone on the alpha channel would hit
 * this without the `-0`.
 */
function exclusiveUpperBound(core: SemverCore): ParsedVersion {
	return { ...core, prerelease: ["0"] };
}

/**
 * Evaluate one comparator against a version.
 *
 * Returns `null` when the comparator is not one of the supported forms, which
 * propagates all the way out as "cannot evaluate" rather than "not satisfied".
 */
function satisfiesComparator(
	version: ParsedVersion,
	comparator: string,
): boolean | null {
	if (comparator === "*" || comparator === "x" || comparator === "X")
		return true;

	const match = /^(>=|<=|>|<|\^|~|=)?(.+)$/.exec(comparator);
	if (!match) return null;
	const operator = match[1] ?? "=";
	const operand = parseVersion(match[2]);
	if (operand === null) return null;

	switch (operator) {
		case ">=":
			return compareVersions(version, operand) >= 0;
		case ">":
			return compareVersions(version, operand) > 0;
		case "<=":
			return compareVersions(version, operand) <= 0;
		case "<":
			return compareVersions(version, operand) < 0;
		case "=":
			return compareVersions(version, operand) === 0;
		case "^":
		case "~": {
			const upper = exclusiveUpperBound(
				operator === "^" ? caretUpperBound(operand) : tildeUpperBound(operand),
			);
			return (
				compareVersions(version, operand) >= 0 &&
				compareVersions(version, upper) < 0
			);
		}
		default:
			return null;
	}
}

/**
 * Whether `version` satisfies `range`.
 *
 * Space- or comma-separated comparators are ANDed, like npm. Returns `null` when
 * the range or the version cannot be evaluated — callers must treat that as
 * "cannot evaluate", never as "not satisfied".
 *
 * **Every comparator is parsed before any is judged.** Short-circuiting on the
 * first unsatisfied one would let an unreadable *later* comparator go unnoticed
 * and turn "cannot evaluate" into a confident `false` — which disables the
 * plugin. `"^3.0.0 || ^4.0.0"` on 4.1.0 is the case that makes this concrete:
 * `^3.0.0` alone is unsatisfied, so a short-circuiting AND would report a
 * compatible plugin as incompatible instead of noticing the unsupported `||`.
 */
export function satisfiesRange({
	version,
	range,
}: {
	version: string;
	range: string;
}): boolean | null {
	const parsedVersion = parseVersion(version);
	if (parsedVersion === null) return null;

	// Set union (`||`) and hyphen ranges (`1.2.3 - 2.0.0`) are valid npm syntax
	// that this module does not evaluate. Rejecting them up front — rather than
	// letting `||`/`-` fall through as a nonsense comparator — is what keeps them
	// on the fail-open path.
	if (range.includes("||") || / - /.test(range)) return null;

	const comparators = range
		// `>= 4.0.0` is one comparator with a space in it, not two. Join the
		// operator to its operand before splitting, or the split turns a valid
		// floor into two unreadable halves.
		.replace(/([<>=~^]+)\s+/g, "$1")
		.split(/[\s,]+/)
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
	if (comparators.length === 0) return null;

	const results = comparators.map((comparator) =>
		satisfiesComparator(parsedVersion, comparator),
	);
	if (results.includes(null)) return null;
	return results.every((result) => result === true);
}

/**
 * Read a plugin's declared host requirement from its parsed `package.json`.
 * Returns `null` for anything that is not a non-empty string, so a malformed
 * declaration is indistinguishable from no declaration at all.
 */
export function readHostRequirement(packageJson: unknown): string | null {
	if (!isRecord(packageJson)) return null;
	const { engines } = packageJson;
	if (!isRecord(engines)) return null;
	const declared = engines[HOST_ENGINE_KEY];
	if (typeof declared !== "string") return null;
	const trimmed = declared.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/**
 * Decide whether a plugin can run on this c8ctl.
 *
 * `hostVersion` is a parameter rather than a read of the runtime singleton so
 * both this decision and the loader that consumes it can be tested against
 * arbitrary versions — a source checkout always reports the unpublished
 * development version, which by design answers `unverifiable`.
 */
export function checkHostCompat({
	pluginName,
	declaredRange,
	hostVersion,
}: {
	pluginName: string;
	declaredRange: string | null;
	hostVersion: string;
}): HostCompatVerdict {
	if (declaredRange === null) return { status: "undeclared" };

	if (isUnversionedDevBuild(hostVersion)) {
		return {
			status: "unverifiable",
			range: declaredRange,
			reason: "dev-build",
			message:
				`Plugin '${pluginName}' requires c8ctl ${declaredRange}, but this is an unpublished ` +
				`development build (${hostVersion}) whose version says nothing about its API surface. ` +
				"Skipping the check — the plugin stays enabled.",
		};
	}

	// Checked before the range, because `satisfiesRange` answers `null` for both
	// "unreadable range" and "unreadable version" and only the plugin author can
	// act on the first. Collapsing them blames a plugin for the host's version
	// string — and since the scaffold ships `engines.c8ctl: "*"`, any host whose
	// version this module cannot parse (a fork, a nightly tag, a hand-edited
	// manifest) would make every scaffolded plugin warn about itself.
	if (parseVersion(hostVersion) === null) {
		return {
			status: "unverifiable",
			range: declaredRange,
			reason: "unreadable-host-version",
			message:
				`Plugin '${pluginName}' requires c8ctl ${declaredRange}, but this c8ctl reports its version ` +
				`as '${hostVersion}', which is not a version this check can compare. Skipping the check — ` +
				"the plugin stays enabled.",
		};
	}

	const satisfied = satisfiesRange({
		version: hostVersion,
		range: declaredRange,
	});
	if (satisfied === null) {
		return {
			status: "unverifiable",
			range: declaredRange,
			reason: "unreadable-range",
			message:
				`Plugin '${pluginName}' declares engines.${HOST_ENGINE_KEY} '${declaredRange}', which is not a ` +
				`version range c8ctl understands (supported: ${SUPPORTED_FORMS}). Ignoring the ` +
				"requirement — the plugin stays enabled.",
		};
	}

	if (satisfied) return { status: "satisfied", range: declaredRange };

	return {
		status: "incompatible",
		range: declaredRange,
		message:
			`Plugin '${pluginName}' requires c8ctl ${declaredRange}, but this is c8ctl ${hostVersion}. ` +
			"Upgrade with 'npm install -g @camunda8/cli@latest', or install a plugin release that " +
			`supports c8ctl ${hostVersion}.`,
	};
}
