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
 * Range evaluation is delegated to `semver` — the library npm itself uses for
 * `engines` fields — rather than hand-parsed. That gets the full npm range
 * grammar (set unions, hyphen ranges, wildcards) for free, and correctness for
 * the parts that are easy to get wrong by hand (prerelease ordering, 0.x caret
 * carve-outs, build-metadata stripping). It is a genuine root dependency of
 * this module (see `CORE_DEPENDENCIES` in
 * `tests/unit/root-dependencies-isolation.test.ts`), not something bundled
 * per-plugin the way a default plugin's own dependencies are.
 *
 * **Failing open is a design rule, not an oversight.** Three situations mean
 * "cannot evaluate": an unpublished development build of c8ctl, a host version
 * `semver` cannot parse, and a range `semver` cannot parse. All three yield
 * `unverifiable` and leave the plugin fully working. Disabling a plugin over a
 * question we could not answer would turn a diagnostic into an outage.
 *
 * **Prereleases participate in ranges**, unlike `npm install`'s default. A host
 * on `4.1.0-alpha.3` satisfies `>=4.0.0-alpha.1` here; npm would exclude it
 * without `includePrerelease`. c8ctl publishes alphas, so the npm default would
 * disable plugins on the exact channel their requirement was written for. `^`
 * and `~` still desugar to npm's prerelease-excluding upper bound (`^4.1.0` is
 * `>=4.1.0 <5.0.0-0`); an explicit `<5.0.0` does not, because it says what it
 * says.
 */

import semver from "semver";
import { isRecord, isUnversionedDevBuild } from "../../core/index.ts";

/** The `engines` key a plugin declares its host requirement under. */
export const HOST_ENGINE_KEY = "c8ctl";

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

/**
 * Whether `version` satisfies `range`, evaluated by `semver` with
 * `includePrerelease` on (see the module doc for why).
 *
 * Returns `null` when either `version` or `range` cannot be parsed — callers
 * must treat that as "cannot evaluate", never as "not satisfied".
 */
export function satisfiesRange({
	version,
	range,
}: {
	version: string;
	range: string;
}): boolean | null {
	if (semver.valid(version) === null) return null;
	if (semver.validRange(range) === null) return null;
	return semver.satisfies(version, range, { includePrerelease: true });
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
	if (semver.valid(hostVersion) === null) {
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
				"version range c8ctl understands (npm's semver range syntax — see " +
				"https://github.com/npm/node-semver#ranges). Ignoring the requirement — the plugin stays enabled.",
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
