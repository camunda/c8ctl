import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { c8, c8WithEnv } from "../utils/cli.ts";

interface CapturedDeployment {
	filename: string;
	body: string;
}

async function startDeploymentServer(): Promise<{
	server: Server;
	baseUrl: string;
	deployments: CapturedDeployment[];
}> {
	const deployments: CapturedDeployment[] = [];
	const versions = new Map<string, number>();
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			const filename = body.match(/filename="([^"]+)"/)?.[1];
			if (!filename) {
				response.writeHead(400);
				response.end("Missing multipart filename");
				return;
			}

			const version = (versions.get(filename) ?? 0) + 1;
			versions.set(filename, version);
			deployments.push({ filename, body });

			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					deploymentKey: String(deployments.length),
					tenantId: "<default>",
					deployments: [
						{
							processDefinition: null,
							decisionDefinition: null,
							decisionRequirements: null,
							form: null,
							resource: {
								resourceId: filename,
								resourceName: filename,
								version,
								tenantId: "<default>",
								resourceKey: String(deployments.length),
							},
						},
					],
				}),
			);
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("deployment server did not bind to an inet address");
	}

	return {
		server,
		baseUrl: `http://127.0.0.1:${address.port}/v2`,
		deployments,
	};
}

describe("governed Markdown deployment prototype", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "c8ctl-deploy-markdown-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("uses camunda.resourceId as the upload name and strips frontmatter", async () => {
		const markdownPath = join(tempDir, "claims-review-v1.md");
		writeFileSync(
			markdownPath,
			[
				"---",
				"camunda:",
				"  resourceId: claims-review-instructions.md",
				"---",
				"# Claims review instructions",
				"",
				"Review each claim.",
			].join("\n"),
		);
		const deploymentServer = await startDeploymentServer();

		try {
			const result = await c8WithEnv(
				{ CAMUNDA_BASE_URL: deploymentServer.baseUrl },
				"deploy",
				markdownPath,
				"--force",
				"--yes",
			);

			assert.strictEqual(result.status, 0, result.stderr);
			assert.strictEqual(deploymentServer.deployments.length, 1);
			const [deployment] = deploymentServer.deployments;
			assert.strictEqual(deployment.filename, "claims-review-instructions.md");
			assert.ok(deployment.body.includes("# Claims review instructions"));
			assert.ok(deployment.body.includes("Review each claim."));
			assert.ok(!deployment.body.includes("camunda:"));
			assert.ok(!deployment.body.includes("resourceId:"));
		} finally {
			await new Promise<void>((resolve) =>
				deploymentServer.server.close(() => resolve()),
			);
		}
	});

	test("falls back to the Markdown file name when resourceId is absent", async () => {
		const markdownPath = join(tempDir, "local-instructions.md");
		writeFileSync(markdownPath, "# Local instructions\n");
		const deploymentServer = await startDeploymentServer();

		try {
			const result = await c8WithEnv(
				{ CAMUNDA_BASE_URL: deploymentServer.baseUrl },
				"deploy",
				markdownPath,
				"--force",
				"--yes",
			);

			assert.strictEqual(result.status, 0, result.stderr);
			assert.strictEqual(
				deploymentServer.deployments[0]?.filename,
				"local-instructions.md",
			);
			assert.ok(
				deploymentServer.deployments[0]?.body.includes("# Local instructions"),
			);
		} finally {
			await new Promise<void>((resolve) =>
				deploymentServer.server.close(() => resolve()),
			);
		}
	});

	test("keeps non-Markdown generic resources unchanged", async () => {
		const textPath = join(tempDir, "instructions.txt");
		const content = [
			"---",
			"camunda:",
			"  resourceId: ignored.txt",
			"---",
			"Plain text instructions",
		].join("\n");
		writeFileSync(textPath, content);
		const deploymentServer = await startDeploymentServer();

		try {
			const result = await c8WithEnv(
				{ CAMUNDA_BASE_URL: deploymentServer.baseUrl },
				"deploy",
				textPath,
				"--force",
				"--yes",
			);

			assert.strictEqual(result.status, 0, result.stderr);
			assert.strictEqual(
				deploymentServer.deployments[0]?.filename,
				"instructions.txt",
			);
			assert.ok(deploymentServer.deployments[0]?.body.includes(content));
		} finally {
			await new Promise<void>((resolve) =>
				deploymentServer.server.close(() => resolve()),
			);
		}
	});

	test("rejects malformed or duplicate Markdown identity metadata", async () => {
		const malformedPath = join(tempDir, "malformed.md");
		writeFileSync(
			malformedPath,
			"---\ncamunda:\n  resourceId: [not closed\n---\nBody\n",
		);
		const malformed = await c8("deploy", malformedPath, "--force", "--yes");
		assert.strictEqual(malformed.status, 1);
		assert.match(
			malformed.stderr,
			/Invalid Markdown frontmatter in .*malformed\.md/,
		);

		const duplicateKeyPath = join(tempDir, "duplicate-key.md");
		writeFileSync(
			duplicateKeyPath,
			[
				"---",
				"camunda:",
				"  resourceId: first.md",
				"  resourceId: second.md",
				"---",
				"Body",
			].join("\n"),
		);
		const duplicateKey = await c8(
			"deploy",
			duplicateKeyPath,
			"--force",
			"--yes",
		);
		assert.strictEqual(duplicateKey.status, 1);
		assert.match(
			duplicateKey.stderr,
			/Duplicate Markdown identity metadata in .*duplicate-key\.md/,
		);
	});

	test("rejects duplicate Markdown resource IDs in one deployment", async () => {
		const firstPath = join(tempDir, "first.md");
		const secondPath = join(tempDir, "second.md");
		const frontmatter = [
			"---",
			"camunda:",
			"  resourceId: claims-review-instructions.md",
			"---",
		].join("\n");
		writeFileSync(firstPath, `${frontmatter}\nVersion one\n`);
		writeFileSync(secondPath, `${frontmatter}\nVersion two\n`);

		const result = await c8(
			"deploy",
			firstPath,
			secondPath,
			"--force",
			"--yes",
		);

		assert.strictEqual(result.status, 1);
		assert.match(
			result.stderr,
			/Duplicate Markdown resource ID.*claims-review-instructions\.md/,
		);
		assert.match(result.stderr, /first\.md/);
		assert.match(result.stderr, /second\.md/);
	});

	test("separate file paths with the same Markdown ID create successive versions", async () => {
		const firstPath = join(tempDir, "claims-review-v1.md");
		const secondPath = join(tempDir, "claims-review-v2.md");
		const frontmatter = [
			"---",
			"camunda:",
			"  resourceId: claims-review-instructions.md",
			"---",
		].join("\n");
		writeFileSync(firstPath, `${frontmatter}\nVersion one\n`);
		writeFileSync(secondPath, `${frontmatter}\nVersion two\n`);
		const deploymentServer = await startDeploymentServer();

		try {
			const first = await c8WithEnv(
				{ CAMUNDA_BASE_URL: deploymentServer.baseUrl },
				"deploy",
				firstPath,
				"--force",
				"--yes",
			);
			const second = await c8WithEnv(
				{ CAMUNDA_BASE_URL: deploymentServer.baseUrl },
				"deploy",
				secondPath,
				"--force",
				"--yes",
			);

			assert.strictEqual(first.status, 0, first.stderr);
			assert.strictEqual(second.status, 0, second.stderr);
			assert.deepStrictEqual(
				deploymentServer.deployments.map(({ filename }) => filename),
				["claims-review-instructions.md", "claims-review-instructions.md"],
			);
			assert.match(first.stdout, /"Version":\s*1/);
			assert.match(second.stdout, /"Version":\s*2/);
		} finally {
			await new Promise<void>((resolve) =>
				deploymentServer.server.close(() => resolve()),
			);
		}
	});
});
