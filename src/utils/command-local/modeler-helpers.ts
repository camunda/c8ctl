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
