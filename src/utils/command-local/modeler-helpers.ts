import { parse, rcompare } from "semver";

export const MODELER_RELEASE_URL =
	"https://downloads.camunda.cloud/release/camunda-modeler/";

export function latestStableModelerVersion(indexHtml: string): string {
	const versions = Array.from(
		indexHtml.matchAll(/href=["']([^/"']+)\/["']/g),
		(match) => match[1],
	).filter((version): version is string => version !== undefined);
	const latest = versions
		.filter((version) => {
			const parsed = parse(version);
			return parsed !== null && parsed.prerelease.length === 0;
		})
		.sort(rcompare)[0];

	if (!latest) {
		throw new Error(
			`No stable Camunda Modeler release found. Download manually from ${MODELER_RELEASE_URL}`,
		);
	}

	return latest;
}

export function modelerMacArchiveName(
	version: string,
	architecture: string,
): string {
	if (architecture !== "arm64" && architecture !== "x64") {
		throw new Error(
			`Unsupported macOS architecture "${architecture}". Download Camunda Modeler manually from ${MODELER_RELEASE_URL}`,
		);
	}

	return `camunda-modeler-${version}-mac-${architecture}.zip`;
}

const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const MAX_BAR_WIDTH = 40;
const MIN_BAR_WIDTH = 10;
// Room for the widest text, e.g. "100%  148.4/148.4 MB  999.9 MB/s  eta 999:59",
// so the bar keeps its width while the numbers change.
const INFO_WIDTH = 44;
// A rate measured over a shorter time is noise (e.g. "eta 1189:46").
const MIN_RATE_SAMPLE_MS = 1_000;

function megabytes(bytes: number): string {
	return (bytes / 1_048_576).toFixed(1);
}

/**
 * Render one download progress frame that stays shorter than the terminal
 * width, so redrawing it with a carriage return never wraps onto new lines.
 */
export function renderDownloadProgress({
	received,
	total,
	elapsedMs,
	columns,
	color,
}: {
	received: number;
	total: number;
	elapsedMs: number;
	columns: number;
	color: boolean;
}): string {
	const rate =
		elapsedMs >= MIN_RATE_SAMPLE_MS ? (received * 1000) / elapsedMs : 0;
	const speed =
		elapsedMs >= MIN_RATE_SAMPLE_MS ? [`${megabytes(rate)} MB/s`] : [];
	if (total <= 0) {
		const spinner = SPINNER[Math.floor(elapsedMs / 100) % SPINNER.length];
		return [`${spinner} ${megabytes(received)} MB`, ...speed]
			.join("  ")
			.slice(0, columns - 1);
	}

	const fraction = Math.min(1, received / total);
	const etaSeconds =
		fraction < 1 && rate > 0 ? Math.ceil((total - received) / rate) : undefined;
	const info = [
		`${Math.floor(fraction * 100)}%`.padStart(4),
		`${megabytes(received)}/${megabytes(total)} MB`,
		...speed,
		...(etaSeconds === undefined
			? []
			: [
					`eta ${Math.floor(etaSeconds / 60)}:${String(etaSeconds % 60).padStart(2, "0")}`,
				]),
	].join("  ");

	const width = Math.min(MAX_BAR_WIDTH, columns - INFO_WIDTH - 2);
	if (width < MIN_BAR_WIDTH) return info.slice(0, columns - 1);

	const filled = Math.floor(fraction * width);
	const bar = color
		? `\u001b[36m${"━".repeat(filled)}\u001b[90m${"━".repeat(width - filled)}\u001b[0m`
		: `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
	return `${bar} ${info.slice(0, columns - width - 2)}`;
}
