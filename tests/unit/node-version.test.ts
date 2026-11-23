import assert from "node:assert";
import { describe, test } from "node:test";
import {
	describeUnsupportedNode,
	REQUIRED_NODE_RANGE,
} from "../../src/core/index.ts";

describe("Node.js version guard", () => {
	test("reads the required range from engines.node", () => {
		assert.ok(REQUIRED_NODE_RANGE, "engines.node should be readable");
		assert.strictEqual(
			describeUnsupportedNode({ range: REQUIRED_NODE_RANGE }),
			null,
			"the Node.js running the tests should satisfy engines.node",
		);
	});

	test("accepts versions in range", () => {
		assert.strictEqual(
			describeUnsupportedNode({ version: "22.18.0", range: ">=22.18.0" }),
			null,
		);
	});

	test("describes versions outside the range", () => {
		const message = describeUnsupportedNode({
			version: "22.17.1",
			range: ">=22.18.0",
		});
		assert.match(
			String(message),
			/Node\.js 22\.17\.1 is not supported; c8ctl needs >=22\.18\.0/,
		);
	});

	test("concludes nothing from an unknown or invalid range", () => {
		assert.strictEqual(
			describeUnsupportedNode({ version: "18.0.0", range: "" }),
			null,
		);
		assert.strictEqual(
			describeUnsupportedNode({ version: "18.0.0", range: "not a range" }),
			null,
		);
	});
});
