/**
 * Deploy services: resolve what a deploy sends, and deploy it.
 *
 * Shared by the CLI (`deploy`, `watch`) and embedders. Typed results,
 * `C8ctlError`s, cancellation through `ctx.signal`, and no output of
 * their own (see `C8ctlContext`).
 */

import { extname } from "node:path";
import {
	type CamundaClient,
	TenantId,
} from "@camunda8/orchestration-cluster-api";
import {
	type C8ctlContext,
	C8ctlError,
	cancelledError,
	clusterErrorCode,
	connect,
	emit,
	isRecord,
	problemOf,
	type Target,
	throwIfCancelled,
	withAbort,
} from "../core/index.ts";
import {
	collectResourcesForPaths,
	DEPLOYABLE_EXTENSIONS,
	type DeployPathPlan,
	extractDefinitionId,
	findDuplicateDefinitionIds,
	meetsMinExtensionVersion,
	type Notify,
	planDeployPaths,
	type ResourceFile,
	rejectSelectionFlagsForDescriptor,
} from "../utils/index.ts";

/** A file a deploy sends. */
export interface DeployFile {
	path: string;
	name: string;
	/** The building block or Camunda project the file belongs to. */
	group?: { kind: "building-block" | "project"; root: string };
}

export interface ResolveDeploymentInput {
	/** Files and directories. A directory inside a Camunda project expands
	 *  to the project root. Default: none (an error). */
	paths: string[];
	/** Extensions a directory scan collects. Default: `.bpmn`, `.dmn`, `.form`. */
	extensions?: string[];
	/** Collect every file of a directory scan, regardless of extension. */
	force?: boolean;
}

export interface ResolveDeploymentResult {
	files: DeployFile[];
	/** Files a directory scan skipped because of their extension. */
	skipped: { files: string[]; extensions: string[] };
	/** The input paths after project-root expansion. */
	resolvedPaths: string[];
	/** Project roots whose files `deployResources` selects. */
	descriptorRoots: string[];
}

export interface DeployInput extends ResolveDeploymentInput {
	target: Target;
	/** Default: the profile's default tenant, else `<default>`. */
	tenantId?: string;
}

export type DeployedResourceType =
	| "process"
	| "decision"
	| "decision-requirements"
	| "form"
	| "resource";

export interface DeployedResource {
	type: DeployedResourceType;
	id?: string;
	version?: number;
	key?: string;
	/** The name the cluster stored the resource under. Not set for a
	 *  decision, whose file is its decision requirements resource. */
	resourceName?: string;
	/** For a decision: the key of its decision requirements graph. */
	decisionRequirementsKey?: string;
	/** The local file, when it can be matched. */
	file?: DeployFile;
}

export interface DeployResult {
	deploymentKey: string;
	tenantId: string;
	resources: DeployedResource[];
	skipped: { files: string[]; extensions: string[] };
	resolvedPaths: string[];
}

/**
 * Options a host uses when it ran parts of the flow itself, e.g. the CLI
 * resolved the plan and checked the server version before prompting.
 */
export interface DeployHostOptions {
	/** A plan resolved earlier, so descriptors are not read again. */
	plan?: DeployPathPlan[];
	/** Skips the server version check. */
	serverSupportsExtensions?: boolean;
}

function notifier(ctx: C8ctlContext): Notify {
	return (message) => emit(ctx, { type: "notice", message });
}

function toDeployFile(resource: ResourceFile): DeployFile {
	const group = resource.groupPath
		? {
				kind: resource.isBuildingBlock
					? ("building-block" as const)
					: ("project" as const),
				root: resource.groupPath,
			}
		: undefined;
	return {
		path: resource.path,
		name: resource.name,
		...(group && (resource.isBuildingBlock || resource.isProcessApplication)
			? { group }
			: {}),
	};
}

/**
 * Resolve which files a deploy of `paths` sends, without contacting a
 * cluster. Default scans use the given extensions as-is (no server
 * version check).
 */
