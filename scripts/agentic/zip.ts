import { createHash, timingSafeEqual } from "node:crypto";
import { inflateRawSync } from "node:zlib";

export const MAX_REPORT_BYTES = 1024 * 1024;
export const MAX_ARCHIVE_BYTES = 2 * MAX_REPORT_BYTES;

function requireZip(condition: boolean, reason: string): asserts condition {
	if (!condition) throw new Error(`Invalid report ZIP: ${reason}`);
}

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++)
			crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function validateExtra(extra: Buffer): void {
	for (let offset = 0; offset < extra.length; ) {
		requireZip(offset + 4 <= extra.length, "truncated extra field");
		const type = extra.readUInt16LE(offset);
		const size = extra.readUInt16LE(offset + 2);
		requireZip(type !== 1, "ZIP64 is not supported");
		offset += 4 + size;
		requireZip(offset <= extra.length, "truncated extra field");
	}
}

/** Read in memory; never extract or execute artifact paths. */
export function readReportArchive(bytes: Uint8Array, digest?: string): unknown {
	const zip = Buffer.from(bytes);
	requireZip(
		zip.length >= 22 && zip.length <= MAX_ARCHIVE_BYTES,
		"archive size limit",
	);
	if (digest !== undefined) {
		requireZip(/^sha256:[a-f0-9]{64}$/.test(digest), "unsupported digest");
		requireZip(
			timingSafeEqual(
				createHash("sha256").update(zip).digest(),
				Buffer.from(digest.slice(7), "hex"),
			),
			"digest mismatch",
		);
	}
	let end = zip.length - 22;
	for (; end >= Math.max(0, zip.length - 65557); end--) {
		if (
			zip.readUInt32LE(end) === 0x06054b50 &&
			end + 22 + zip.readUInt16LE(end + 20) === zip.length
		)
			break;
	}
	requireZip(
		end >= Math.max(0, zip.length - 65557) &&
			zip.readUInt32LE(end) === 0x06054b50 &&
			end + 22 + zip.readUInt16LE(end + 20) === zip.length,
		"missing end directory",
	);
	requireZip(
		zip.readUInt16LE(end + 4) === 0 && zip.readUInt16LE(end + 6) === 0,
		"multiple disks",
	);
	requireZip(
		zip.readUInt16LE(end + 8) === 1 && zip.readUInt16LE(end + 10) === 1,
		"expected exactly one entry",
	);
	const directorySize = zip.readUInt32LE(end + 12);
	const central = zip.readUInt32LE(end + 16);
	requireZip(
		central + directorySize === end &&
			directorySize >= 46 &&
			central + 46 <= end,
		"directory bounds or ZIP64",
	);
	requireZip(zip.readUInt32LE(central) === 0x02014b50, "central signature");
	const flags = zip.readUInt16LE(central + 8);
	const method = zip.readUInt16LE(central + 10);
	const checksum = zip.readUInt32LE(central + 16);
	const compressedSize = zip.readUInt32LE(central + 20);
	const size = zip.readUInt32LE(central + 24);
	const nameSize = zip.readUInt16LE(central + 28);
	const extraSize = zip.readUInt16LE(central + 30);
	const commentSize = zip.readUInt16LE(central + 32);
	const mode = zip.readUInt32LE(central + 38) >>> 16;
	requireZip(
		zip.readUInt16LE(central + 34) === 0 &&
			zip.readUInt32LE(central + 42) === 0,
		"disk or local entry offset",
	);
	requireZip(
		46 + nameSize + extraSize + commentSize === directorySize,
		"extra directory entries",
	);
	requireZip(
		size > 0 && size <= MAX_REPORT_BYTES && compressedSize <= MAX_ARCHIVE_BYTES,
		"report size limit",
	);
	requireZip(
		(flags & ~0x080e) === 0 && (method === 0 || method === 8),
		"encryption or compression method",
	);
	requireZip(
		(mode & 0o170000) === 0 || (mode & 0o170000) === 0o100000,
		"links or nonregular file",
	);
	const name = zip.subarray(central + 46, central + 46 + nameSize);
	requireZip(name.equals(Buffer.from("report.json")), "expected report.json");
	validateExtra(
		zip.subarray(central + 46 + nameSize, central + 46 + nameSize + extraSize),
	);
	requireZip(
		central >= 30 && zip.readUInt32LE(0) === 0x04034b50,
		"local signature",
	);
	requireZip(
		zip.readUInt16LE(6) === flags && zip.readUInt16LE(8) === method,
		"local metadata mismatch",
	);
	const localNameSize = zip.readUInt16LE(26);
	const localExtraSize = zip.readUInt16LE(28);
	const start = 30 + localNameSize + localExtraSize;
	requireZip(
		start <= central && zip.subarray(30, 30 + localNameSize).equals(name),
		"local name mismatch",
	);
	validateExtra(zip.subarray(30 + localNameSize, start));
	const finish = start + compressedSize;
	requireZip(finish <= central, "compressed size");
	if (flags & 8) {
		const descriptorSize = central - finish;
		requireZip(
			descriptorSize === 12 || descriptorSize === 16,
			"data descriptor size",
		);
		const descriptor = descriptorSize === 16 ? finish + 4 : finish;
		if (descriptorSize === 16)
			requireZip(
				zip.readUInt32LE(finish) === 0x08074b50,
				"descriptor signature",
			);
		requireZip(
			zip.readUInt32LE(descriptor) === checksum &&
				zip.readUInt32LE(descriptor + 4) === compressedSize &&
				zip.readUInt32LE(descriptor + 8) === size,
			"descriptor mismatch",
		);
	} else {
		requireZip(
			finish === central &&
				zip.readUInt32LE(14) === checksum &&
				zip.readUInt32LE(18) === compressedSize &&
				zip.readUInt32LE(22) === size,
			"local size or checksum mismatch",
		);
	}
	let plain: Buffer;
	try {
		plain =
			method === 0
				? zip.subarray(start, finish)
				: inflateRawSync(zip.subarray(start, finish), {
						maxOutputLength: MAX_REPORT_BYTES,
					});
	} catch {
		throw new Error(
			"Invalid report ZIP: decompression size limit or corrupt data",
		);
	}
	requireZip(
		plain.length === size && crc32(plain) === checksum,
		"report size or checksum mismatch",
	);
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain));
	} catch {
		throw new Error("Invalid report ZIP: report is not UTF-8 JSON");
	}
}
