import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { manualMergeReasons, parseChangeReport } from "./changes.ts";
import { parseCITask } from "./ci.ts";
import {
	isCommitSha,
	isIsoTimestamp,
	parseFitnessEnvelope,
	parseReviewEnvelope,
	parseWorkerTask,
	type WorkerKind,
} from "./contracts.ts";
import { type ConvergenceInput, decideConvergence } from "./convergence.ts";
import {
	array,
	GitHub,
	type GitHubClient,
	GitHubError,
	type InheritedFile,
	inspectCI,
	integer,
	object,
	observeWorker,
	prepareCommit,
	string,
	workerPath,
} from "./github.ts";
import { mergePullRequest } from "./merge.ts";
import {
	type CISlot,
	findState,
	fitnessOutcome,
	issueRevision,
	newState,
	pullRequestRevision,
	remediationState,
	renderState,
	type State,
	WORKER_KINDS,
} from "./state.ts";

export interface MergeRequest {
	github: GitHubClient;
	repository: string;
	number: number;
	headSha: string;
	baseSha: string;
	releaseIntent: "patch" | "minor";
	changeClass: "patch" | "additive-minor";
	appBotLogin: string;
	guard: () => Promise<void>;
	proof: ConvergenceInput;
	ciSlot: CISlot;
}
export interface ReconcileOptions {
	github: GitHubClient;
	repository: string;
	appBotLogin: string;
	enabled: boolean;
	autoMerge: boolean;
	since: string;
	now: string;
	number?: number;
	resumeActor?: string;
	merge?: (
		request: MergeRequest,
	) => Promise<{ merged: boolean; reason: string }>;
}
export interface ReconcileResult {
	number: number;
	phase: string;
	outcome: string;
}
class Paused extends Error {}
class PendingWrite extends Error {}

function held(issue: Record<string, unknown>) {
	return array(issue.labels).some(
		(label) =>
			(typeof label === "string" ? label : object(label).name) ===
			"agentic:hold",
	);
}
function sha(value: unknown): string {
	if (!isCommitSha(value)) throw new Error("Invalid GitHub revision");
	return value;
}
function diagnostic(issue: Record<string, unknown>, appBotLogin: string) {
	if (Object.hasOwn(issue, "pull_request")) return false;
	const author = object(issue.user);
	return (
		author.type === "Bot" &&
		[appBotLogin, "github-actions[bot]"].includes(string(author.login)) &&
		(/^\[?(?:gh-aw|agentic workflow)\]?(?:[ :/-]|$)/i.test(
			string(issue.title),
		) ||
			(typeof issue.body === "string" &&
				/<!-- (?:gh-aw|github-agentic-workflows)(?::| )/.test(issue.body)))
	);
}

