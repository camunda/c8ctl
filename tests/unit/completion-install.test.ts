/**
 * Tests for `c8ctl completion install` and auto-refresh.
 *
 * Uses C8CTL_DATA_DIR for file-system isolation.
 */

import assert from "node:assert";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { c8ctl } from "../../src/core/runtime.ts";
import {
	detectShell,
	extractCompletionVersion,
	getCompletionFilePath,
	getShellRcFile,
	installCompletion,
	refreshCompletionsIfStale,
} from "../../src/framework/ui/completion.ts";

/**
 * Environment variables that `os.homedir()` consults: `HOME` on POSIX,
 * `USERPROFILE` on Windows. Tests that redirect the home directory must set
 * both, otherwise Windows runs fall through to the real user profile and the
 * RC-file assertions inspect a file the code never wrote.
 */
const HOME_ENV_VARS = ["HOME", "USERPROFILE"] as const;

/** Point every home-directory env var at `dir`. */
function setHomeEnv(dir: string): void {
	for (const key of HOME_ENV_VARS) {
		process.env[key] = dir;
	}
}

/** Snapshot the home-directory env vars so they can be restored afterwards. */
function saveHomeEnv(): Record<string, string | undefined> {
	const saved: Record<string, string | undefined> = {};
	for (const key of HOME_ENV_VARS) {
		saved[key] = process.env[key];
	}
	return saved;
}

/** Restore a snapshot taken with `saveHomeEnv()`. */
function restoreHomeEnv(saved: Record<string, string | undefined>): void {
	for (const key of HOME_ENV_VARS) {
		const value = saved[key];
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
}

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
	test("falls back to userInfo().homedir when HOME is empty (os.homedir() returns '')", () => {
		// os.homedir() on POSIX returns the empty string when HOME is set to "".
		// The implementation falls back to userInfo().homedir in that case.
		// On Windows os.homedir() reads USERPROFILE so HOME="" has no effect there.
		if (process.platform === "win32") return;

		const originalHome = process.env.HOME;
		process.env.HOME = "";

		try {
			assert.strictEqual(
				getShellRcFile("zsh"),
				join(userInfo().homedir, ".zshrc"),
			);
		} finally {
			if (originalHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = originalHome;
			}
		}
	});

	test("returns undefined rather than a broken path when home cannot be determined", () => {
		// On POSIX, HOME="" causes os.homedir() to return ""; userInfo().homedir
		// still provides the real home in a normal environment, so the function
		// returns a valid path. The `if (!home) return undefined` guard is a
		// defensive measure for unusual environments (e.g. a headless container
		// with no passwd entry) where neither source resolves to a usable dir.
		// Testing it without module mocking is not possible in this codebase, but
		// we verify here that the result is always either a meaningful absolute
		// path or undefined — never join("", ...) which produces a relative path.
		const rc = getShellRcFile("zsh");
		if (rc !== undefined) {
			assert.ok(
				rc.startsWith("/") || (rc.length > 2 && rc[1] === ":"),
				`Expected an absolute path, got ${JSON.stringify(rc)}`,
			);
		}
	});

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
		process.env.C8CTL_DATA_DIR = join(tmpdir(), "c8ctl-test");
	});

	afterEach(() => {
		if (origDataDir === undefined) {
			delete process.env.C8CTL_DATA_DIR;
		} else {
			process.env.C8CTL_DATA_DIR = origDataDir;
		}
	});

	test("returns path under data dir with correct extension", () => {
		const completionPath = getCompletionFilePath("zsh");
		assert.strictEqual(
			completionPath,
			join(tmpdir(), "c8ctl-test", "completions", "c8ctl.zsh"),
		);
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
		writeFileSync(
			file,
			"# c8ctl-completion-version: 1.2.3\n# rest of script\n",
		);
		assert.strictEqual(extractCompletionVersion(file), "1.2.3");
	});

	test("extracts version when header is not on line 1 (zsh #compdef first)", () => {
		const file = join(testDir, "c8ctl.zsh");
		writeFileSync(
			file,
			"#compdef c8ctl c8\n# c8ctl-completion-version: 2.0.0\n\n_c8ctl() {\n",
		);
		assert.strictEqual(extractCompletionVersion(file), "2.0.0");
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
		refreshCompletionsIfStale();
	});

	test("no-op when installed version matches current", () => {
		const file = join(testDir, "completions", "c8ctl.zsh");
		writeFileSync(
			file,
			`# c8ctl-completion-version: ${c8ctl.version}\n# script body\n`,
		);
		refreshCompletionsIfStale();
		// File should be unchanged
		const content = readFileSync(file, "utf-8");
		assert.ok(content.includes("# script body"));
	});

	test("regenerates when version is stale", () => {
		const file = join(testDir, "completions", "c8ctl.zsh");
		writeFileSync(
			file,
			"# c8ctl-completion-version: 0.0.0-stale\n# old script\n",
		);
		refreshCompletionsIfStale();
		const content = readFileSync(file, "utf-8");
		// Should now have the new version header
		assert.ok(
			content.includes(`# c8ctl-completion-version: ${c8ctl.version}`),
			"Should have current version header after refresh",
		);
		// Old content should be gone
		assert.ok(
			!content.includes("# old script"),
			"Old content should be replaced",
		);
	});

	test("regenerates all installed shells", () => {
		// Install stale files for bash and zsh
		for (const shell of ["bash", "zsh"]) {
			const file = join(testDir, "completions", `c8ctl.${shell}`);
			writeFileSync(
				file,
				`# c8ctl-completion-version: 0.0.0-stale\n# old ${shell}\n`,
			);
		}
		refreshCompletionsIfStale();
		for (const shell of ["bash", "zsh"]) {
			const file = join(testDir, "completions", `c8ctl.${shell}`);
			const content = readFileSync(file, "utf-8");
			assert.ok(
				!content.includes("0.0.0-stale"),
				`${shell} should have been regenerated`,
			);
		}
	});
});

