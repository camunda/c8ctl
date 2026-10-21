import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { readReportArchive } from "../../scripts/agentic/zip.ts";

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++)
			crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function archive(content: string, name = "report.json", mode = 0o100644) {
	const plain = Buffer.from(content);
	const compressed = deflateRawSync(plain);
	const filename = Buffer.from(name);
	const local = Buffer.alloc(30);
	local.writeUInt32LE(0x04034b50);
	local.writeUInt16LE(20, 4);
	local.writeUInt16LE(8, 8);
	local.writeUInt32LE(crc32(plain), 14);
	local.writeUInt32LE(compressed.length, 18);
	local.writeUInt32LE(plain.length, 22);
	local.writeUInt16LE(filename.length, 26);
	const central = Buffer.alloc(46);
	central.writeUInt32LE(0x02014b50);
	central.writeUInt16LE(0x0314, 4);
	central.writeUInt16LE(20, 6);
	central.writeUInt16LE(8, 10);
	central.writeUInt32LE(crc32(plain), 16);
	central.writeUInt32LE(compressed.length, 20);
	central.writeUInt32LE(plain.length, 24);
	central.writeUInt16LE(filename.length, 28);
	central.writeUInt32LE((mode << 16) >>> 0, 38);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50);
	end.writeUInt16LE(1, 8);
	end.writeUInt16LE(1, 10);
	end.writeUInt32LE(central.length + filename.length, 12);
	end.writeUInt32LE(local.length + filename.length + compressed.length, 16);
	return Buffer.concat([local, filename, compressed, central, filename, end]);
}

test("reads only one bounded report.json and verifies API SHA256 digest", () => {
	const zip = archive('{"schema_version":1}');
	const digest = `sha256:${createHash("sha256").update(zip).digest("hex")}`;
	assert.deepEqual(readReportArchive(zip, digest), { schema_version: 1 });
	assert.throws(
		() => readReportArchive(zip, `sha256:${"0".repeat(64)}`),
		/digest/,
	);
});

test("rejects traversal, links, duplicate entries, encryption, ZIP64 and corruption", () => {
	for (const zip of [
		archive("{}", "../report.json"),
		archive("{}", "report.json", 0o120777),
		archive("{}", "/report.json"),
		archive("{}", "REPORT.JSON"),
	])
		assert.throws(() => readReportArchive(zip));
	for (const mutate of [
		(zip: Buffer) => zip.writeUInt16LE(2, zip.length - 12),
		(zip: Buffer) => zip.writeUInt16LE(1, 6),
		(zip: Buffer) => zip.writeUInt32LE(0xffffffff, zip.length - 6),
		(zip: Buffer) => zip.writeUInt32LE(0, 14),
	]) {
		const zip = archive("{}");
		mutate(zip);
		assert.throws(() => readReportArchive(zip));
	}
	assert.throws(() => readReportArchive(Buffer.from("not zip")));
	assert.throws(() =>
		readReportArchive(Buffer.concat([archive("{}"), Buffer.alloc(65536)])),
	);
});

test("rejects oversized reports even when the central directory lies", () => {
	const zip = archive(`"${"a".repeat(1024 * 1024)}"`);
	assert.throws(() => readReportArchive(zip), /size|large|limit/i);
	const central = zip.readUInt32LE(zip.length - 6);
	zip.writeUInt32LE(2, central + 24);
	zip.writeUInt32LE(2, 22);
	assert.throws(() => readReportArchive(zip), /size|large|limit/i);
});
