/**
 * Print the test files of one shard, space separated, for `node --test <files>`.
 *
 * Usage: node --experimental-strip-types scripts/shard-test-files.ts <dir> <index>/<total>
 *
 * node's own `--test-shard` assigns files round-robin by name, which is badly
 * unbalanced for the integration suite: `search.test.ts` alone is ~40% of the
 * run time. Files are therefore assigned greedily (heaviest first onto the
 * lightest shard) using the approximate weights below. A file without a weight
 * gets DEFAULT_WEIGHT, so a newly added test is always picked up by exactly one
 * shard; stale entries in WEIGHTS are harmless.
 */

import { readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Approximate seconds per file, measured against Camunda 8.8 in CI.
const WEIGHTS: Record<string, number> = {
	"search.test.ts": 113,
	"pagination.test.ts": 50,
	"plugin-lifecycle.test.ts": 25,
	"process-instances.test.ts": 24,
	"forms.test.ts": 18,
	"watch.test.ts": 11,
	"element-template-migration.test.ts": 9,
	"process-definitions.test.ts": 8,
	"fish-completion.test.ts": 6,
	"profile-switching.test.ts": 5,
	"watch-cancellation.test.ts": 5,
	"bash-completion.test.ts": 4,
	"output-mode.test.ts": 4,
	"zsh-completion.test.ts": 4,
};
const DEFAULT_WEIGHT = 3;

/** Returns the file names of each of `total` shards, each sorted by name. */
export function assignShards(files: string[], total: number): string[][] {
	const weight = (file: string) => WEIGHTS[file] ?? DEFAULT_WEIGHT;
	const shards = Array.from({ length: total }, () => {
		const files: string[] = [];
		return { load: 0, files };
	});
	const heaviestFirst = [...files].sort(
		(a, b) => weight(b) - weight(a) || a.localeCompare(b),
	);
	for (const file of heaviestFirst) {
		const lightest = shards.reduce((min, s) => (s.load < min.load ? s : min));
		lightest.files.push(file);
		lightest.load += weight(file);
	}
	return shards.map((s) => s.files.sort());
}

export function listTestFiles(dir: string): string[] {
	return readdirSync(dir)
		.filter((name) => name.endsWith(".test.ts"))
		.sort();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const [dir, spec] = process.argv.slice(2);
	const match = /^(\d+)\/(\d+)$/.exec(spec ?? "");
	if (!dir || !match) {
		console.error("usage: shard-test-files.ts <dir> <index>/<total>");
		process.exit(2);
	}
	const index = Number(match[1]);
	const total = Number(match[2]);
	if (index < 1 || index > total) {
		console.error(`shard index must be within 1..${total}`);
		process.exit(2);
	}
	const shard = assignShards(listTestFiles(dir), total)[index - 1];
	console.log(shard.map((name) => `${dir}/${name}`).join(" "));
}
