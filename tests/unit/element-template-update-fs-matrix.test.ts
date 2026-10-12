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
import {
	labelledInput as input,
	seedTemplateCache,
	template,
} from "../utils/element-template.ts";
import { makeTestEnv } from "../utils/mocks.ts";
import { pollUntil } from "../utils/polling.ts";
import { asyncSpawn } from "../utils/spawn.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const CLI = join(ROOT, "src/index.ts");
const CLI_TIMEOUT = 30_000;
const TASK = "Activity_17s7axj";
const FIXTURE = join(ROOT, "tests/fixtures/simple.bpmn");
const cliEnv = (dir: string) =>
	makeTestEnv({
		C8CTL_DATA_DIR: dir,
		CAMUNDA_BASE_URL: "http://test-cluster/v2",
	});
type PausePoint = "compare" | "temp-write" | "rename";

// The injected script wraps one fs function so its first matching call runs
// `debugger;`, which stops the real CLI at a syscall boundary without any
// reference to production source text. The wrapper restores the original
// before pausing and then calls the current fs function, so fault injection
// installed while paused takes effect on the paused call itself.
// The comparison read is the second read of the BPMN under the lock: the
// first one loads the input.
function pauseScript(point: PausePoint, bpmn: string) {
	const name = {
		compare: "readFileSync",
		"temp-write": "writeFileSync",
		rename: "renameSync",
	}[point];
	return `(() => {
		const fs = process.getBuiltinModule("fs");
		const bpmn = ${JSON.stringify(bpmn)};
		const lock = bpmn + ".migration.lock";
		const point = ${JSON.stringify(point)};
		const name = ${JSON.stringify(name)};
		const original = fs[name];
		let reads = 0;
		const isTemp = (path) =>
			typeof path === "string" && path.startsWith(bpmn + ".") && path.endsWith(".tmp");
		const matches = (args) =>
			point === "compare"
				? args[0] === bpmn && fs.existsSync(lock) && ++reads === 2
				: isTemp(args[0]);
		const sync = () => process.getBuiltinModule("module").syncBuiltinESMExports();
		fs[name] = function (...args) {
			if (!matches(args)) return original.apply(this, args);
			fs[name] = original;
			sync();
			globalThis.__c8ctlPausedAt = point;
			debugger;
			return fs[name].apply(this, args);
		};
		sync();
	})()`;
}

// Timeouts are safety nets; protocol events establish readiness.
async function pauseMigration({
	args,
	env,
	bpmn,
	pause,
}: {
	args: string[];
	env: NodeJS.ProcessEnv;
	bpmn: string;
	pause: PausePoint;
}) {
	const child = spawn(
		process.execPath,
		["--inspect-brk=127.0.0.1:0", CLI, "element-template", ...args],
		{ cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 },
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
		const evaluate = async (expression: string) => {
			const reply = await send("Runtime.evaluate", {
				expression,
				returnByValue: true,
			});
			const result = reply.result;
			assert.ok(
				typeof result === "object" &&
					result !== null &&
					!("exceptionDetails" in result),
				JSON.stringify(reply),
			);
			const evaluated = "result" in result ? result.result : undefined;
			return typeof evaluated === "object" &&
				evaluated !== null &&
				"value" in evaluated
				? evaluated.value
				: undefined;
		};
		await evaluate(pauseScript(pause, bpmn));
		await send("Debugger.resume");
		assert.ok(
			await pollUntil(async () => pauses === 2, 15_000, 20),
			`Migration did not reach the ${pause} pause: ${stderr}`,
		);
		assert.equal(await evaluate("globalThis.__c8ctlPausedAt"), pause);
		return {
			child,
			finish,
			dispose,
			evaluate,
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
	test(`filesystem CLI matrix: update, ${scenario}`, async (t) => {
		if (scenario.startsWith("SIG") && process.platform === "win32") {
			t.skip(
				"Windows child.kill emulates termination, not POSIX signal delivery",
			);
			return;
		}
		const dir = mkdtempSync(join(tmpdir(), "c8-migration-filesystem-"));
		const env = cliEnv(dir);
		const run = (...args: string[]) =>
			asyncSpawn("node", [CLI, "element-template", ...args], {
				cwd: ROOT,
				env,
				timeout: CLI_TIMEOUT,
			});
		let paused: Awaited<ReturnType<typeof pauseMigration>> | undefined;
		try {
			const source = template("filesystem-old", 1, [input("a", "preserve")]);
			const target = template(
				source.id,
				2,
				[input("b")],
				[
					{
						kind: "upgrade",
						sourceTemplateId: source.id,
						toVersion: 2,
						paths: [{ from: "a", to: "b" }],
					},
				],
			);
			seedTemplateCache(dir, [source, target]);
			const sourcePath = join(dir, "source.json");
			const bpmn = join(dir, "process.bpmn");
			const lock = `${bpmn}.migration.lock`;
			writeFileSync(sourcePath, JSON.stringify(source));
			const seeded = await run("apply", sourcePath, TASK, FIXTURE);
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
				[CLI, "bpmn", "format", bpmn],
				{ cwd: ROOT, env, timeout: CLI_TIMEOUT },
			);
			assert.equal(canonical.status, 0, canonical.stderr);
			assert.match(canonical.stdout, /outside migration/);
			assert.match(canonical.stdout, /inside migration/);
			writeFileSync(bpmn, canonical.stdout);
			const original = readFileSync(bpmn);
			const args = ["update", source.id, TASK, bpmn, "--in-place", "--json"];
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
				if (scenario === "missing input") assert.equal(existsSync(bpmn), false);
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
				bpmn,
				pause: beforeComparison
					? "compare"
					: scenario.endsWith("before write") ||
							scenario.startsWith("write failure with") ||
							scenario.includes("temp bytes") ||
							scenario.includes("temp write")
						? "temp-write"
						: "rename",
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
					[["--to-version=2"], /Unknown flag/],
					[["--successor"], /Unknown flag/],
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
				const envelope = JSON.parse(result.stdout).results[0];
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
					[CLI, "bpmn", "format", bpmn],
					{ cwd: ROOT, env, timeout: CLI_TIMEOUT },
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
				const noop = await run(
					"update",
					target.id,
					TASK,
					bpmn,
					"--in-place",
					"--json",
				);
				assert.equal(noop.status, 0, noop.stderr);
				assert.equal(JSON.parse(noop.stdout).results[0].noop, true);
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
				assert.match(refused.stderr, /remove a stale lock only after checking/);
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