// ─── installCompletion ───────────────────────────────────────────────────────

describe("installCompletion", () => {
	let origDataDir: string | undefined;
	let origHome: Record<string, string | undefined>;
	let origXdgConfigHome: string | undefined;
	let testDir: string;

	beforeEach(() => {
		origDataDir = process.env.C8CTL_DATA_DIR;
		origHome = saveHomeEnv();
		origXdgConfigHome = process.env.XDG_CONFIG_HOME;
		testDir = join(tmpdir(), `c8ctl-completion-install-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		process.env.C8CTL_DATA_DIR = testDir;
		// Isolate the home dir so RC wiring doesn't touch the real user's config
		setHomeEnv(testDir);
		// Isolate XDG config so fish completions do not write outside the temp dir
		process.env.XDG_CONFIG_HOME = join(testDir, ".config");
	});

	afterEach(() => {
		if (origDataDir === undefined) {
			delete process.env.C8CTL_DATA_DIR;
		} else {
			process.env.C8CTL_DATA_DIR = origDataDir;
		}
		restoreHomeEnv(origHome);
		if (origXdgConfigHome === undefined) {
			delete process.env.XDG_CONFIG_HOME;
		} else {
			process.env.XDG_CONFIG_HOME = origXdgConfigHome;
		}
		rmSync(testDir, { recursive: true, force: true });
	});

	test("writes completion file for explicit shell", () => {
		installCompletion("zsh");
		const file = join(testDir, "completions", "c8ctl.zsh");
		assert.ok(existsSync(file), "Completion file should exist");
		const content = readFileSync(file, "utf-8");
		assert.ok(
			content.includes("# c8ctl-completion-version:"),
			"Should have version header",
		);
		// Zsh must have #compdef on line 1 for compinit fpath discovery
		assert.ok(
			content.startsWith("#compdef"),
			"Zsh completion should start with #compdef",
		);
		// Zsh completions contain #compdef and runtime compdef for sourced use
		assert.ok(content.includes("#compdef"), "Should be valid zsh completion");
		assert.ok(
			content.includes("compdef _c8ctl c8ctl c8"),
			"Should register completion function for sourced use",
		);
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

	test("appends source line to RC file on first install", () => {
		// Create an empty .zshrc in the isolated home
		const rcFile = join(testDir, ".zshrc");
		writeFileSync(rcFile, "# existing config\n");
		installCompletion("zsh");
		const rcContent = readFileSync(rcFile, "utf-8");
		const completionFile = join(testDir, "completions", "c8ctl.zsh");
		assert.ok(
			rcContent.includes(`source '${completionFile}'`),
			"RC file should contain source line",
		);
	});

	test("does not duplicate source line on second install", () => {
		const rcFile = join(testDir, ".zshrc");
		writeFileSync(rcFile, "# existing config\n");
		installCompletion("zsh");
		installCompletion("zsh");
		const rcContent = readFileSync(rcFile, "utf-8");
		const completionFile = join(testDir, "completions", "c8ctl.zsh");
		const sourceLine = `source '${completionFile}'`;
		const count = rcContent.split(sourceLine).length - 1;
		assert.strictEqual(count, 1, "Source line should appear exactly once");
	});

	test("idempotent when data dir path contains a single quote", () => {
		// Paths with single quotes get escaped in buildSourceLine ('→'\'''),
		// so rcAlreadyConfigured must also check the escaped form.
		const dirWithQuote = join(testDir, "it's");
		mkdirSync(dirWithQuote, { recursive: true });
		process.env.C8CTL_DATA_DIR = dirWithQuote;
		setHomeEnv(dirWithQuote);
		const rcFile = join(dirWithQuote, ".zshrc");
		writeFileSync(rcFile, "# existing config\n");

		installCompletion("zsh");
		installCompletion("zsh");

		const rcContent = readFileSync(rcFile, "utf-8");
		const completionFile = join(dirWithQuote, "completions", "c8ctl.zsh");
		const escaped = completionFile.replaceAll("'", "'\\''");
		const sourceLine = `source '${escaped}'`;
		const count = rcContent.split(sourceLine).length - 1;
		assert.strictEqual(
			count,
			1,
			"Source line should appear exactly once even with quotes in path",
		);
	});
});

// ─── version header structural invariant ─────────────────────────────────────

describe("completion version header", () => {
	test("all three generators produce a version header", () => {
		// We test via installCompletion to exercise the full path
		const origDataDir = process.env.C8CTL_DATA_DIR;
		const origHome = saveHomeEnv();
		const origXdgConfigHome = process.env.XDG_CONFIG_HOME;
		const testDir = join(tmpdir(), `c8ctl-completion-header-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		process.env.C8CTL_DATA_DIR = testDir;
		setHomeEnv(testDir);
		process.env.XDG_CONFIG_HOME = testDir;

		try {
			for (const shell of ["bash", "zsh", "fish"]) {
				installCompletion(shell);
				const file = join(testDir, "completions", `c8ctl.${shell}`);
				const content = readFileSync(file, "utf-8");
				assert.ok(
					content.includes("# c8ctl-completion-version:"),
					`${shell} completion should contain version header`,
				);
			}
		} finally {
			if (origDataDir === undefined) {
				delete process.env.C8CTL_DATA_DIR;
			} else {
				process.env.C8CTL_DATA_DIR = origDataDir;
			}
			restoreHomeEnv(origHome);
			if (origXdgConfigHome === undefined) {
				delete process.env.XDG_CONFIG_HOME;
			} else {
				process.env.XDG_CONFIG_HOME = origXdgConfigHome;
			}
			rmSync(testDir, { recursive: true, force: true });
		}
	});
});
