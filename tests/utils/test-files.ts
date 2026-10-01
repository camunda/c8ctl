import { type Dirent, readdirSync } from "node:fs";
import { join } from "node:path";

type TestFileEntry = Pick<Dirent, "name" | "isDirectory" | "isFile">;

export function listTestFiles({
	testsDir,
	readDirectory = (dir) => readdirSync(dir, { withFileTypes: true }),
}: {
	testsDir: string;
	readDirectory?: (dir: string) => TestFileEntry[];
}): string[] {
	const out: string[] = [];
	function walk(dir: string): void {
		// Keep diagnostics stable across OS/filesystem directory ordering.
		const entries = readDirectory(dir).sort((a, b) =>
			a.name.localeCompare(b.name),
		);
		for (const entry of entries) {
			const abs = join(dir, entry.name);
			if (entry.isDirectory()) {
				// tests/.tmp-* contains ignored staging trees, not test sources.
				if (dir === testsDir && entry.name.startsWith(".tmp-")) continue;
				walk(abs);
			} else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
				out.push(abs);
			}
		}
	}
	walk(testsDir);
	return out;
}