export async function resolveDeployment(
	input: ResolveDeploymentInput,
	ctx: C8ctlContext = {},
): Promise<ResolveDeploymentResult> {
	throwIfCancelled(ctx);
	const notify = notifier(ctx);
	const plan = planDeployPaths(input.paths, { notify });
	rejectFlagsForDescriptors(plan, input);
	const collected = collectResourcesForPaths(
		input.paths,
		input.force,
		input.extensions ?? DEPLOYABLE_EXTENSIONS,
		true,
		plan,
		notify,
	);
	return {
		files: collected.resources.map(toDeployFile),
		skipped: {
			files: collected.skippedFiles,
			extensions: [...collected.skippedExtensions].sort(),
		},
		resolvedPaths: collected.effectivePaths,
		descriptorRoots: collected.descriptorRoots,
	};
}

function rejectFlagsForDescriptors(
	plan: DeployPathPlan[],
	input: ResolveDeploymentInput,
): void {
	rejectSelectionFlagsForDescriptor({
		descriptorRoots: plan
			.filter((entry) => entry.kind === "descriptor")
			.map((entry) => entry.path),
		extensions: input.extensions?.join(","),
		force: input.force,
	});
}

/**
 * Whether the cluster supports deploying extended file extensions (8.10+).
 * `false` on any error, so unsupported resource types are not sent to
 * older clusters.
 */
export async function checkServerSupportsExtensions(
	client: CamundaClient,
	warn: (message: string) => void,
	signal?: AbortSignal,
): Promise<boolean> {
	try {
		const topology = await withAbort(() => client.getTopology(), signal);
		const version = String(topology.gatewayVersion ?? "");
		const result = meetsMinExtensionVersion(version);
		if (result === null) {
			warn(
				`Could not parse server version "${version}" — assuming extended extensions are NOT supported.`,
			);
			return false;
		}
		return result;
	} catch {
		if (signal?.aborted) throw cancelledError(signal.reason);
		warn(
			"Could not reach the server to check its version (topology call failed).",
		);
		warn(
			"This can happen with OAuth/SaaS clusters before the first token is fetched, " +
				"or if the server is not yet ready. Assuming extended extensions are NOT supported.",
		);
		return false;
	}
}

/**
 * Deploy the files that `paths` resolve to.
 *
 * @throws {C8ctlError} `invalid-input`, `invalid-config`, `empty-selection`,
 *   `read-error`, `no-deployable-files`, `duplicate-definition-ids`,
 *   `profile-not-found` before any request; `connection-failed`,
 *   `unauthorized`, `forbidden`, `payload-too-large`,
 *   `deployment-rejected`, `unknown` for the request; `cancelled`.
 */
