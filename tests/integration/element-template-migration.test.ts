import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { pollUntil } from "../utils/polling.ts";
import { asyncSpawn, asyncSpawnWithStdin } from "../utils/spawn.ts";

const TASK = "Activity_17s7axj";
const fixture = resolve("tests/fixtures/simple.bpmn");
const input = (name: string, value = "", extra: object = {}) => ({
	type: "String",
	label: name,
	value,
	binding: { type: "zeebe:input", name },
	...extra,
});
const template = (
	id: string,
	version: number,
	properties: object[],
	sources?: object[],
) => ({
	id,
	name: id,
	version,
	appliesTo: ["bpmn:Task"],
	engines: { camunda: "^8.8" },
	properties: [
		{
			type: "Hidden",
			value: id,
			binding: { type: "zeebe:taskDefinition", property: "type" },
		},
		...properties,
	],
	...(sources
		? { metadata: { migratesFrom: { schemaVersion: 1, sources } } }
		: {}),
});

// Debugger breakpoints stop the real CLI at syscall boundaries without changing
// production code. Timeouts are safety nets; protocol events establish readiness.
async function pauseMigration({
	args,
	env,
	file,
	statement,
}: {
	args: string[];
	env: NodeJS.ProcessEnv;
	file: string;
	statement: string;
}) {
	const child = spawn(
		process.execPath,
		["--inspect-brk=127.0.0.1:0", "src/index.ts", "element-template", ...args],
		{ env, stdio: ["ignore", "pipe", "pipe"] },
	);
	let stdout = "";
	let stderr = "";
	let closed = false;
	let spawnError: Error | undefined;
	child.stdout.setEncoding("utf-8").on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.setEncoding("utf-8").on("data", (chunk: string) => {
		stderr += chunk;
	});
	child.on("error", (error) => {
		spawnError = error;
	});
	child.on("close", () => {
		closed = true;
	});
	let socket: WebSocket | undefined;
	const finish = async () => {
		assert.ok(
			await pollUntil(async () => closed, 15_000, 20),
			`CLI did not exit: ${stderr}`,
		);
		if (spawnError) throw spawnError;
		return { stdout, stderr, status: child.exitCode, signal: child.signalCode };
	};
	const dispose = async () => {
		if (!closed) child.kill("SIGKILL");
		socket?.close();
		await finish();
	};
	try {
		assert.ok(
			await pollUntil(
				async () => /ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/.test(stderr) || closed,
				15_000,
				20,
			),
			`Inspector did not start: ${stderr}`,
		);
		const url = stderr.match(/ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/)?.[0];
		assert.ok(url, stderr);
		socket = new WebSocket(url);
		const connection = socket;
		let opened = false;
		let protocolError = "";
		let pauses = 0;
		let hitBreakpoints: unknown;
		let id = 0;
		const replies = new Map<number, Record<string, unknown>>();
		connection.addEventListener("open", () => {
			opened = true;
		});
		connection.addEventListener("error", () => {
			protocolError = "Inspector connection failed";
		});
		connection.addEventListener("message", (event) => {
			const message: unknown = JSON.parse(String(event.data));
			if (typeof message !== "object" || message === null) return;
			if ("method" in message && message.method === "Debugger.paused") {
				pauses++;
				const params = "params" in message ? message.params : undefined;
				hitBreakpoints =
					typeof params === "object" &&
					params !== null &&
					"hitBreakpoints" in params
						? params.hitBreakpoints
						: undefined;
			}
			if ("id" in message && typeof message.id === "number") {
				replies.set(message.id, { ...message });
			}
		});
		assert.ok(await pollUntil(async () => opened, 15_000, 20), protocolError);
		const send = async (method: string, params: object = {}) => {
			const request = ++id;
			connection.send(JSON.stringify({ id: request, method, params }));
			assert.ok(
				await pollUntil(async () => replies.has(request), 15_000, 20),
				`${method}: ${protocolError || stderr}`,
			);
			const reply = replies.get(request);
			assert.ok(reply && !reply.error, JSON.stringify(reply));
			replies.delete(request);
			return reply;
		};
		await send("Debugger.enable");
		await send("Runtime.runIfWaitingForDebugger");
		assert.ok(await pollUntil(async () => pauses === 1, 15_000, 20), stderr);
		const lines = readFileSync(file, "utf-8").split("\n");
		const lineNumber = lines.findIndex((line) => line.trim() === statement);
		assert.equal(lines.filter((line) => line.trim() === statement).length, 1);
		const breakpoint = await send("Debugger.setBreakpointByUrl", {
			urlRegex: `^${pathToFileURL(file).href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
			lineNumber,
		});
		const breakpointResult = breakpoint.result;
		assert.ok(
			typeof breakpointResult === "object" &&
				breakpointResult !== null &&
				"breakpointId" in breakpointResult &&
				typeof breakpointResult.breakpointId === "string",
		);
		await send("Debugger.resume");
		assert.ok(
			await pollUntil(async () => pauses === 2, 15_000, 20),
			`Migration did not reach ${statement}: ${stderr}`,
		);
		assert.deepEqual(hitBreakpoints, [breakpointResult.breakpointId]);
		return {
			child,
			finish,
			dispose,
			evaluate: async (expression: string) => {
				const reply = await send("Runtime.evaluate", { expression });
				assert.ok(
					typeof reply.result === "object" &&
						reply.result !== null &&
						!("exceptionDetails" in reply.result),
					JSON.stringify(reply),
				);
			},
			resume: async () => {
				await send("Debugger.resume");
				connection.close();
				return finish();
			},
			resumeUntilPaused: async () => {
				const previous = pauses;
				await send("Debugger.resume");
				assert.ok(
					await pollUntil(async () => pauses === previous + 1, 15_000, 20),
					`Injected partial write did not pause: ${stderr}`,
				);
			},
		};
	} catch (error) {
		await dispose();
		throw error;
	}
}

test("simple recipe CLI integration: serialization, reports, authorization and repeated no-op", async () => {
	const dir = mkdtempSync(join(tmpdir(), "c8-migration-simple-"));
	const run = (...args: string[]) =>
		asyncSpawn("node", ["src/index.ts", "element-template", ...args], {
			env: {
				...process.env,
				C8CTL_DATA_DIR: dir,
				CAMUNDA_BASE_URL: "http://test-cluster/v2",
			},
		});
	try {
		const old = template("simple-old", 1, [
			input("a", "preserve"),
			input("keep", "carried"),
			input("drop", "remove"),
			input("empty"),
		]);
		const target = template(
			"simple-new",
			1,
			[input("b"), input("keep", "target-default"), input("empty")],
			[
				{
					kind: "change",
					sourceTemplateId: old.id,
					paths: [{ from: "input:a", to: "input:b" }],
				},
			],
		);
		mkdirSync(join(dir, "element-templates"));
		writeFileSync(
			join(dir, "element-templates/templates.json"),
			JSON.stringify([old, target]),
		);
		const oldPath = join(dir, "old.json");
		const targetPath = join(dir, "target.json");
		const bpmn = join(dir, "process.bpmn");
		writeFileSync(oldPath, JSON.stringify(old));
		writeFileSync(targetPath, JSON.stringify(target));
		const seeded = await run("apply", oldPath, TASK, fixture);
		assert.equal(seeded.status, 0, seeded.stderr);
		writeFileSync(bpmn, seeded.stdout);
		const dry = await run(
			"change",
			targetPath,
			TASK,
			bpmn,
			"--in-place",
			"--dry-run",
			"--json",
		);
		assert.equal(dry.status, 0, dry.stderr);
		const preview = JSON.parse(dry.stdout);
		assert.equal(preview.requiresAuthorization, true);
		assert.equal(preview.report.dropped[0].key, "drop");
		assert.equal(readFileSync(bpmn, "utf-8"), seeded.stdout);
		const refused = await run("change", targetPath, TASK, bpmn, "--in-place");
		assert.notEqual(refused.status, 0);
		assert.equal(readFileSync(bpmn, "utf-8"), seeded.stdout);
		const changed = await run(
			"change",
			targetPath,
			TASK,
			bpmn,
			"--in-place",
			"--allow-lossy",
			"--json",
		);
		assert.equal(changed.status, 0, changed.stderr);
		const migrated = readFileSync(bpmn, "utf-8");
		assert.match(migrated, /source="preserve" target="b"/);
		assert.match(migrated, /source="carried" target="keep"/);
		assert.match(migrated, /source="" target="empty"/);
		assert.doesNotMatch(migrated, /target="drop"/);
		const piped = await asyncSpawnWithStdin(
			"node",
			["src/index.ts", "element-template", "change", targetPath, TASK],
			(stdin) => {
				stdin.write(seeded.stdout);
			},
			{
				env: {
					...process.env,
					C8CTL_DATA_DIR: dir,
					CAMUNDA_BASE_URL: "http://test-cluster/v2",
				},
				timeout: 15_000,
			},
		);
		assert.equal(piped.status, 0, piped.stderr);
		assert.equal(piped.stdout, migrated);
		assert.match(piped.stderr, /drop/);
		const properties = await run("get-properties", targetPath, "--json");
		assert.equal(properties.status, 0, properties.stderr);
		const inspected = await run("edit", TASK, bpmn, "--set", "b=preserve");
		assert.equal(inspected.status, 0, inspected.stderr);
		assert.match(inspected.stdout, /source="preserve" target="b"/);
		const formatted = await asyncSpawn(
			"node",
			["src/index.ts", "bpmn", "format", bpmn],
			{ env: { ...process.env, C8CTL_DATA_DIR: dir } },
		);
		assert.equal(formatted.status, 0, formatted.stderr);
		assert.equal(formatted.stdout, migrated);
		assert.match(migrated, /name="Do Something"/);
		assert.match(migrated, /sourceRef="StartEvent_1"/);
		const noop = await run(
			"change",
			targetPath,
			TASK,
			bpmn,
			"--in-place",
			"--json",
		);
		assert.equal(noop.status, 0, noop.stderr);
		assert.equal(JSON.parse(noop.stdout).noop, true);
		assert.equal(readFileSync(bpmn, "utf-8"), migrated);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("complex recipe CLI integration: source upgrades, floors, nested guards and conditional values", async () => {
	const dir = mkdtempSync(join(tmpdir(), "c8-migration-complex-"));
	const run = (...args: string[]) =>
		asyncSpawn("node", ["src/index.ts", "element-template", ...args], {
			env: {
				...process.env,
				C8CTL_DATA_DIR: dir,
				CAMUNDA_BASE_URL: "http://test-cluster/v2",
			},
		});
	try {
		const source1 = template("chain", 1, [
			input("a", "azure"),
			input("host", "https://example.com"),
			input("expr", "=order.provider", { feel: "optional" }),
		]);
		const source2 = template("chain", 2, [
			input("b"),
			input("host"),
			input("expr", "", { feel: "optional" }),
		]);
		const source3 = template(
			"chain",
			3,
			[input("c"), input("host"), input("expr", "", { feel: "optional" })],
			[
				{
					kind: "upgrade",
					sourceTemplateId: "chain",
					toVersion: 3,
					paths: [{ from: "b", to: "c" }],
				},
				{
					kind: "upgrade",
					sourceTemplateId: "chain",
					toVersion: 2,
					paths: [{ from: "a", to: "b" }],
				},
				{ kind: "change", sourceTemplateId: "unrelated" },
			],
		);
		const target = template(
			"final",
			1,
			[
				input("provider"),
				input("url"),
				input("kind", "off", { id: "kind" }),
				input("child", "", { condition: { property: "kind", equals: "on" } }),
				input("expr", "", { feel: "optional" }),
				input("fallback"),
				input("unmatched", "default"),
				input("missing", "default"),
			],
			[
				{
					kind: "change",
					sourceTemplateId: "chain",
					paths: [{ to: "provider", set: "wrong-floor" }],
				},
				{
					kind: "change",
					sourceTemplateId: "chain",
					minSourceVersion: 5,
					paths: [{ to: "provider", set: "unreachable" }],
				},
				{
					kind: "change",
					sourceTemplateId: "chain",
					minSourceVersion: 3,
					paths: [
						{
							when: [
								{ path: "c", equals: "azure" },
								{ path: "c", matches: "a*" },
								{ path: "c", in: ["azure"] },
								{ path: "absent", exists: false },
							],
							rules: [
								{
									from: "input:c",
									to: "input:provider",
									valueMap: {
										rules: [{ match: "az*", value: "openai" }],
										default: "other",
									},
									note: { level: "warning", message: "Provider translated" },
								},
								{
									when: { path: "c", equals: "other", not: true },
									rules: [
										{ to: "kind", set: "on" },
										{ from: "c", to: "child", note: "Child migrated" },
									],
								},
								{ to: "url", template: `\${host}/\${c}` },
							],
						},
						{
							from: "expr",
							to: "expr",
							valueMap: { rules: [{ match: "*", value: "incorrect" }] },
						},
						{
							from: "c",
							to: "fallback",
							valueMap: {
								rules: [{ match: "no", value: "no" }],
								default: "fallback",
							},
							when: [
								{ path: "c", matches: "z*", not: true },
								{ path: "c", in: ["no"], not: true },
								{ path: "host", exists: true },
							],
						},
						{
							from: "c",
							to: "unmatched",
							valueMap: { rules: [{ match: "no", value: "no" }] },
						},
						{ to: "missing", template: `\${absent}` },
					],
				},
			],
		);
		mkdirSync(join(dir, "element-templates"));
		writeFileSync(
			join(dir, "element-templates/templates.json"),
			JSON.stringify([source1, source2, source3, target]),
		);
		const oldPath = join(dir, "old.json");
		const targetPath = join(dir, "target.json");
		const recipePath = join(dir, "recipe.json");
		const bpmn = join(dir, "process.bpmn");
		writeFileSync(oldPath, JSON.stringify(source1));
		writeFileSync(targetPath, JSON.stringify(target));
		writeFileSync(recipePath, JSON.stringify(target.metadata?.migratesFrom));
		const seeded = await run("apply", oldPath, TASK, fixture);
		assert.equal(seeded.status, 0, seeded.stderr);
		writeFileSync(bpmn, seeded.stdout);
		for (const recipeArgs of [[], ["--recipe", recipePath]]) {
			const preview = await run(
				"change",
				targetPath,
				TASK,
				bpmn,
				...recipeArgs,
				"--dry-run",
				"--json",
			);
			assert.equal(preview.status, 0, preview.stderr);
			const report = JSON.parse(preview.stdout).report;
			assert.equal(report.skipped.feel.length, 1, preview.stdout);
			assert.equal(report.skipped.noMatch.length, 1);
			assert.equal(report.skipped.template.length, 1);
			assert.ok(
				report.moved.some(
					(item: { from: { key: string }; to: { key: string } }) =>
						item.from.key === "a" && item.to.key === "provider",
				),
			);
			const changed = await run(
				"change",
				targetPath,
				TASK,
				bpmn,
				...recipeArgs,
			);
			assert.equal(changed.status, 0, changed.stderr);
			writeFileSync(join(dir, "result.bpmn"), changed.stdout);
			const reparsed = await asyncSpawn(
				"node",
				["src/index.ts", "bpmn", "format", join(dir, "result.bpmn")],
				{ env: { ...process.env, C8CTL_DATA_DIR: dir } },
			);
			assert.equal(reparsed.status, 0, reparsed.stderr);
			for (const [name, value] of [
				["provider", "openai"],
				["url", "https://example.com/azure"],
				["child", "azure"],
				["kind", "on"],
				["expr", "=order.provider"],
				["fallback", "fallback"],
			]) {
				assert.ok(
					reparsed.stdout.includes(`source="${value}" target="${name}"`),
					`${name}: ${reparsed.stdout}`,
				);
			}
			assert.doesNotMatch(reparsed.stdout, /wrong-floor|unreachable|incorrect/);
			assert.equal(readFileSync(bpmn, "utf-8"), seeded.stdout);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

for (const mode of ["change", "update"] as const) {
	for (const scenario of [
		"concurrent writer",
		"external edit",
		"external edit during temp write",
		"missing target during temp write",
		"directory target during temp write",
		"write failure with lock cleanup failure",
		"write failure with descriptor cleanup failure",
		"write failure with temp cleanup failure",
		"missing input",
		"directory input",
		"malformed input",
		"ENOSPC before temp bytes",
		"ENOSPC after partial temp bytes",
		"EIO before temp bytes",
		"EIO after partial temp bytes",
		"rename failure",
		"cross-device rename failure",
		"SIGINT before write",
		"SIGTERM before write",
		"SIGINT before rename",
		"SIGTERM before rename",
		"SIGINT during partial temp write",
		"SIGTERM during partial temp write",
	] as const) {
		test(`filesystem CLI matrix: ${mode}, ${scenario}`, async (t) => {
			if (scenario.startsWith("SIG") && process.platform === "win32") {
				t.skip(
					"Windows child.kill emulates termination, not POSIX signal delivery",
				);
				return;
			}
			const dir = mkdtempSync(join(tmpdir(), "c8-migration-filesystem-"));
			const env = {
				...process.env,
				C8CTL_DATA_DIR: dir,
				CAMUNDA_BASE_URL: "http://test-cluster/v2",
			};
			const run = (...args: string[]) =>
				asyncSpawn("node", ["src/index.ts", "element-template", ...args], {
					env,
					timeout: 15_000,
				});
			let paused: Awaited<ReturnType<typeof pauseMigration>> | undefined;
			try {
				const source = template("filesystem-old", 1, [input("a", "preserve")]);
				const target = template(
					mode === "update" ? source.id : "filesystem-new",
					2,
					[input("b")],
					[
						mode === "update"
							? {
									kind: "upgrade",
									sourceTemplateId: source.id,
									toVersion: 2,
									paths: [{ from: "a", to: "b" }],
								}
							: {
									kind: "change",
									sourceTemplateId: source.id,
									paths: [{ from: "a", to: "b" }],
								},
					],
				);
				mkdirSync(join(dir, "element-templates"));
				writeFileSync(
					join(dir, "element-templates/templates.json"),
					JSON.stringify([source, target]),
				);
				const sourcePath = join(dir, "source.json");
				const targetPath = join(dir, "target.json");
				const bpmn = join(dir, "process.bpmn");
				const lock = `${bpmn}.migration.lock`;
				writeFileSync(sourcePath, JSON.stringify(source));
				writeFileSync(targetPath, JSON.stringify(target));
				const seeded = await run("apply", sourcePath, TASK, fixture);
				assert.equal(seeded.status, 0, seeded.stderr);
				const decorated = seeded.stdout
					.replace(
						"<bpmn:definitions ",
						'<bpmn:definitions xmlns:custom="urn:c8ctl:migration-test" ',
					)
					.replace(
						'<bpmn:startEvent id="StartEvent_1" name="Start">',
						'<bpmn:startEvent id="StartEvent_1" name="Start"><bpmn:extensionElements><custom:unrelated flag="untouched"><custom:value>outside migration</custom:value></custom:unrelated></bpmn:extensionElements>',
					)
					.replace(
						"<zeebe:taskDefinition",
						'<custom:payload flag="keep"><custom:value>inside migration</custom:value></custom:payload><zeebe:taskDefinition',
					);
				writeFileSync(bpmn, decorated);
				const canonical = await asyncSpawn(
					"node",
					["src/index.ts", "bpmn", "format", bpmn],
					{ env, timeout: 15_000 },
				);
				assert.equal(canonical.status, 0, canonical.stderr);
				assert.match(canonical.stdout, /outside migration/);
				assert.match(canonical.stdout, /inside migration/);
				writeFileSync(bpmn, canonical.stdout);
				const original = readFileSync(bpmn);
				const args = [
					mode,
					...(mode === "change" ? [targetPath] : []),
					TASK,
					bpmn,
					"--in-place",
					"--json",
				];
				if (scenario.endsWith("input")) {
					if (scenario === "malformed input") writeFileSync(bpmn, "<broken");
					else {
						rmSync(bpmn);
						if (scenario === "directory input") {
							mkdirSync(bpmn);
							writeFileSync(join(bpmn, "sentinel"), "untouched");
						}
					}
					const result = await run(...args);
					assert.equal(result.status, 1, result.stderr);
					assert.equal(result.stdout, "");
					assert.notEqual(result.stderr, "");
					assert.equal(existsSync(lock), false);
					assert.deepEqual(
						readdirSync(dir).filter((name) => name.endsWith(".tmp")),
						[],
					);
					if (scenario === "missing input")
						assert.equal(existsSync(bpmn), false);
					else if (scenario === "directory input")
						assert.equal(
							readFileSync(join(bpmn, "sentinel"), "utf-8"),
							"untouched",
						);
					else assert.equal(readFileSync(bpmn, "utf-8"), "<broken");
					return;
				}
				const beforeComparison =
					scenario === "concurrent writer" || scenario === "external edit";
				paused = await pauseMigration({
					args,
					env,
					file: resolve(
						`default-plugins/element-template/${beforeComparison ? "commands/migrate.ts" : "helpers.ts"}`,
					),
					statement: beforeComparison
						? 'if (readFileSync(bpmnFilePath, "utf-8") !== input.xml)'
						: scenario.endsWith("before write") ||
								scenario.startsWith("write failure with") ||
								scenario.includes("temp bytes") ||
								scenario.includes("temp write")
							? 'writeFileSync(tmp, contents, "utf-8");'
							: "renameSync(tmp, target);",
				});
				assert.ok(existsSync(lock));
				assert.deepEqual(readFileSync(bpmn), original);
				const temps = () =>
					readdirSync(dir).filter(
						(name) => name.startsWith("process.bpmn.") && name.endsWith(".tmp"),
					);
				if (scenario === "concurrent writer") {
					for (const [flags, diagnostic] of [
						[["--unknown-migration-flag"], /Unknown flag/],
						[["--recipe"], /--recipe requires a value/],
						[
							[mode === "change" ? "--to-version=2" : "--successor"],
							/only valid for/,
						],
					] as const) {
						const invalid = await run(...args, ...flags);
						assert.equal(invalid.status, 1, invalid.stderr);
						assert.equal(invalid.stdout, "");
						assert.match(invalid.stderr, diagnostic);
						assert.ok(existsSync(lock));
						assert.deepEqual(readFileSync(bpmn), original);
						assert.deepEqual(temps(), []);
					}
					const refused = await run(...args);
					assert.equal(refused.status, 1, refused.stderr);
					assert.equal(refused.stdout, "");
					assert.match(refused.stderr, /Cannot acquire migration lock/);
					assert.ok(
						existsSync(lock),
						"losing writer must not remove owner's lock",
					);
					assert.deepEqual(readFileSync(bpmn), original);
					const result = await paused.resume();
					assert.equal(result.status, 0, result.stderr);
					const envelope = JSON.parse(result.stdout);
					assert.equal(envelope.lossless, true);
					assert.equal(envelope.to.id, target.id);
					assert.equal(envelope.to.version, target.version);
					assert.ok(
						envelope.report.moved.some(
							(item: { from: { key: string }; to: { key: string } }) =>
								item.from.key === "a" && item.to.key === "b",
						),
					);
					assert.equal(existsSync(lock), false);
					assert.deepEqual(temps(), []);
					const formatted = await asyncSpawn(
						"node",
						["src/index.ts", "bpmn", "format", bpmn],
						{ env, timeout: 15_000 },
					);
					assert.equal(formatted.status, 0, formatted.stderr);
					assert.equal(formatted.stdout, readFileSync(bpmn, "utf-8"));
					assert.match(formatted.stdout, /source="preserve" target="b"/);
					assert.ok(
						formatted.stdout.includes(`zeebe:modelerTemplate="${target.id}"`),
					);
					assert.match(formatted.stdout, /zeebe:modelerTemplateVersion="2"/);
					assert.match(formatted.stdout, /name="Do Something"/);
					assert.match(formatted.stdout, /sourceRef="StartEvent_1"/);
					for (const pattern of [
						/<bpmn:startEvent\b[\s\S]*?<\/bpmn:startEvent>/,
						/<custom:payload\b[\s\S]*?<\/custom:payload>/,
						/<bpmn:sequenceFlow[^>]*\/>/g,
						/<bpmndi:BPMNDiagram\b[\s\S]*?<\/bpmndi:BPMNDiagram>/,
					]) {
						const before = canonical.stdout.match(pattern);
						assert.ok(before, String(pattern));
						assert.deepEqual(
							[...(formatted.stdout.match(pattern) ?? [])],
							[...before],
						);
					}
					const noop = await run(...args);
					assert.equal(noop.status, 0, noop.stderr);
					assert.equal(JSON.parse(noop.stdout).noop, true);
					assert.equal(readFileSync(bpmn, "utf-8"), formatted.stdout);
					assert.equal(existsSync(lock), false);
					assert.deepEqual(temps(), []);
				} else if (scenario.startsWith("write failure with")) {
					const tempFailure = scenario.includes("temp cleanup");
					const descriptorFailure = scenario.includes("descriptor cleanup");
					await paused.evaluate(
						`(() => { const fs = process.getBuiltinModule("fs"); const unlink = fs.unlinkSync; const write = fs.writeFileSync; fs.writeFileSync = (...args) => { ${tempFailure ? "write(args[0], args[1].slice(0, 64), args[2]);" : ""} throw Object.assign(new Error("primary EIO write failure"), { code: "EIO" }); }; ${descriptorFailure ? 'fs.closeSync = () => { throw new Error("secondary descriptor cleanup failure"); };' : `fs.unlinkSync = (path) => { if (${tempFailure ? 'String(path).endsWith(".tmp")' : `path === ${JSON.stringify(lock)}`}) throw Object.assign(new Error("secondary cleanup failure"), { code: "EACCES" }); return unlink(path); };`} process.getBuiltinModule("module").syncBuiltinESMExports(); })()`,
					);
					const result = await paused.resume();
					assert.equal(result.status, 1, result.stderr);
					assert.equal(result.stdout, "");
					assert.match(result.stderr, /primary EIO write failure/);
					assert.deepEqual(readFileSync(bpmn), original);
					assert.equal(existsSync(lock), !tempFailure && !descriptorFailure);
					assert.equal(temps().length, tempFailure ? 1 : 0);
					if (tempFailure)
						assert.equal(readFileSync(join(dir, temps()[0])).length, 64);
				} else if (
					scenario.startsWith("missing target") ||
					scenario.startsWith("directory target")
				) {
					const backup = join(dir, "original.bpmn");
					await paused.evaluate(
						`(() => { const fs = process.getBuiltinModule("fs"); const write = fs.writeFileSync; fs.writeFileSync = (...args) => { write(...args); fs.renameSync(${JSON.stringify(bpmn)}, ${JSON.stringify(backup)}); ${scenario.startsWith("directory") ? `fs.mkdirSync(${JSON.stringify(bpmn)}); write(${JSON.stringify(join(bpmn, "sentinel"))}, "untouched");` : ""} }; process.getBuiltinModule("module").syncBuiltinESMExports(); })()`,
					);
					const result = await paused.resume();
					assert.equal(result.status, 1, result.stderr);
					assert.equal(result.stdout, "");
					assert.match(
						result.stderr,
						scenario.startsWith("missing") ? /ENOENT/ : /EISDIR|EPERM/,
					);
					assert.deepEqual(readFileSync(backup), original);
					if (scenario.startsWith("missing"))
						assert.equal(existsSync(bpmn), false);
					else
						assert.equal(
							readFileSync(join(bpmn, "sentinel"), "utf-8"),
							"untouched",
						);
					assert.equal(existsSync(lock), false);
					assert.deepEqual(temps(), []);
				} else if (scenario.startsWith("external edit")) {
					if (scenario.endsWith("temp write")) {
						// Change the target only after the sibling write, before replacement.
						await paused.evaluate(
							`(() => { const fs = process.getBuiltinModule("fs"); const write = fs.writeFileSync; fs.writeFileSync = (...args) => { write(...args); write(${JSON.stringify(bpmn)}, ${JSON.stringify(canonical.stdout.replace("Do Something", "Concurrent edit"))}); }; process.getBuiltinModule("module").syncBuiltinESMExports(); })()`,
						);
					}
					const edited = canonical.stdout.replace(
						"Do Something",
						"Concurrent edit",
					);
					assert.notEqual(edited, canonical.stdout);
					if (scenario === "external edit") writeFileSync(bpmn, edited);
					const result = await paused.resume();
					assert.equal(result.status, 1, result.stderr);
					assert.equal(result.stdout, "");
					assert.match(result.stderr, /BPMN changed during migration/);
					assert.equal(readFileSync(bpmn, "utf-8"), edited);
					assert.equal(existsSync(lock), false);
					assert.deepEqual(temps(), []);
				} else if (scenario.includes("temp bytes")) {
					assert.deepEqual(temps(), []);
					const code = scenario.startsWith("ENOSPC") ? "ENOSPC" : "EIO";
					const partial = scenario.includes("partial");
					await paused.evaluate(
						`(() => { const fs = process.getBuiltinModule("fs"); const write = fs.writeFileSync; fs.writeFileSync = (path, contents, options) => { ${partial ? 'write(path, contents.slice(0, 64), options); if (fs.readFileSync(path).length !== 64) throw new Error("partial write setup failed");' : ""} process.stderr.write("Injected ${code} after ${partial ? 64 : 0} temp bytes\\n"); throw Object.assign(new Error("injected ${code} write failure"), { code: "${code}" }); }; process.getBuiltinModule("module").syncBuiltinESMExports(); })()`,
					);
					const result = await paused.resume();
					assert.equal(result.status, 1, result.stderr);
					assert.equal(result.stdout, "");
					assert.match(
						result.stderr,
						new RegExp(`Injected ${code} after ${partial ? 64 : 0} temp bytes`),
					);
					assert.match(
						result.stderr,
						new RegExp(`injected ${code} write failure`),
					);
					assert.deepEqual(readFileSync(bpmn), original);
					assert.equal(existsSync(lock), false);
					assert.deepEqual(temps(), []);
				} else if (scenario === "cross-device rename failure") {
					assert.equal(temps().length, 1);
					// Inject an otherwise inaccessible filesystem error at the real CLI boundary.
					await paused.evaluate(
						'process.getBuiltinModule("fs").renameSync = () => { throw Object.assign(new Error("cross-device rename refused"), { code: "EXDEV" }); }; process.getBuiltinModule("module").syncBuiltinESMExports();',
					);
					const result = await paused.resume();
					assert.equal(result.status, 1, result.stderr);
					assert.equal(result.stdout, "");
					assert.match(result.stderr, /cross-device rename refused/);
					assert.deepEqual(readFileSync(bpmn), original);
					assert.equal(existsSync(lock), false);
					assert.deepEqual(temps(), []);
				} else if (scenario === "rename failure") {
					assert.equal(temps().length, 1);
					const backup = join(dir, "original.bpmn");
					renameSync(bpmn, backup);
					mkdirSync(bpmn);
					writeFileSync(join(bpmn, "sentinel"), "do not replace");
					const result = await paused.resume();
					assert.equal(result.status, 1, result.stderr);
					assert.equal(result.stdout, "");
					assert.match(result.stderr, /rename/);
					assert.deepEqual(readFileSync(backup), original);
					assert.equal(
						readFileSync(join(bpmn, "sentinel"), "utf-8"),
						"do not replace",
					);
					assert.equal(existsSync(lock), false);
					assert.deepEqual(
						temps(),
						[],
						"failed replacement must clean its sibling",
					);
				} else {
					const signal = scenario.startsWith("SIGINT") ? "SIGINT" : "SIGTERM";
					const partial = scenario.endsWith("partial temp write");
					if (partial) {
						// Split the injected write and pause after real sibling bytes exist.
						// This exercises real signal termination, not a blocked kernel syscall.
						await paused.evaluate(
							'(() => { const fs = process.getBuiltinModule("fs"); const write = fs.writeFileSync; fs.writeFileSync = (path, contents, options) => { write(path, contents.slice(0, 64), options); debugger; write(path, contents, options); }; process.getBuiltinModule("module").syncBuiltinESMExports(); })()',
						);
						await paused.resumeUntilPaused();
					}
					const pendingTemps = temps();
					assert.equal(
						pendingTemps.length,
						scenario.endsWith("before rename") || partial ? 1 : 0,
					);
					for (const pending of pendingTemps) {
						const bytes = readFileSync(join(dir, pending));
						if (partial) {
							assert.equal(bytes.length, 64);
							assert.ok(bytes.length < original.length);
						} else
							assert.match(
								bytes.toString("utf-8"),
								/source="preserve" target="b"/,
							);
					}
					const pendingBytes = pendingTemps.map((name) =>
						readFileSync(join(dir, name)),
					);
					assert.ok(paused.child.kill(signal));
					const result = await paused.finish();
					assert.equal(result.status, null);
					assert.equal(result.signal, signal);
					assert.equal(result.stdout, "");
					assert.deepEqual(readFileSync(bpmn), original);
					// Current interruption contract requires manual stale-lock/temp removal.
					assert.ok(existsSync(lock));
					assert.deepEqual(temps(), pendingTemps);
					assert.deepEqual(
						pendingTemps.map((name) => readFileSync(join(dir, name))),
						pendingBytes,
					);
					const refused = await run(...args);
					assert.equal(refused.status, 1, refused.stderr);
					assert.equal(refused.stdout, "");
					assert.match(
						refused.stderr,
						/remove a stale lock only after checking/,
					);
					assert.deepEqual(readFileSync(bpmn), original);
					assert.ok(existsSync(lock));
					assert.deepEqual(temps(), pendingTemps);
					assert.deepEqual(
						pendingTemps.map((name) => readFileSync(join(dir, name))),
						pendingBytes,
					);
				}
			} finally {
				await paused?.dispose();
				rmSync(dir, { recursive: true, force: true });
			}
		});
	}
}
