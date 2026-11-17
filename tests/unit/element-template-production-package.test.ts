import assert from "node:assert/strict";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { isRecord } from "../../src/core/logger.ts";
import { seedTemplateCache } from "../utils/element-template.ts";
import { asyncSpawn } from "../utils/spawn.ts";
import { FIXTURE_BPMN, NEW, OLD, TASK } from "../utils/update-workspace.ts";

const ROOT = resolve(import.meta.dirname, "../..");

test("installed production CLI migrates without the dev-only package module", async () => {
	const installDir = mkdtempSync(join(tmpdir(), "c8ctl-production-install-"));
	try {
		const distDir = join(installDir, "dist");
		cpSync(join(ROOT, "dist"), distDir, { recursive: true });
		writeFileSync(
			join(installDir, "package.json"),
			JSON.stringify({
				name: "c8ctl-production-install-test",
				type: "module",
				version: "0.0.0",
			}),
		);
		const nodeModulesDir = join(installDir, "node_modules");
		const manifest: unknown = JSON.parse(
			readFileSync(join(ROOT, "package.json"), "utf-8"),
		);
		if (!isRecord(manifest) || !isRecord(manifest.dependencies)) {
			throw new Error("Root package.json has no runtime dependency map");
		}
		for (const dependency of Object.keys(manifest.dependencies)) {
			const source = join(ROOT, "node_modules", ...dependency.split("/"));
			const target = join(nodeModulesDir, ...dependency.split("/"));
			assert.ok(existsSync(source), `Missing runtime dependency ${dependency}`);
			mkdirSync(dirname(target), { recursive: true });
			symlinkSync(source, target, "junction");
		}

		assert.strictEqual(
			existsSync(join(nodeModulesDir, "bpmn-js-element-templates")),
			false,
		);
		const builtPlugin = readFileSync(
			join(distDir, "default-plugins", "element-template", "c8ctl-plugin.js"),
			"utf-8",
		);
		assert.doesNotMatch(
			builtPlugin,
			/bpmn-js-element-templates\/migration/,
			"The installed plugin must not resolve the dev-only package at runtime",
		);

		const dataDir = join(installDir, "data");
		mkdirSync(dataDir);
		writeFileSync(
			join(dataDir, "session.json"),
			JSON.stringify({ outputMode: "json" }),
		);
		seedTemplateCache(dataDir, [OLD, NEW]);
		const oldTemplate = join(installDir, "old.template.json");
		const bpmnFile = join(installDir, "process.bpmn");
		writeFileSync(oldTemplate, JSON.stringify(OLD));
		const cli = join(distDir, "index.js");
		const env: NodeJS.ProcessEnv = {
			...process.env,
			C8CTL_DATA_DIR: dataDir,
			CAMUNDA_BASE_URL: "http://test-cluster/v2",
			HOME: join(installDir, "home"),
			NO_COLOR: "1",
		};
		delete env.DEBUG;
		delete env.C8CTL_DEBUG;
		delete env.NODE_DEBUG;
		delete env.NODE_OPTIONS;
		delete env.NODE_PATH;

		const applied = await asyncSpawn(
			"node",
			[cli, "element-template", "apply", oldTemplate, TASK, FIXTURE_BPMN],
			{ cwd: installDir, env, timeout: 30_000 },
		);
		assert.strictEqual(applied.status, 0, applied.stderr);
		writeFileSync(bpmnFile, applied.stdout);

		const migrated = await asyncSpawn(
			"node",
			[
				cli,
				"element-template",
				"update",
				OLD.id,
				TASK,
				bpmnFile,
				"--to",
				NEW.id,
				"--dry-run",
				"--allow-lossy",
				"--json",
			],
			{ cwd: installDir, env, timeout: 30_000 },
		);
		assert.strictEqual(migrated.status, 0, migrated.stderr);
		assert.strictEqual(
			JSON.parse(migrated.stdout).results[0].status,
			"updated",
		);
	} finally {
		rmSync(installDir, { recursive: true, force: true });
	}
});