/** One bounded reconciliation; YAML concurrency serializes all invocations. */
export async function reconcile(
	options: ReconcileOptions,
): Promise<ReconcileResult[]> {
	const { github, repository, appBotLogin, now, since } = options;
	if (options.enabled !== true) return [];
	if (
		!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
		!appBotLogin.endsWith("[bot]") ||
		appBotLogin === "github-actions[bot]" ||
		!isIsoTimestamp(now) ||
		!isIsoTimestamp(since)
	)
		throw new Error(
			"Enabled automation requires valid repository, App bot, since and current timestamp",
		);
	const root = `/repos/${repository}`;
	if (object(await github.request("GET", root)).default_branch !== "main")
		throw new Error("Coordinator is restricted to default branch main");
	if (options.resumeActor) {
		if (!options.number)
			throw new Error("Maintainer resume requires a subject number");
		const permission = object(
			await github.request(
				"GET",
				`${root}/collaborators/${encodeURIComponent(options.resumeActor)}/permission`,
			),
		).permission;
		if (!["admin", "maintain", "write"].includes(string(permission)))
			throw new Error("Maintainer resume permission denied");
	}
	let busy = 0;
	for (const status of ["queued", "in_progress"]) {
		const runs = (
			await github.list(
				`${root}/actions/runs?status=${status}`,
				"workflow_runs",
			)
		).map(object);
		busy += runs.filter(
			(run) =>
				WORKER_KINDS.some((kind) => run.path === workerPath(kind)) ||
				(run.path === ".github/workflows/test.yml" &&
					typeof run.display_title === "string" &&
					run.display_title.startsWith("c8ctl-ci-")),
		).length;
	}
	const subjects = options.number
		? [await github.request("GET", `${root}/issues/${integer(options.number)}`)]
		: await github.list(`${root}/issues?state=open`);
	const results: ReconcileResult[] = [];
	for (const subject of subjects) {
		let issue = object(subject);
		const number = integer(issue.number);
		if (issue.state !== "open" || diagnostic(issue, appBotLogin)) continue;
		let state: State | undefined;
		let commentId: number | undefined;
		let saved = "";
		let pr: Record<string, unknown> | undefined;
		const commentsPath = `${root}/issues/${number}/comments`;
		async function guard(allowClosed = false) {
			const toggle = object(
				await github.request(
					"GET",
					`${root}/actions/variables/C8CTL_AUTOMATION_ENABLED`,
				),
			);
			if (toggle.value !== "true")
				throw new Paused("Global automation kill switch is active");
			issue = object(await github.request("GET", `${root}/issues/${number}`));
			if (held(issue)) throw new Paused("Maintainer hold is active");
			if (issue.state !== "open" && !allowClosed)
				throw new Paused("Subject is no longer open");
		}
		async function confirmState() {
			if (commentId === undefined) return;
			const current = object(
				await github.request("GET", `${root}/issues/comments/${commentId}`),
			);
			if (
				current.body !== saved ||
				object(current.user).login !== appBotLogin ||
				object(current.user).type !== "Bot"
			)
				throw new Paused(
					"App state reservation changed; refusing to overwrite it",
				);
		}
		async function persist() {
			if (!state) throw new Error("Missing coordinator state");
			const body = renderState(state);
			if (body === saved) return;
			await confirmState();
			await guard(state.phase === "complete");
			if (commentId === undefined) {
				const created = object(
					await github.request("POST", commentsPath, { body }),
				);
				if (
					object(created.user).login !== appBotLogin ||
					object(created.user).type !== "Bot"
				)
					throw new Error("State write was not App-authored");
				commentId = integer(created.id);
			} else
				await github.request("PATCH", `${root}/issues/comments/${commentId}`, {
					body,
				});
			saved = body;
		}
		async function mainSha() {
			return sha(
				object(
					object(await github.request("GET", `${root}/git/ref/heads/main`))
						.object,
				).sha,
			);
		}
		async function publishStatus(
			status: "pending" | "success" | "failure",
			description: string,
		) {
			if (state?.subject !== "pr" || commentId === undefined) return;
			const context = "c8ctl/agentic";
			const targetUrl = `https://github.com/${repository}/pull/${number}#issuecomment-${commentId}`;
			const latest = (
				await github.list(`${root}/commits/${state.head_sha}/statuses`)
			)
				.map(object)
				.filter((item) => item.context === context)
				.sort((left, right) => integer(right.id) - integer(left.id))[0];
			if (
				latest &&
				latest.state === status &&
				latest.description === description &&
				latest.target_url === targetUrl &&
				object(latest.creator).login === appBotLogin &&
				object(latest.creator).type === "Bot"
			)
				return;
			await confirmState();
			const current = object(
				await github.request("GET", `${root}/pulls/${number}`),
			);
			if (
				object(current.head).sha !== state.head_sha ||
				object(current.base).sha !== state.base_sha
			)
				throw new Paused(
					"PR revision changed before aggregate status publication",
				);
			await guard();
			await github.request("POST", `${root}/statuses/${state.head_sha}`, {
				context,
				state: status,
				description,
				target_url: targetUrl,
			});
		}
		async function snapshot(checkWorkers = true) {
			if (!state) throw new Error("Missing state");
			await confirmState();
			const base = await mainSha();
			if (state.subject === "issue") {
				const comments = await github.list(commentsPath);
				const fresh = object(
					await github.request("GET", `${root}/issues/${number}`),
				);
				const revision = issueRevision(fresh, comments, appBotLogin, {
					hash: state.revision_hash,
					timestamp: state.issue_revision,
				});
				if (revision.hash !== state.revision_hash || base !== state.base_sha)
					throw new Error("Issue revision or main changed before write");
			} else {
				pr = object(await github.request("GET", `${root}/pulls/${number}`));
				if (
					pr.state !== "open" ||
					sha(object(pr.head).sha) !== state.head_sha ||
					sha(object(pr.base).sha) !== state.base_sha ||
					base !== state.base_sha ||
					pullRequestRevision(pr) !== state.revision_hash
				)
					throw new Error("PR head, base or intent changed before write");
			}
			for (const slot of Object.values(state.slots)) {
				if (!checkWorkers || slot.run_id === null) continue;
				const run = object(
					await github.request("GET", `${root}/actions/runs/${slot.run_id}`),
				);
				if (
					run.id !== slot.run_id ||
					run.run_attempt !== 1 ||
					run.path !== workerPath(slot.task.kind) ||
					run.event !== "workflow_dispatch" ||
					run.head_branch !== "main" ||
					object(run.actor).login !== appBotLogin ||
					object(run.actor).type !== "Bot" ||
					run.status !== "completed" ||
					run.conclusion !== "success"
				)
					throw new Error("Reserved worker run changed before mutation");
			}
			await guard();
		}
		async function dispatch(
			kinds: readonly WorkerKind[],
			instruction: string,
			attempt?: number,
		) {
			if (!state || commentId === undefined)
				throw new Error("Dispatch requires persisted App state");
			const missing = kinds.filter((kind) => !state?.slots[kind]);
			if (!missing.length) return;
			if (busy + missing.length > 6) {
				state.outcome = "Waiting for a global worker slot (maximum six)";
				await persist();
				return;
			}
			if (state.total_dispatches + missing.length > 20)
				throw new Error("Total dispatch budget exhausted");
			if (instruction.length > 20000)
				throw new Error("Accepted context exceeds worker instruction limit");
			for (const kind of missing) {
				const task = parseWorkerTask({
					version: 1,
					kind,
					repository,
					number,
					generation: state.generation,
					correlation: randomUUID(),
					head_sha: state.head_sha,
					base_sha: state.base_sha,
					issue_revision:
						kind === "fitness" || kind === "implement"
							? state.issue_revision
							: "",
					attempt: attempt ?? state.reimplementation_attempts,
					state_comment_id: commentId,
					instruction,
				});
				state.slots[kind] = {
					task,
					run_id: null,
					run_attempt: null,
					artifact_id: null,
					dispatched_at: now,
				};
			}
			state.total_dispatches += missing.length;
			if (attempt !== undefined) state.reimplementation_attempts = attempt;
			if (
				missing.some((kind) => kind === "implement" || kind === "reimplement")
			)
				state.phase = "implementing";
			await persist();
			for (const kind of missing) {
				const slot = state.slots[kind];
				if (!slot) throw new Error("Reservation disappeared");
				await snapshot(false);
				// Reserved first: an ambiguous failure is discovered, never retried.
				try {
					await github.request(
						"POST",
						`${root}/actions/workflows/${workerPath(kind).split("/").at(-1)}/dispatches`,
						{ ref: "main", inputs: { task: JSON.stringify(slot.task) } },
					);
				} catch (error) {
					if (error instanceof GitHubError && error.status < 500) throw error;
					state.outcome =
						"Worker dispatch response uncertain; discovering reserved correlation without redispatch";
					await persist();
				}
				busy++;
			}
		}
		async function dispatchCI() {
			if (!state || commentId === undefined || !pr)
				throw new Error("CI dispatch requires persisted PR state");
			if (state.ci) return;
			if (pr.mergeable === false)
				throw new Error(
					"Merge conflict requires maintainer resolution before immutable CI",
				);
			if (
				busy >= 6 ||
				pr.mergeable !== true ||
				!isCommitSha(pr.merge_commit_sha)
			) {
				state.outcome =
					"Waiting for an available CI slot and synthetic merge revision";
				await persist();
				return;
			}
			if (state.total_dispatches >= 20)
				throw new Error("Total dispatch budget exhausted");
			await snapshot(false);
			const task = parseCITask({
				version: 1,
				repository,
				number,
				generation: state.generation,
				correlation: randomUUID(),
				head_sha: state.head_sha,
				base_sha: state.base_sha,
				merge_sha: pr.merge_commit_sha,
				state_comment_id: commentId,
				attempt: state.reimplementation_attempts,
			});
			state.ci = {
				task,
				run_id: null,
				run_attempt: null,
				artifact_id: null,
				dispatched_at: now,
			};
			state.total_dispatches++;
			await persist();
			await snapshot(false);
			try {
				await github.request(
					"POST",
					`${root}/actions/workflows/test.yml/dispatches`,
					{
						ref: "main",
						inputs: { agentic_task: JSON.stringify(task) },
					},
				);
			} catch (error) {
				if (error instanceof GitHubError && error.status < 500) throw error;
				state.outcome =
					"Test dispatch response uncertain; discovering reserved correlation without redispatch";
				await persist();
			}
			busy++;
		}
		async function applyWorker(kind: "implement" | "reimplement") {
			if (!state) throw new Error("Missing state");
			const slot = state.slots[kind];
			if (!slot) throw new Error("Missing write-worker reservation");
			const observation = await observeWorker({
				github,
				repository,
				appBotLogin,
				slot,
			});
			if (observation.status === "waiting") {
				await persist();
				return;
			}
			const report = parseChangeReport(observation.envelope.report);
			await snapshot();
			const fork = pr && object(object(pr.head).repo).full_name !== repository;
			const inheritedFiles: InheritedFile[] = [];
			if (fork) {
				const listedFiles = (
					await github.list(`${root}/pulls/${number}/files`)
				).map(object);
				if (listedFiles.length !== integer(pr?.changed_files))
					throw new Error(
						"Cannot promote a fork with an incomplete original diff",
					);
				const comparison = object(
					await github.request(
						"GET",
						`${root}/compare/${slot.task.base_sha}...${slot.task.head_sha}`,
					),
				);
				const files = array(comparison.files).map(object);
				// Compare caps files at 300; hitting that cap cannot prove completeness.
				if (files.length >= 300 || files.length !== listedFiles.length)
					throw new Error(
						"Cannot prove complete immutable fork diff; forks with 300 or more changed files require manual handling",
					);
				const signatures = (items: Record<string, unknown>[]) =>
					items
						.map((file) =>
							JSON.stringify([
								file.filename,
								file.status,
								file.previous_filename ?? null,
							]),
						)
						.sort();
				if (
					JSON.stringify(signatures(files)) !==
					JSON.stringify(signatures(listedFiles))
				)
					throw new Error(
						"Mutable PR files disagree with the immutable fork diff",
					);
				const paths = files.flatMap((file) => [
					string(file.filename),
					...(file.previous_filename === undefined
						? []
						: [string(file.previous_filename)]),
				]);
				const reasons = manualMergeReasons(paths);
				if (reasons.length > 0)
					throw new Error(
						`Fork changes protected files; maintainer remediation required: ${reasons.slice(0, 3).join("; ")}`,
					);
				for (const file of files) {
					const status = string(file.status);
					if (
						![
							"added",
							"modified",
							"removed",
							"renamed",
							"copied",
							"changed",
							"unchanged",
						].includes(status) ||
						(status === "renamed" && file.previous_filename === undefined)
					)
						throw new Error(
							"Fork diff has an unsupported or incomplete file status",
						);
					const inherited = [
						{ path: string(file.filename), deleted: status === "removed" },
						...(file.previous_filename === undefined
							? []
							: [
									{
										path: string(file.previous_filename),
										deleted: status === "renamed",
									},
								]),
					];
					for (const source of inherited) {
						parseChangeReport({
							...report,
							files: [
								{ path: source.path, content: source.deleted ? null : "" },
							],
						});
						inheritedFiles.push(source);
					}
				}
			}
			const branch =
				state.subject === "issue" || fork
					? `agentic/${fork ? "remediation" : "issue"}-${number}-${state.generation}`
					: string(object(pr?.head).ref);
			const input = await prepareCommit({
				github,
				repository,
				branch,
				expectedHeadOid: slot.task.head_sha,
				report,
				reimplementation: kind === "reimplement",
				inheritedFiles,
			});
			if (state.subject === "issue" || fork) {
				state.write_branch = branch;
				await persist();
				let existing: string | undefined;
				try {
					existing = sha(
						object(
							object(
								await github.request(
									"GET",
									`${root}/git/ref/heads/${encodeURIComponent(branch)}`,
								),
							).object,
						).sha,
					);
				} catch (error) {
					if (!(error instanceof GitHubError && error.status === 404))
						throw error;
				}
				if (!existing) {
					if (state.pending_operation === "branch")
						throw new PendingWrite(
							"Awaiting reserved branch creation; no blind retry",
						);
					state.pending_operation = "branch";
					await persist();
					await snapshot();
					try {
						await github.request("POST", `${root}/git/refs`, {
							ref: `refs/heads/${branch}`,
							sha: slot.task.head_sha,
						});
					} catch (error) {
						if (error instanceof GitHubError && error.status < 500) throw error;
						throw new PendingWrite(
							"Branch creation response uncertain; discovering reserved branch",
						);
					}
				} else if (existing !== (state.written_sha ?? slot.task.head_sha))
					throw new Error(
						"Branch changed or a previous CAS outcome is ambiguous; maintainer required",
					);
				if (state.pending_operation === "branch") {
					state.pending_operation = null;
					await persist();
				}
			}
			if (!state.written_sha) {
				if (state.pending_operation === "commit")
					throw new Error(
						"Previous CAS outcome is ambiguous; maintainer required",
					);
				await snapshot();
				const branchInfo = object(
					await github.request(
						"GET",
						`${root}/branches/${encodeURIComponent(branch)}`,
					),
				);
				if (branchInfo.protected !== false)
					throw new Error("Refusing to write a protected or unknown branch");
				state.pending_operation = "commit";
				await persist();
				await snapshot();
				const result = await github.graphql(
					"mutation($input:CreateCommitOnBranchInput!){createCommitOnBranch(input:$input){commit{oid}}}",
					{ input },
				);
				state.written_sha = sha(
					object(object(result.createCommitOnBranch).commit).oid,
				);
				if (state.written_sha === slot.task.head_sha)
					throw new Error("Implementation made no progress");
				state.pending_operation = null;
				await persist();
			}
			if (state.subject === "pr" && !fork) {
				state.head_sha = state.written_sha;
				state.written_sha = null;
				state.slots = {};
				state.ci = null;
				state.phase = "reviewing";
				state.outcome =
					"New commit requires both independent reviews and fresh Test CI";
			} else {
				await snapshot();
				const candidates = (
					await github.list(
						`${root}/pulls?state=all&head=${encodeURIComponent(`${repository.split("/")[0]}:${branch}`)}&base=main`,
					)
				)
					.map(object)
					.filter(
						(candidate) =>
							object(candidate.head).ref === branch &&
							object(object(candidate.head).repo).full_name === repository &&
							object(candidate.base).ref === "main",
					);
				if (candidates.length > 1)
					throw new Error(
						"Multiple PRs claim the deterministic implementation branch",
					);
				let created = candidates[0];
				if (!created) {
					if (state.pending_operation === "pull-request")
						throw new PendingWrite(
							"Awaiting reserved PR creation; no blind retry",
						);
					state.pending_operation = "pull-request";
					await persist();
					await snapshot();
					try {
						created = object(
							await github.request("POST", `${root}/pulls`, {
								title: report.title,
								head: branch,
								base: "main",
								draft: false,
								body: `${report.summary}\n\n${report.evidence}\n\n${fork ? `Remediates #${number}; the original PR remains open for its author.` : `Closes #${number}`}`,
							}),
						);
					} catch (error) {
						if (error instanceof GitHubError && error.status < 500) throw error;
						throw new PendingWrite(
							"PR creation response uncertain; discovering exact deterministic branch",
						);
					}
				}
				if (
					created.state !== "open" ||
					object(created.head).sha !== state.written_sha
				)
					throw new Error("Recovered implementation PR is closed or changed");
				if (fork) {
					const childNumber = integer(created.number);
					const childPath = `${root}/issues/${childNumber}/comments`;
					const existing = findState(
						await github.list(childPath),
						appBotLogin,
						childNumber,
					);
					if (existing) {
						if (
							existing.state.subject !== "pr" ||
							existing.state.generation !== state.generation ||
							existing.state.deadline !== state.deadline ||
							existing.state.reimplementation_attempts <
								state.reimplementation_attempts ||
							existing.state.total_dispatches < state.total_dispatches
						)
							throw new Error(
								"Remediation state does not retain the parent session budget",
							);
					} else {
						const inherited = remediationState({
							source: state,
							number: childNumber,
							headSha: state.written_sha,
							baseSha: state.base_sha,
							now,
						});
						const childIssue = object(
							await github.request("GET", `${root}/issues/${childNumber}`),
						);
						if (childIssue.state !== "open" || held(childIssue))
							throw new Paused("Remediation PR is closed or held");
						await snapshot();
						const childComment = object(
							await github.request("POST", childPath, {
								body: renderState(inherited),
							}),
						);
						if (
							object(childComment.user).login !== appBotLogin ||
							object(childComment.user).type !== "Bot"
						)
							throw new Error("Remediation state was not App-authored");
					}
				}
				state.implemented_pr = integer(created.number);
				state.pending_operation = null;
				state.related_prs = [
					...new Set([...state.related_prs, state.implemented_pr]),
				];
				state.phase = fork ? "human" : "complete";
				state.outcome = `${fork ? "Linked fork remediation" : "Implementation"} PR #${state.implemented_pr}; independent PR convergence is required`;
			}
			await persist();
		}
		try {
			if (held(issue)) {
				results.push({
					number,
					phase: "blocked",
					outcome: "Maintainer hold is active; no mutations",
				});
				continue;
			}
			const comments = await github.list(commentsPath);
			const tracked = findState(comments, appBotLogin, number);
			if (
				!tracked &&
				!options.resumeActor &&
				(!isIsoTimestamp(issue.created_at) ||
					Date.parse(issue.created_at) < Date.parse(since))
			)
				continue;
			if (tracked) {
				state = tracked.state;
				commentId = tracked.id;
				saved = renderState(state);
			}
			if (
				state?.implemented_pr !== null &&
				state?.implemented_pr !== undefined &&
				(!options.resumeActor ||
					object(
						await github.request(
							"GET",
							`${root}/pulls/${state.implemented_pr}`,
						),
					).state === "open")
			) {
				results.push({ number, phase: state.phase, outcome: state.outcome });
				continue;
			}
			if (state?.phase === "complete" && !options.resumeActor) {
				results.push({ number, phase: state.phase, outcome: state.outcome });
				continue;
			}
			const base = await mainSha();
			const subjectKind = Object.hasOwn(issue, "pull_request") ? "pr" : "issue";
			if (state && state.subject !== subjectKind)
				throw new Error("Stored subject type mismatch");
			if (subjectKind === "pr")
				pr = object(await github.request("GET", `${root}/pulls/${number}`));
			const head = pr ? sha(object(pr.head).sha) : base;
			const prRevision = pr ? pullRequestRevision(pr) : undefined;
			const revision =
				subjectKind === "issue"
					? issueRevision(
							issue,
							comments,
							appBotLogin,
							state
								? { hash: state.revision_hash, timestamp: state.issue_revision }
								: undefined,
						)
					: undefined;
			if (!state && !options.resumeActor && pr) {
				const branch = string(object(pr.head).ref);
				const sourceIdentity =
					/^agentic\/remediation-([1-9]\d*)-([A-Za-z0-9_-]{16,128})$/.exec(
						branch,
					);
				if (sourceIdentity) {
					const sourceNumber = integer(Number(sourceIdentity[1]));
					const source = findState(
						await github.list(`${root}/issues/${sourceNumber}/comments`),
						appBotLogin,
						sourceNumber,
					)?.state;
					if (
						!source ||
						source.generation !== sourceIdentity[2] ||
						object(object(pr.head).repo).full_name !== repository
					)
						throw new Error("Remediation branch has no trusted parent session");
					state = remediationState({
						source,
						number,
						headSha: head,
						baseSha: base,
						now,
					});
				}
			}
			if (!state || options.resumeActor)
				state = newState({
					subject: subjectKind,
					number,
					headSha: head,
					baseSha: base,
					now,
					issueRevision: revision?.timestamp,
					revisionHash: revision?.hash ?? prRevision,
				});
			if (Date.parse(now) >= Date.parse(state.deadline))
				throw new Error(
					"Two-hour session deadline reached; maintainer resume required",
				);
			if (state.implemented_pr !== null || state.phase === "complete") {
				results.push({ number, phase: state.phase, outcome: state.outcome });
				continue;
			}
			if (
				revision &&
				(revision.hash !== state.revision_hash ||
					(base !== state.base_sha &&
						/^(already_implemented|in_progress):/.test(state.outcome)))
			) {
				if (state.written_sha || state.pending_operation)
					throw new Error(
						"Issue scope changed after a write was reserved; maintainer reconciliation required",
					);
				state.issue_revision = revision.timestamp;
				state.revision_hash = revision.hash;
				state.head_sha = base;
				state.base_sha = base;
				state.slots = {};
				state.ci = null;
				state.phase = "fitness";
			}
			if (
				state.subject === "issue" &&
				state.phase === "human" &&
				state.outcome.startsWith("in_progress:")
			) {
				const linked = await Promise.all(
					state.related_prs.map((related) =>
						github.request("GET", `${root}/pulls/${related}`),
					),
				);
				if (
					linked.length > 0 &&
					linked.every((item) => object(item).state === "closed")
				) {
					state.slots = {};
					state.ci = null;
					state.phase = "fitness";
					state.head_sha = base;
					state.base_sha = base;
				}
			}
			const terminal = state.phase === "blocked" || state.phase === "human";
			if (
				(head !== state.head_sha ||
					base !== state.base_sha ||
					(prRevision !== undefined && prRevision !== state.revision_hash)) &&
				(state.subject === "pr" || !terminal)
			) {
				if (state.pending_operation || state.written_sha)
					throw new Error(
						"Revision changed with a pending or recorded write; maintainer reconciliation required",
					);
				const writeSlot = state.slots.reimplement ?? state.slots.implement;
				if (writeSlot) {
					if (writeSlot.run_id === null) {
						try {
							await observeWorker({
								github,
								repository,
								appBotLogin,
								slot: writeSlot,
							});
						} catch {
							/* Only a positively completed run may be superseded below. */
						}
					}
					if (writeSlot.run_id === null)
						throw new Error(
							"Revision changed while the reserved write worker is unresolved",
						);
					const run = object(
						await github.request(
							"GET",
							`${root}/actions/runs/${writeSlot.run_id}`,
						),
					);
					if (run.id !== writeSlot.run_id || run.status !== "completed")
						throw new Error(
							"Revision changed while the write worker is still in flight",
						);
				} else if (state.phase === "implementing") {
					throw new Error(
						"Implementation reservation is missing; maintainer reconciliation required",
					);
				}
				state.head_sha = head;
				state.base_sha = base;
				if (prRevision !== undefined) state.revision_hash = prRevision;
				state.slots = {};
				state.ci = null;
				state.phase = state.subject === "issue" ? "fitness" : "reviewing";
				state.outcome =
					"Revision changed; awaiting fresh evidence without resetting the session budget";
			}
			if (state.phase === "blocked" || state.phase === "human") {
				results.push({ number, phase: state.phase, outcome: state.outcome });
				continue;
			}
			await persist();
			if (state.subject === "issue") {
				if (state.phase === "implementing") await applyWorker("implement");
				else {
					const slot = state.slots.fitness;
					if (!slot)
						await dispatch(
							["fitness"],
							`Assess issue #${number} against exact main ${base}. Read the issue, relevant comments, existing PRs, tests, docs and SDK gaps. Only clearly specified missing scope is ready.`,
						);
					else {
						const observation = await observeWorker({
							github,
							repository,
							appBotLogin,
							slot,
						});
						if (observation.status === "completed") {
							const report = parseFitnessEnvelope(observation.envelope).report;
							state.related_prs = [...report.related_prs];
							state.outcome = fitnessOutcome({
								state,
								report,
								artifactId: slot.artifact_id,
							});
							if (report.decision === "ready") {
								await snapshot();
								await dispatch(
									["implement"],
									`Implement only accepted missing scope for issue #${number}. Recheck issue revision and main. Fitness run ${slot.run_id}, artifact ${slot.artifact_id}. ${JSON.stringify(report)}`,
								);
								if (state.slots.implement) state.phase = "implementing";
							} else state.phase = "human";
						}
						await persist();
					}
				}
			} else if (state.phase === "implementing")
				await applyWorker("reimplement");
			else {
				if (
					pr?.draft !== false ||
					object(pr.base).ref !== "main" ||
					typeof issue.body !== "string" ||
					!issue.body.trim()
				)
					throw new Error(
						"PR must be non-draft, target main and describe testable intent",
					);
				await dispatch(
					["review-copilot", "review-claude"],
					`Independently review the full diff of PR #${number} at head ${head} against main ${base}. Do not read peer reports before submitting your own report. Require testable intent, preserved existing behavior, regression evidence and safe patch/additive classification. Never infer eligibility from title or author.`,
				);
				await dispatchCI();
				const copilotSlot = state.slots["review-copilot"],
					claudeSlot = state.slots["review-claude"];
				if (copilotSlot && claudeSlot) {
					const copilot = await observeWorker({
						github,
						repository,
						appBotLogin,
						slot: copilotSlot,
					});
					const claude = await observeWorker({
						github,
						repository,
						appBotLogin,
						slot: claudeSlot,
					});
					const ci = await inspectCI({
						github,
						repository,
						number,
						headSha: head,
						baseSha: base,
						mergeSha:
							pr.mergeable === true && isCommitSha(pr.merge_commit_sha)
								? pr.merge_commit_sha
								: null,
						ci: state.ci,
						appBotLogin,
					});
					const proof: ConvergenceInput = {
						snapshot: { head_sha: head, base_sha: base },
						state: { ...state, phase: "reviewing" },
						expected: { copilot: copilotSlot.task, claude: claudeSlot.task },
						now,
						ci: ci.status,
						reviews: {
							copilot:
								copilot.status === "waiting"
									? copilot
									: {
											status: "completed",
											envelope: parseReviewEnvelope(copilot.envelope),
										},
							claude:
								claude.status === "waiting"
									? claude
									: {
											status: "completed",
											envelope: parseReviewEnvelope(claude.envelope),
										},
						},
					};
					const decision = decideConvergence(proof);
					if (decision.action === "reimplement") {
						await publishStatus(
							"pending",
							"Reimplementation is required before fresh independent reviews and CI",
						);
						const reports = [copilot, claude].map((result) =>
							result.status === "completed" ? result.envelope.report : null,
						);
						await dispatch(
							["reimplement"],
							`Fix PR #${number} against both reports and CI. Add regression tests, no unrelated refactoring. CI: ${ci.evidence}. Full report artifacts: ${copilotSlot.artifact_id}, ${claudeSlot.artifact_id}. Reports: ${JSON.stringify(reports)}`,
							decision.next_attempt,
						);
						if (state.slots.reimplement) state.phase = "implementing";
					} else if (
						decision.action === "block" ||
						decision.action === "human"
					) {
						state.phase = decision.action === "block" ? "blocked" : "human";
						state.outcome = decision.reason;
						const cleanManualEvidence =
							decision.action === "human" &&
							ci.status === "success" &&
							[proof.reviews.copilot, proof.reviews.claude].every(
								(review) =>
									review?.status === "completed" &&
									review.envelope.report.status === "complete" &&
									review.envelope.report.findings.length === 0 &&
									review.envelope.report.blockers.length === 0,
							);
						if (cleanManualEvidence) {
							await persist();
							await snapshot();
						}
						await publishStatus(
							cleanManualEvidence ? "success" : "failure",
							cleanManualEvidence
								? "Reviews and Test CI are clean; human decision and manual merge policy required"
								: "Convergence needs human attention; see App state for details",
						);
					} else if (decision.action === "eligible") {
						await persist();
						await snapshot();
						await publishStatus(
							"success",
							"Independent reviews and Test CI are clean; separate merge policy gates still apply",
						);
						if (!options.autoMerge) {
							state.phase = "human";
							state.outcome =
								"Both reviews and Test CI are clean; auto-merge is disabled";
						} else if (!options.merge) {
							state.phase = "human";
							state.outcome =
								"Both reviews and Test CI are clean; trusted merge authorization is not configured";
						} else {
							if (!state.ci)
								throw new Error("Missing immutable CI reservation");
							const result = await options.merge({
								github,
								repository,
								number,
								headSha: head,
								baseSha: base,
								releaseIntent: decision.release_intent,
								changeClass:
									decision.release_intent === "patch"
										? "patch"
										: "additive-minor",
								appBotLogin,
								guard: snapshot,
								proof,
								ciSlot: state.ci,
							});
							state.phase = result.merged ? "complete" : "human";
							state.outcome = result.reason;
						}
					} else if (decision.action === "wait")
						await publishStatus(
							"pending",
							"Awaiting independent reviews and Test CI",
						);
					await persist();
				}
			}
			results.push({ number, phase: state.phase, outcome: state.outcome });
		} catch (error) {
			const outcome =
				error instanceof Error
					? error.message.slice(0, 1000)
					: "Unknown coordinator failure";
			if (!(error instanceof Paused) && state && commentId !== undefined) {
				if (!(error instanceof PendingWrite)) state.phase = "blocked";
				state.outcome = outcome;
				try {
					await persist();
					if (!(error instanceof PendingWrite))
						await publishStatus(
							"failure",
							"Convergence is blocked; see App state for details",
						);
				} catch {
					/* Kill switches and ambiguous writes are not retried. */
				}
			}
			results.push({
				number,
				phase: error instanceof PendingWrite ? "waiting" : "blocked",
				outcome,
			});
		}
	}
	return results;
}