export async function deploy(
	input: DeployInput,
	ctx: C8ctlContext = {},
	hostOptions: DeployHostOptions = {},
): Promise<DeployResult> {
	throwIfCancelled(ctx);
	const notify = notifier(ctx);
	const warn = (message: string) => emit(ctx, { type: "warning", message });

	const { client, defaultTenantId } = connect(input.target, ctx);
	const tenantId = input.tenantId ?? defaultTenantId ?? "<default>";

	let plan = hostOptions.plan;
	if (!plan) {
		plan = planDeployPaths(input.paths, { notify });
		rejectFlagsForDescriptors(plan, input);
	}

	// Only a default directory scan consults the extension allow-list, so
	// `deployResources`-only deploys skip the <8.10 check.
	const skipVersionCheck =
		!!input.force ||
		(plan.some((entry) => entry.kind === "descriptor") &&
			!plan.some((entry) => entry.kind === "scan"));
	let serverSupportsExtensions = hostOptions.serverSupportsExtensions;
	if (serverSupportsExtensions === undefined) {
		emit(ctx, { type: "progress", phase: "check-server" });
		serverSupportsExtensions = skipVersionCheck
			? true
			: await checkServerSupportsExtensions(client, warn, ctx.signal);
		if (!serverSupportsExtensions && input.extensions) {
			warn(
				`Warning: server does not support extended extensions (requires 8.10+). ` +
					`Falling back to default extensions (${DEPLOYABLE_EXTENSIONS.join(", ")}). ` +
					`Use --force to deploy all files regardless.`,
			);
		}
	}
	throwIfCancelled(ctx);

	const extensions = serverSupportsExtensions
		? (input.extensions ?? DEPLOYABLE_EXTENSIONS)
		: DEPLOYABLE_EXTENSIONS;

	emit(ctx, { type: "progress", phase: "resolve" });
	const collected = collectResourcesForPaths(
		input.paths,
		input.force,
		extensions,
		serverSupportsExtensions,
		plan,
		notify,
	);
	const resources = sortForDeployment(collected.resources);
	const skipped = {
		files: collected.skippedFiles,
		extensions: [...collected.skippedExtensions].sort(),
	};
	emit(ctx, {
		type: "progress",
		phase: "resolved",
		total: resources.length,
		data: { skipped },
	});

	const duplicates = findDuplicateDefinitionIds(resources);
	if (duplicates.size > 0) {
		throw new C8ctlError(
			"duplicate-definition-ids",
			"Cannot deploy: Multiple files with the same process/decision ID in one deployment",
			{ details: { duplicates: Object.fromEntries(duplicates) } },
		);
	}

	emit(ctx, {
		type: "progress",
		phase: "deploy",
		total: resources.length,
	});
	// Checked after the event: a host may abort from the progress callback,
	// and a request that has not started cannot be cancelled cleanly.
	throwIfCancelled(ctx);

	const pendingDeploy = client.createDeployment({
		tenantId: TenantId.assumeExists(tenantId),
		resources: resources.map(
			(r) =>
				new File([new Uint8Array(r.content)], r.name, {
					type: mimeTypeOf(r.name),
				}),
		),
	});

	const onAbort = (): void => {
		pendingDeploy.cancel();
	};
	ctx.signal?.addEventListener("abort", onAbort, { once: true });

	let response: Awaited<typeof pendingDeploy>;
	try {
		response = await pendingDeploy;
	} catch (error) {
		if (ctx.signal?.aborted) {
			throw cancelledError(ctx.signal.reason);
		}
		throw classifyDeploymentError(error, resources, collected.effectivePaths);
	} finally {
		ctx.signal?.removeEventListener("abort", onAbort);
	}

	return {
		deploymentKey: response.deploymentKey.toString(),
		tenantId,
		resources: mapDeployedResources(response, resources),
		skipped,
		resolvedPaths: collected.effectivePaths,
	};
}

function mimeTypeOf(name: string): string {
	const ext = name.split(".").pop()?.toLowerCase();
	if (ext === "bpmn" || ext === "dmn") return "application/xml";
	if (ext === "form") return "application/json";
	return "application/octet-stream";
}

/**
 * Building blocks first, then project resources, then standalone files;
 * each group by group root, then by path.
 */
function sortForDeployment(resources: ResourceFile[]): ResourceFile[] {
	return [...resources].sort((a, b) => {
		if (a.isBuildingBlock !== b.isBuildingBlock) {
			return a.isBuildingBlock ? -1 : 1;
		}
		if (
			!a.isBuildingBlock &&
			a.isProcessApplication !== b.isProcessApplication
		) {
			return a.isProcessApplication ? -1 : 1;
		}
		if (
			(a.isBuildingBlock || a.isProcessApplication) &&
			a.groupPath &&
			b.groupPath
		) {
			const groupCompare = a.groupPath.localeCompare(b.groupPath);
			if (groupCompare !== 0) return groupCompare;
		}
		return a.path.localeCompare(b.path);
	});
}

type DeploymentResponse = Awaited<
	ReturnType<CamundaClient["createDeployment"]>
>;

