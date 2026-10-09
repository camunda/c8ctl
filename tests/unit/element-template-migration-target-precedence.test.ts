import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	mkdirSync,
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
import { asyncSpawn } from "../utils/spawn.ts";

const TASK = "Activity_17s7axj";
const FIXTURE = resolve(import.meta.dirname, "../fixtures/simple.bpmn");
const input = (name: string, value: string, extra: object = {}) => ({
	type: "String",
	label: name,
	value,
	binding: { type: "zeebe:input", name },
	...extra,
});
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

async function run(dataDir: string, ...args: string[]) {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		CAMUNDA_BASE_URL: "http://test-cluster/v2",
		C8CTL_DATA_DIR: dataDir,
		C8CTL_OUTPUT_MODE: "text",
		HOME: dir,
		NODE_EXTRA_CA_CERTS: certificate,
	};
	delete env.NODE_TLS_REJECT_UNAUTHORIZED;
	return asyncSpawn(
		"node",
		["--experimental-strip-types", "src/index.ts", ...args],
		{ env, timeout: 30_000 },
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
					const cache = join(work, "element-templates");
					mkdirSync(cache, { recursive: true });
					const explicit = target(sameId, false);
					const stale = target(sameId, true);
					if (invalid) explicit.metadata.migratesFrom.schemaVersion = 99;
					writeFileSync(
						join(cache, "templates.json"),
						JSON.stringify([SOURCE, stale]),
					);
					writeFileSync(join(cache, "fetched-at"), String(Date.now()));
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
						run(work, "element-template", "change", ref, TASK, bpmn, ...flags);
					const preview = await migrate("--dry-run", "--json");
					assert.equal(
						preview.status,
						invalid || transport === "http" ? 1 : 0,
						preview.stderr,
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
						const report = JSON.parse(result.stdout);
						assert.deepEqual(report.to, {
							id: explicit.id,
							version: 2,
							name: "Explicit target",
							deprecated: false,
						});
						assert.deepEqual(report.recipe, {
							source: "embedded",
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