export function automationSwitches(environment: NodeJS.ProcessEnv) {
	return {
		enabled: environment.C8CTL_AUTOMATION_ENABLED === "true",
		autoMerge: environment.C8CTL_AUTO_MERGE_ENABLED === "true",
	};
}

export function coordinatorFailureReason(error: unknown): string {
	if (
		error instanceof GitHubError &&
		Number.isInteger(error.status) &&
		error.status >= 100 &&
		error.status <= 599
	)
		return `GitHub API request failed (HTTP ${error.status})`;
	if (error instanceof SyntaxError) return "GitHub event JSON is malformed";
	if (error instanceof Error) {
		if (error.message === "Expected JSON string")
			return "Required coordinator environment value is missing or invalid; check GH_TOKEN, GITHUB_* and C8CTL_* settings";
		if (
			error.message === "Expected JSON object" ||
			error.message === "Expected JSON array"
		)
			return "GitHub event or API metadata has an unexpected JSON shape";
		if (error.message === "Expected positive integer")
			return "The subject number or GitHub metadata identifier is invalid";
		if (error.message === "Invalid URL") return "Invalid GitHub API origin";
		if ("code" in error && error.code === "ENOENT")
			return "GitHub event file could not be found";
		if ("code" in error && error.code === "EACCES")
			return "GitHub event file is not readable";
		const safeReasons = [
			"Enabled automation requires valid repository, App bot, since and current timestamp",
			"Coordinator is restricted to default branch main",
			"Coordinator may run only on trusted default ref",
			"Maintainer resume requires a subject number",
			"Maintainer resume requires a subject number and actor",
			"Maintainer resume permission denied",
			"Unsupported coordinator command",
			"Invalid subject number",
			"Invalid GitHub API origin",
			"Missing GitHub token",
			"GitHub transport failed",
			"GitHub returned invalid JSON",
			"GitHub returned invalid or oversized JSON",
			"GitHub response exceeds size limit",
		];
		if (safeReasons.includes(error.message)) return error.message;
	}
	return "Unexpected coordinator failure; inspect configuration and App permissions";
}

