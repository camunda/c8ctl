/**
 * MIG-004: an explicit target wins over the cache
 * (default-plugins/element-template/commands/migrate.ts)
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import {
	createServer as createHttpServer,
	type RequestListener,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { promisify } from "node:util";
import { c8WithOptions } from "../utils/cli.ts";
import {
	labelledInput as input,
	seedTemplateCache,
} from "../utils/element-template.ts";
import {
	createUpdateWorkspace,
	updateFixtures,
} from "../utils/update-workspace.ts";

const TASK = "Activity_17s7axj";
const FIXTURE = resolve(import.meta.dirname, "../fixtures/simple.bpmn");
const SOURCE = {
	id: "io.example.precedence.source",
	name: "Source",
	version: 1,
	appliesTo: ["bpmn:Task"],
	engines: { camunda: "^8.8" },
	properties: [input("a", "preserved")],
};

function target(sameId: boolean, cached: boolean) {
	return {
		...SOURCE,
		id: sameId ? SOURCE.id : "io.example.precedence.target",
		version: 2,
		name: cached ? "Cached target" : "Explicit target",
		deprecated: cached,
		properties: [
			input(cached ? "stale" : "b", "", {
				label: cached ? "Cached destination" : "Explicit destination",
				constraints: { notEmpty: true },
			}),
			input("mode", cached ? "off" : "on", { id: "mode" }),
			input("default", cached ? "cached-default" : "explicit-default"),
			input("conditional", "explicit-conditional", {
				condition: { property: "mode", equals: cached ? "never" : "on" },
			}),
			input("inactive", "must-not-materialize", {
				condition: { property: "mode", equals: "off" },
			}),
		],
		metadata: {
			migratesFrom: {
				schemaVersion: 1,
				sources: [
					{
						kind: sameId ? "upgrade" : "change",
						sourceTemplateId: SOURCE.id,
						...(sameId ? { toVersion: 2 } : {}),
						paths: [
							{
								from: "input:a",
								to: cached ? "input:stale" : "input:b",
								note: cached ? "Cached recipe" : "Explicit recipe",
							},
						],
					},
				],
			},
		},
	};
}

let dir: string;
let seededXml: string;
let certificate: string;
const urls: Record<string, string> = {};
const documents = new Map<string, object>();
const requests = new Map<string, number>();
const servers: ReturnType<typeof createHttpServer>[] = [];

function run(dataDir: string, ...args: string[]) {
	return c8WithOptions(
		{
			env: {
				C8CTL_DATA_DIR: dataDir,
				C8CTL_OUTPUT_MODE: "text",
				HOME: dir,
				NODE_EXTRA_CA_CERTS: certificate,
				NODE_TLS_REJECT_UNAUTHORIZED: undefined,
			},
			// Safety net only, not a correctness signal: it must stay above the
			// CLI's own 30 s template-fetch timeout, so a stalled fetch ends in the
			// CLI's diagnostic error rather than a kill that hides the cause.
			timeout: 60_000,
		},
		...args,
	);
}

before(async () => {
	dir = mkdtempSync(join(tmpdir(), "c8ctl-target-precedence-"));
	certificate = join(dir, "localhost.crt");
	const key = join(dir, "localhost.key");
	// Trust is scoped to CLI children; certificate verification remains enabled.
	try {
		await promisify(execFile)("openssl", [
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-keyout",
			key,
			"-out",
			certificate,
			"-days",
			"2",
			"-subj",
			"/CN=127.0.0.1",
			"-addext",
			"subjectAltName=IP:127.0.0.1",
			"-addext",
			"basicConstraints=critical,CA:TRUE",
		]);
	} catch (error) {
		throw new Error(
			"HTTPS migration precedence tests require OpenSSL on PATH with req -addext support. Install OpenSSL before running this test file.",
			{ cause: error },
		);
	}
	for (const transport of ["http", "https"] as const) {
		const handler: RequestListener = (req, res) => {
			const path = req.url ?? "";
			requests.set(path, (requests.get(path) ?? 0) + 1);
			const document = documents.get(path);
			res.writeHead(document ? 200 : 404, {
				"Content-Type": "application/json",
			});
			res.end(JSON.stringify(document ?? {}));
		};
		const server =
			transport === "http"
				? createHttpServer(handler)
				: createHttpsServer(
						{ key: readFileSync(key), cert: readFileSync(certificate) },
						handler,
					);
		servers.push(server);
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const address = server.address();
		assert.ok(address && typeof address === "object");
		urls[transport] = `${transport}://127.0.0.1:${address.port}`;
	}
	const sourcePath = join(dir, "source.json");
	writeFileSync(sourcePath, JSON.stringify(SOURCE));
	const seeded = await run(
		join(dir, "seed-data"),
		"element-template",
		"apply",
		sourcePath,
		TASK,
		FIXTURE,
	);
	assert.equal(seeded.status, 0, seeded.stderr);
	assert.equal(seeded.stderr, "");
	seededXml = seeded.stdout;
});

after(async () => {
	for (const server of servers) {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
	if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("explicit migration targets take precedence over cached identities", () => {
	for (const transport of ["file", "http", "https"] as const) {
		for (const sameId of [false, true]) {
			for (const invalid of [false, true]) {
				const name = `${transport}-${sameId ? "upgrade" : "change"}-${invalid ? "invalid" : "valid"}`;
				test(`${name}: ${transport === "http" ? "insecure URL is rejected before cache fallback" : "explicit bindings, defaults, conditions and metadata are authoritative"}`, async () => {
					const work = join(dir, name);
					const explicit = target(sameId, false);
					const stale = target(sameId, true);
					if (invalid) explicit.metadata.migratesFrom.schemaVersion = 99;
					seedTemplateCache(work, [SOURCE, stale]);
					const templatePath = join(work, "target.json");
					writeFileSync(templatePath, JSON.stringify(explicit));
					documents.set(`/${name}.json`, explicit);
					const ref =
						transport === "file"
							? templatePath
							: `${urls[transport]}/${name}.json`;
					const bpmn = join(work, "diagram.bpmn");
					writeFileSync(bpmn, seededXml);
					const mtime = statSync(bpmn).mtimeMs;
					const migrate = (...flags: string[]) =>
						run(
							work,
							"element-template",
							"update",
							SOURCE.id,
							TASK,
							bpmn,
							"--to",
							ref,
							...flags,
						);
					const preview = await migrate("--dry-run", "--json");
					assert.equal(
						preview.status,
						invalid || transport === "http" ? 1 : 0,
						// Server-side request count tells a stalled fetch (request
						// never arrived) apart from a slow or failed response.
						`${preview.stderr}\nrequests served for /${name}.json: ${requests.get(`/${name}.json`) ?? 0}`,
					);
					assert.equal(readFileSync(bpmn, "utf-8"), seededXml);
					assert.equal(statSync(bpmn).mtimeMs, mtime);
					if (invalid || transport === "http") {
						const diagnostic =
							transport === "http"
								? /Insecure template URL rejected:.*Template URLs must use HTTPS/s
								: /schemaVersion/;
						assert.equal(preview.stdout, "");
						assert.match(preview.stderr, diagnostic);
						const rejected = await migrate("--in-place", "--json");
						assert.equal(rejected.status, 1, rejected.stderr);
						assert.equal(rejected.stdout, "");
						assert.match(rejected.stderr, diagnostic);
						assert.equal(readFileSync(bpmn, "utf-8"), seededXml);
						assert.equal(statSync(bpmn).mtimeMs, mtime);
						if (transport === "http") {
							assert.equal(requests.get(`/${name}.json`), undefined);
						}
						return;
					}
					assert.equal(preview.stderr, "");
					const text = await migrate("--dry-run");
					assert.equal(text.status, 0, text.stderr);
					assert.equal(text.stderr, "");
					assert.match(text.stdout, /Explicit target/);
					assert.match(text.stdout, /Explicit destination/);
					assert.match(text.stdout, /Explicit recipe/);
					assert.doesNotMatch(text.stdout, /Cached|cached-default|stale/);
					assert.equal(readFileSync(bpmn, "utf-8"), seededXml);
					assert.equal(statSync(bpmn).mtimeMs, mtime);
					const migrated = await migrate("--in-place", "--json");
					assert.equal(migrated.status, 0, migrated.stderr);
					assert.equal(migrated.stderr, "");
					for (const result of [preview, migrated]) {
						const report = JSON.parse(result.stdout).results[0];
						assert.deepEqual(report.to, {
							id: explicit.id,
							version: 2,
							name: "Explicit target",
							deprecated: false,
						});
						assert.deepEqual(report.recipe, {
							source: "embedded",
							owner: explicit.id,
							used: true,
							refusal: null,
						});
						assert.equal(report.lossless, true);
						assert.deepEqual(report.report.dropped, []);
						for (const [key, value] of [
							["mode", "on"],
							["default", "explicit-default"],
							["conditional", "explicit-conditional"],
						]) {
							assert.ok(
								report.report.added.some(
									(field: { key: string; value: string }) =>
										field.key === key && field.value === value,
								),
								`report must include ${key}=${value}`,
							);
						}
						assert.equal(report.report.moved.length, 1);
						assert.equal(report.report.moved[0].to.key, "b");
						assert.equal(
							report.report.moved[0].to.label,
							"Explicit destination",
						);
						assert.deepEqual(report.report.notes, [
							{ level: "info", message: "Explicit recipe" },
						]);
						assert.doesNotMatch(result.stdout, /Cached|cached-default|stale/);
					}
					const xml = readFileSync(bpmn, "utf-8");
					assert.match(xml, new RegExp(`modelerTemplate="${explicit.id}"`));
					assert.match(xml, /modelerTemplateVersion="2"/);
					for (const [key, value] of [
						["b", "preserved"],
						["mode", "on"],
						["default", "explicit-default"],
						["conditional", "explicit-conditional"],
					]) {
						assert.match(xml, new RegExp(`source="${value}" target="${key}"`));
					}
					assert.doesNotMatch(
						xml,
						/target="(?:a|stale|inactive)"|cached-default/,
					);
					const reparsed = await run(work, "bpmn", "format", bpmn);
					assert.equal(reparsed.status, 0, reparsed.stderr);
					assert.equal(reparsed.stderr, "");
					assert.equal(reparsed.stdout, xml);
					if (transport === "https") {
						assert.equal(requests.get(`/${name}.json`), 3);
					}
				});
			}
		}
	}
});

describe("update CLI: target precedence over the cache (shared update fixtures)", () => {
	const w = createUpdateWorkspace();
	const { TASK, NEW, V1, V2 } = updateFixtures;
	const { ws } = w;
	const { run, dataDirWithCache, setup, teardown, assertCleanedUp } = w;
	before(setup);
	after(teardown);

	describe("migration catalog selection authority", () => {
		test("rejects conflicting cached targets before selection on every cache-driven path", async () => {
			const successor = {
				...NEW,
				metadata: {
					migratesFrom: {
						schemaVersion: 1,
						sources: [{ kind: "change", sourceTemplateId: V1.id }],
					},
				},
			};
			for (const [target, commands] of [
				[
					V2,
					[
						["update", V1.id, TASK, ws.versionedBpmn],
						["update", V1.id, TASK, ws.versionedBpmn, "--to", `${V2.id}@2`],
						["update", V1.id, TASK, ws.versionedBpmn, "--to", V2.id],
					],
				],
				[
					successor,
					[["update", V1.id, TASK, ws.versionedBpmn, "--to", successor.id]],
				],
			] as const) {
				const shadow = { ...target, name: "Conflicting cached target" };
				const diagnostics: string[] = [];
				for (const duplicates of [
					[target, shadow],
					[shadow, target],
				]) {
					const dataDir = dataDirWithCache([V1, ...duplicates]);
					for (const command of commands) {
						const result = await run(
							dataDir,
							...command,
							"--dry-run",
							"--json",
						);
						assert.strictEqual(result.status, 1, result.stdout);
						assert.strictEqual(result.stdout, "");
						assert.match(result.stderr, /Conflicting definitions for template/);
						diagnostics.push(
							result.stderr.slice(
								result.stderr.indexOf("Conflicting definitions"),
							),
						);
					}
				}
				assert.ok(diagnostics.every((message) => message === diagnostics[0]));
				for (const command of commands) {
					const result = await run(
						dataDirWithCache([V1, target, structuredClone(target)]),
						...command,
						"--dry-run",
						"--allow-lossy",
						"--json",
					);
					assert.strictEqual(result.status, 0, result.stderr);
					assert.strictEqual(result.stderr, "");
					assert.strictEqual(
						JSON.parse(result.stdout).results[0].to.id,
						target.id,
					);
				}
			}
		});
	});

	test("removes every temp dir it created", assertCleanedUp);
});
