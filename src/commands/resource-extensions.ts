/**
 * Shared default extensions for deployable / watchable resource files.
 *
 * Used by both `deploy` (allow-list for directory scanning) and `watch`
 * (default set of monitored extensions) to keep a single source of truth.
 */

export const DEPLOYABLE_EXTENSIONS = [
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
