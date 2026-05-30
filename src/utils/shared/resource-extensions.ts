/**
 * Shared default extensions for deployable / watchable resource files.
 *
 * Used by both `deploy` (allow-list for directory scanning) and `watch`
 * (default set of monitored extensions) to keep a single source of truth.
 *
 * The default is intentionally narrow: only file types that are
 * unambiguously Camunda resources regardless of server version.
 * Users opt in to expanded types via `--extensions` or `--all-extensions`.
 *
 * See https://github.com/camunda/c8ctl/issues/350
 */

export const DEPLOYABLE_EXTENSIONS = [".bpmn", ".dmn", ".form"];

/**
 * Extended extensions supported by Camunda 8.10+.
 * Used by `--all-extensions` to include every server-supported type
 * during directory discovery.
 */
export const ALL_DEPLOYABLE_EXTENSIONS = [
	".bpmn",
	".dmn",
	".form",
	".md",
	".txt",
	".xml",
	".rpa",
	".json",
	".config",
	".yml",
	".yaml",
];