export function eventRequest(input: {
	event: unknown;
	eventName: string;
	actor: string;
}) {
	const event = object(input.event);
	const manual = input.eventName === "workflow_dispatch";
	const inputs =
		manual && event.inputs !== undefined ? object(event.inputs) : {};
	const command = inputs.command ?? "reconcile";
	if (command !== "reconcile" && command !== "resume")
		throw new Error("Unsupported coordinator command");
	const requested = inputs.number;
	const subject = event.issue ?? event.pull_request;
	let number: number | undefined;
	if (requested !== undefined && requested !== "") {
		if (
			typeof requested !== "number" &&
			(typeof requested !== "string" || !/^[1-9]\d*$/.test(requested))
		)
			throw new Error("Invalid subject number");
		number = integer(Number(requested));
	} else if (subject !== undefined) number = integer(object(subject).number);
	if (command === "resume" && (!number || !input.actor))
		throw new Error("Maintainer resume requires a subject number and actor");
	return {
		number,
		resumeActor: command === "resume" ? input.actor : undefined,
	};
}

async function main() {
	const switches = automationSwitches(process.env);
	if (!switches.enabled) return;
	if (process.env.GITHUB_REF !== "refs/heads/main")
		throw new Error("Coordinator may run only on trusted default ref");
	const event = object(
		JSON.parse(await readFile(string(process.env.GITHUB_EVENT_PATH), "utf8")),
	);
	const request = eventRequest({
		event,
		eventName: string(process.env.GITHUB_EVENT_NAME),
		actor: process.env.GITHUB_ACTOR ?? "",
	});
	const result = await reconcile({
		github: new GitHub({
			token: string(process.env.GH_TOKEN),
			apiUrl: process.env.GITHUB_API_URL,
		}),
		repository: string(process.env.GITHUB_REPOSITORY),
		appBotLogin: string(process.env.C8CTL_APP_BOT_LOGIN),
		enabled: true,
		autoMerge: switches.autoMerge,
		merge: mergePullRequest,
		since: string(process.env.C8CTL_AUTOMATION_SINCE),
		now: new Date().toISOString(),
		...request,
	});
	console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	main().catch((error: unknown) => {
		console.error(
			`Agentic coordinator failed closed: ${coordinatorFailureReason(error)}`,
		);
		process.exitCode = 1;
	});
