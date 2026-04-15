/**
 * Tests for `c8ctl completion install` and auto-refresh.
 *
 * Uses C8CTL_DATA_DIR for file-system isolation.
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	detectShell,
	extractCompletionVersion,
	getCompletionFilePath,
	getShellRcFile,
	installCompletion,
	refreshCompletionsIfStale,
} from "../../src/commands/completion.ts";

// ─── detectShell ─────────────────────────────────────────────────────────────

describe("detectShell", () => {
	let origShell: string | undefined;

	beforeEach(() => {
		origShell = process.env.SHELL;
	});

	afterEach(() => {
		if (origShell === undefined) {
			delete process.env.SHELL;
		} else {
			process.env.SHELL = origShell;
		}
	});

	test("detects bash from /bin/bash", () => {
		process.env.SHELL = "/bin/bash";
		assert.strictEqual(detectShell(), "bash");
	});

	test("detects zsh from /bin/zsh", () => {
		process.env.SHELL = "/bin/zsh";
		assert.strictEqual(detectShell(), "zsh");
	});

	test("detects fish from /usr/local/bin/fish", () => {
		process.env.SHELL = "/usr/local/bin/fish";
		assert.strictEqual(detectShell(), "fish");
	});

	test("returns undefined when $SHELL is not set", () => {
		delete process.env.SHELL;
		assert.strictEqual(detectShell(), undefined);
	});

	test("returns undefined for unsupported shell", () => {
		process.env.SHELL = "/bin/tcsh";
		assert.strictEqual(detectShell(), undefined);
	});
});

// ─── getShellRcFile ──────────────────────────────────────────────────────────

describe("getShellRcFile", () => {
	test("returns .zshrc for zsh", () => {
		const rc = getShellRcFile("zsh");
		assert.ok(rc);
		assert.ok(rc.endsWith(".zshrc"), `Expected .zshrc, got ${rc}`);
	});

	test("returns a bash profile file for bash", () => {
		const rc = getShellRcFile("bash");
		assert.ok(rc);
		assert.ok(
			rc.endsWith(".bashrc") || rc.endsWith(".bash_profile"),
			`Expected .bashrc or .bash_profile, got ${rc}`,
		);
	});

	test("returns undefined for fish (auto-loads)", () => {
		assert.strictEqual(getShellRcFile("fish"), undefined);
	});

	test("returns undefined for unsupported shell", () => {
		assert.strictEqual(getShellRcFile("nushell"), undefined);
	});
});

// ─── getCompletionFilePath ───────────────────────────────────────────────────

describe("getCompletionFilePath", () => {
	let origDataDir: string | undefined;

	beforeEach(() => {
		origDataDir = process.env.C8CTL_DATA_DIR;
		process.env.C8CTL_DATA_DIR = "/tmp/c8ctl-test";
	});

	afterEach(() => {
		if (origDataDir === undefined) {
			delete process.env.C8CTL_DATA_DIR;
		} else {
			process.env.C8CTL_DATA_DIR = origDataDir;
		}
	});

	test("returns path under data dir with correct extension", () => {
		const path = getCompletionFilePath("zsh");
		assert.strictEqual(path, "/tmp/c8ctl-test/completions/c8ctl.zsh");
	});

	test("works for all three shells", () => {
		for (const shell of ["bash", "zsh", "fish"]) {
			const path = getCompletionFilePath(shell);
			assert.ok(
				path.endsWith(`c8ctl.${shell}`),
				`Expected c8ctl.${shell}, got ${path}`,
			);
		}
	});
});

// ─── extractCompletionVersion ────────────────────────────────────────────────

describe("extractCompletionVersion", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `c8ctl-completion-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	test("extracts version from a tagged completion file", () => {
		const file = join(testDir, "c8ctl.zsh");
		writeFileSync(file, "# c8ctl-completion-version: 1.2.3\n# rest of script\n");
		assert.strictEqual(extractCompletionVersion(file), "1.2.3");
	});

	test("returns undefined for missing file", () => {
		assert.strictEqual(
			extractCompletionVersion(join(testDir, "nope")),
			undefined,
		);
	});

	test("returns undefined for file without version header", () => {
		const file = join(testDir, "c8ctl.zsh");
		writeFileSync(file, "# just a comment\n");
		assert.strictEqual(extractCompletionVersion(file), undefined);
	});
});

// ─── refreshCompletionsIfStale ───────────────────────────────────────────────

describe("refreshCompletionsIfStale", () => {
	let origDataDir: string | undefined;
	let testDir: string;

	beforeEach(() => {
		origDataDir = process.env.C8CTL_DATA_DIR;
		testDir = join(tmpdir(), `c8ctl-completion-refresh-${Date.now()}`);
		mkdirSync(join(testDir, "completions"), { recursive: true });
		process.env.C8CTL_DATA_DIR = testDir;
	});

	afterEach(() => {
		if (origDataDir === undefined) {
			delete process.env.C8CTL_DATA_DIR;
		} else {
			process.env.C8CTL_DATA_DIR = origDataDir;
		}
		rmSync(testDir, { recursive: true, force: true });
	});

	test("no-op when no completion files are installed", () => {
		// Should not throw
		refreshCompletionsIfStale("2.0.0");
	});

	test("no-op when installed version matches current", () => {
		const file = join(testDir, "completions", "c8ctl.zsh");
		writeFileSync(
			file,
			"# c8ctl-completion-version: 1.0.0\n# script body\n",
		);
		refreshCompletionsIfStale("1.0.0");
		// File should be unchanged
		const content = readFileSync(file, "utf-8");
		assert.ok(content.includes("# script body"));
	});

	test("regenerates when version is stale", () => {
		const file = join(testDir, "completions", "c8ctl.zsh");
		writeFileSync(
			file,
			"# c8ctl-completion-version: 0.9.0\n# old script\n",
		);
		refreshCompletionsIfStale("1.0.0");
		const content = readFileSync(file, "utf-8");
		// Should now have the new version header
		assert.ok(
			content.startsWith("# c8ctl-completion-version:"),
			"Should start with version header after refresh",
		);
		// Old content should be gone
		assert.ok(!content.includes("# old script"), "Old content should be replaced");
	});

	test("regenerates all installed shells", () => {
		// Install stale files for bash and zsh
		for (const shell of ["bash", "zsh"]) {
			const file = join(testDir, "completions", `c8ctl.${shell}`);
			writeFileSync(
				file,
				`# c8ctl-completion-version: 0.5.0\n# old ${shell}\n`,
			);
		}
		refreshCompletionsIfStale("1.0.0");
		for (const shell of ["bash", "zsh"]) {
			const file = join(testDir, "completions", `c8ctl.${shell}`);
			const content = readFileSync(file, "utf-8");
			assert.ok(
				!content.includes("0.5.0"),
				`${shell} should have been regenerated`,
			);
		}
	});
});

// ─── installCompletion ───────────────────────────────────────────────────────

describe("installCompletion", () => {
	let origDataDir: string | undefined;
	let testDir: string;

	beforeEach(() => {
		origDataDir = process.env.C8CTL_DATA_DIR;
		testDir = join(tmpdir(), `c8ctl-completion-install-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		process.env.C8CTL_DATA_DIR = testDir;
	});

	afterEach(() => {
		if (origDataDir === undefined) {
			delete process.env.C8CTL_DATA_DIR;
		} else {
			process.env.C8CTL_DATA_DIR = origDataDir;
		}
		rmSync(testDir, { recursive: true, force: true });
	});

	test("writes completion file for explicit shell", () => {
		installCompletion("zsh");
		const file = join(testDir, "completions", "c8ctl.zsh");
		assert.ok(existsSync(file), "Completion file should exist");
		const content = readFileSync(file, "utf-8");
		assert.ok(
			content.startsWith("# c8ctl-completion-version:"),
			"Should have version header",
		);
		// Zsh completions contain #compdef
		assert.ok(content.includes("#compdef"), "Should be valid zsh completion");
	});

	test("writes completion file for bash", () => {
		installCompletion("bash");
		const file = join(testDir, "completions", "c8ctl.bash");
		assert.ok(existsSync(file));
		const content = readFileSync(file, "utf-8");
		assert.ok(content.includes("_c8ctl_completions"));
	});

	test("creates completions directory if missing", () => {
		const completionsDir = join(testDir, "completions");
		assert.ok(!existsSync(completionsDir));
		installCompletion("bash");
		assert.ok(existsSync(completionsDir));
	});

	test("is idempotent — second install overwrites without error", () => {
		installCompletion("zsh");
		const file = join(testDir, "completions", "c8ctl.zsh");
		const first = readFileSync(file, "utf-8");
		installCompletion("zsh");
		const second = readFileSync(file, "utf-8");
		assert.strictEqual(first, second);
	});
});

// ─── version header structural invariant ─────────────────────────────────────

describe("completion version header", () => {
	test("all three generators produce a version header", () => {
		// We test via installCompletion to exercise the full path
		const origDataDir = process.env.C8CTL_DATA_DIR;
		const testDir = join(
			tmpdir(),
			`c8ctl-completion-header-${Date.now()}`,
		);
		mkdirSync(testDir, { recursive: true });
		process.env.C8CTL_DATA_DIR = testDir;

		try {
			for (const shell of ["bash", "zsh", "fish"]) {
				installCompletion(shell);
				const file = join(testDir, "completions", `c8ctl.${shell}`);
				const content = readFileSync(file, "utf-8");
				const firstLine = content.split("\n")[0];
				assert.ok(
					firstLine.startsWith("# c8ctl-completion-version:"),
					`${shell} completion should start with version header, got: ${firstLine}`,
				);
			}
		} finally {
			if (origDataDir === undefined) {
				delete process.env.C8CTL_DATA_DIR;
			} else {
				process.env.C8CTL_DATA_DIR = origDataDir;
			}
			rmSync(testDir, { recursive: true, force: true });
		}
	});
});