function mapDeployedResources(
	response: DeploymentResponse,
	resources: ResourceFile[],
): DeployedResource[] {
	const byDefinitionId = new Map<string, ResourceFile>();
	const byFormId = new Map<string, ResourceFile>();
	// Several files can share a basename across directories; each response
	// record takes the next file with that name.
	const byName = new Map<string, ResourceFile[]>();

	for (const r of resources) {
		byName.set(r.name, [...(byName.get(r.name) ?? []), r]);
		const ext = extname(r.path);
		if (ext === ".bpmn" || ext === ".dmn") {
			const id = extractDefinitionId(r.content, ext);
			if (id) byDefinitionId.set(id, r);
		} else if (ext === ".form") {
			byFormId.set(formIdOf(r), r);
		}
	}
	const takeByName = (name: string | undefined) =>
		name ? byName.get(name)?.shift() : undefined;

	const matched = new Set<ResourceFile>();
	const entry = (
		type: DeployedResourceType,
		resource: ResourceFile | undefined,
		fields: Omit<DeployedResource, "type" | "file">,
	): DeployedResource => {
		if (resource) matched.add(resource);
		return {
			type,
			...fields,
			...(resource ? { file: toDeployFile(resource) } : {}),
		};
	};
	const str = (value: { toString(): string } | undefined | null) =>
		value?.toString() || undefined;

	const deployed: DeployedResource[] = [
		...response.processes.map((p) =>
			entry("process", byDefinitionId.get(p.processDefinitionId), {
				id: p.processDefinitionId,
				version: p.processDefinitionVersion,
				key: str(p.processDefinitionKey),
				resourceName: p.resourceName,
			}),
		),
		...response.decisions.map((d) =>
			entry("decision", byDefinitionId.get(d.decisionDefinitionId || ""), {
				id: d.decisionDefinitionId || undefined,
				version: d.version ?? undefined,
				key: str(d.decisionDefinitionKey),
				decisionRequirementsKey: str(d.decisionRequirementsKey),
			}),
		),
		...response.decisionRequirements.map((drd) =>
			entry("decision-requirements", takeByName(drd.resourceName), {
				id: drd.decisionRequirementsId || undefined,
				version: drd.version ?? undefined,
				key: str(drd.decisionRequirementsKey),
				resourceName: drd.resourceName || undefined,
			}),
		),
		...response.forms.map((form) =>
			entry("form", byFormId.get(form.formId || ""), {
				id: form.formId || undefined,
				version: form.version ?? undefined,
				key: str(form.formKey),
				resourceName: form.resourceName || undefined,
			}),
		),
		// Generic resources, returned by 8.10+.
		...response.resources.map((res) =>
			entry("resource", takeByName(res.resourceName), {
				id: res.resourceId || undefined,
				version: res.version ?? undefined,
				key: str(res.resourceKey),
				resourceName: res.resourceName || undefined,
			}),
		),
	];

	// Files deployed but not listed in any response array.
	for (const r of resources) {
		if (!matched.has(r)) {
			deployed.push({ type: "resource", file: toDeployFile(r) });
		}
	}
	return deployed;
}

/** A form's ID from its JSON, else its file name without extension. */
function formIdOf(resource: ResourceFile): string {
	try {
		const parsed: unknown = JSON.parse(resource.content.toString("utf-8"));
		if (isRecord(parsed) && typeof parsed.id === "string") {
			return parsed.id;
		}
	} catch {
		// Not valid JSON — use the file name.
	}
	return resource.name.replace(/\.form$/, "");
}

/**
 * Map a failed deployment request to a `C8ctlError`. The original error
 * stays the `cause`; `details.attempted` lists the files sent.
 */
function classifyDeploymentError(
	error: unknown,
	resources: ResourceFile[],
	resolvedPaths: string[],
): C8ctlError {
	const raw = isRecord(error) ? error : {};
	const problem = problemOf(error);
	const status = problem?.status;
	const title = problem?.title;
	const code = clusterErrorCode(error, "deployment-rejected");

	const message =
		status === 413
			? "Payload too large (HTTP 413)"
			: (title ??
				(error instanceof Error && error.message ? error.message : undefined) ??
				(typeof raw.message === "string" ? raw.message : undefined) ??
				"Deployment request failed");

	return new C8ctlError(code, message, {
		cause: error,
		...(problem ? { problem } : {}),
		details: {
			attempted: resources.map((r) => ({
				path: r.path,
				name: r.name,
				bytes: r.content.byteLength,
			})),
			resolvedPaths,
		},
	});
}
