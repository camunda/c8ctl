/** Read template JSON entries from an npm tarball. */

import { gunzipSync } from "node:zlib";

const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const TAR_BLOCK_SIZE = 512;

export type TarEntry = { name: string; content: string };

/** Read a NUL-padded fixed-width tar header field. */
function readTarString(tar: Buffer, offset: number, length: number): string {
	const raw = tar.toString("utf-8", offset, offset + length);
	const nul = raw.indexOf("\0");
	return nul === -1 ? raw : raw.slice(0, nul);
}

/**
 * Extract every `*.json` file from a gzipped ustar archive.
 *
 * Directory entries, long-name extensions and other non-regular
 * entries are skipped rather than failing the whole archive.
 */
export function extractJsonEntries(gzipped: Uint8Array): TarEntry[] {
	const tar = gunzipSync(gzipped, { maxOutputLength: MAX_ARCHIVE_BYTES });
	const entries: TarEntry[] = [];
	let offset = 0;
	while (offset + TAR_BLOCK_SIZE <= tar.length) {
		// Two consecutive zero blocks mark the end of the archive; a
		// single one is enough for us to stop reading.
		if (tar.subarray(offset, offset + TAR_BLOCK_SIZE).every((b) => b === 0)) {
			break;
		}
		const name = readTarString(tar, offset, 100);
		const prefix = readTarString(tar, offset + 345, 155);
		const sizeField = readTarString(tar, offset + 124, 12).trim();
		const size = Number.parseInt(sizeField, 8);
		if (!Number.isFinite(size) || size < 0) {
			throw new Error(
				`Malformed tar header (bad size field) at byte ${offset}`,
			);
		}
		const typeFlag = String.fromCharCode(tar[offset + 156]);
		const dataStart = offset + TAR_BLOCK_SIZE;
		const dataEnd = dataStart + size;
		if (dataEnd > tar.length) {
			throw new Error(`Truncated tar entry '${name}' at byte ${offset}`);
		}
		const fullName = prefix ? `${prefix}/${name}` : name;
		// '0' and '\0' are the two encodings of "regular file".
		if ((typeFlag === "0" || typeFlag === "\0") && fullName.endsWith(".json")) {
			entries.push({
				name: fullName,
				content: tar.toString("utf-8", dataStart, dataEnd),
			});
		}
		offset = dataStart + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
	}
	return entries;
}
