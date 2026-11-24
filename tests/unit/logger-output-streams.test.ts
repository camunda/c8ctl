import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { c8WithEnv } from "../utils/cli.ts";

describe("CLI behavioural: logger info output streams", () => {
	let dataDir: string;
	const primaryMessage = 'Primary "result"\nsecond line';

	beforeEach(() => {
		dataDir = mkdtempSync(join(tmpdir(), "c8ctl-logger-streams-"));
		const pluginDir = join(
			dataDir,
			"plugins",
			"node_modules",
			"c8ctl-plugin-logger-streams",
		);
		mkdirSync(pluginDir, { recursive: true });
		writeFileSync(
			join(pluginDir, "package.json"),
			JSON.stringify({
				name: "c8ctl-plugin-logger-streams",
				version: "1.0.0",
				type: "module",
				main: "c8ctl-plugin.js",
				keywords: ["c8ctl-plugin"],
			}),
		);
		writeFileSync(
			join(pluginDir, "c8ctl-plugin.js"),
			`export const commands = {
				"log-streams": () => {
					const logger = globalThis.c8ctl.getLogger();
					logger.info("Before");
					logger.info(${JSON.stringify(primaryMessage)}, { stream: "stdout" });
					logger.info("Diagnostic", { stream: "stderr" });
					logger.info("After", {});
					logger.output("<raw>unchanged</raw>");
				},
			};`,
		);
	});

	afterEach(() => {
		rmSync(dataDir, { recursive: true, force: true });
	});

	for (const mode of ["text", "json"]) {
		for (const fields of [[], ["--fields", "unrelated"]]) {
			test(`${mode}${fields.length > 0 ? " with --fields" : ""}: formats messages and routes each call independently`, async () => {
				const result = await c8WithEnv(
					{
						C8CTL_DATA_DIR: dataDir,
						C8CTL_MODELER_DIR: dataDir,
						C8CTL_OUTPUT_MODE: mode,
						CI: "1",
					},
					"log-streams",
					...fields,
				);
				const format = (message: string) =>
					mode === "json"
						? JSON.stringify({ status: "info", message })
						: message;
				const stdout =
					mode === "json"
						? [format(primaryMessage), "<raw>unchanged</raw>"]
						: ["Before", primaryMessage, "After", "<raw>unchanged</raw>"];
				const stderr =
					mode === "json"
						? ["Before", "Diagnostic", "After"].map(format)
						: ["Diagnostic"];

				assert.strictEqual(result.status, 0, result.stderr);
				assert.strictEqual(result.stdout, `${stdout.join("\n")}\n`);
				assert.strictEqual(result.stderr, `${stderr.join("\n")}\n`);
			});
		}
	}
});
