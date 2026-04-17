/**
 * Unit tests for fetchAllPages pagination helper
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import {
	DEFAULT_MAX_ITEMS,
	fetchAllPages,
	type PagedResponse,
	type SearchConsistencyOpts,
} from "../../src/client.ts";

/** Build a properly shaped PagedResponse, filling missing fields with defaults. */
function makePage<T>(
	items: T[],
	overrides: Partial<PagedResponse<T>["page"]> = {},
): PagedResponse<T> {
	return {
		items,
		page: {
			totalItems: 0,
			startCursor: null,
			endCursor: null,
			hasMoreTotalItems: false,
			...overrides,
		},
	};
}

/** Helper: create a mock search function that returns `totalItems` items across pages. */
function createMockSearch(totalItems: number, pageSize: number) {
	const allItems = Array.from({ length: totalItems }, (_, i) => ({
		id: i + 1,
	}));
	let callCount = 0;

	const searchFn = async (
		filter: Record<string, unknown> & { page?: Record<string, unknown> },
		_opts: SearchConsistencyOpts,
	): Promise<PagedResponse<{ id: number }>> => {
		callCount++;
		const afterRaw = filter.page?.after;
		const after = typeof afterRaw === "number" ? afterRaw : undefined;
		const start = after ?? 0;
		const end = Math.min(start + pageSize, totalItems);
		const items = allItems.slice(start, end);
		const endCursor = end < totalItems ? String(end) : null;

		return makePage(items, {
			totalItems,
			startCursor: String(start),
			endCursor,
		});
	};

	// Expose a way to parse the `after` cursor back into a number
	const wrappedSearch = async (
		filter: Record<string, unknown> & { page?: Record<string, unknown> },
		opts: SearchConsistencyOpts,
	): Promise<PagedResponse<{ id: number }>> => {
		const parsedFilter = {
			...filter,
			page: {
				...filter.page,
				after:
					filter.page?.after !== undefined
						? Number(filter.page.after)
						: undefined,
			},
		};
		return searchFn(parsedFilter, opts);
	};

	return { search: wrappedSearch, getCallCount: () => callCount };
}

describe("fetchAllPages", () => {
	test("fetches all items across multiple pages", async () => {
		const { search } = createMockSearch(25, 10);

		const items = await fetchAllPages(search, {}, 10);

		assert.strictEqual(items.length, 25);
		assert.deepStrictEqual(items[0], { id: 1 });
		assert.deepStrictEqual(items[24], { id: 25 });
	});

	test("returns items from a single page when total fits", async () => {
		const { search, getCallCount } = createMockSearch(5, 100);

		const items = await fetchAllPages(search, {}, 100);

		assert.strictEqual(items.length, 5);
		assert.strictEqual(getCallCount(), 1, "should only call the API once");
	});

	test("returns empty array when no items exist", async () => {
		const { search } = createMockSearch(0, 10);

		const items = await fetchAllPages(search, {});

		assert.strictEqual(items.length, 0);
	});

	test("respects maxItems and truncates results", async () => {
		const { search } = createMockSearch(50, 10);

		const items = await fetchAllPages(search, {}, 10, 15);

		assert.strictEqual(items.length, 15, "should stop at maxItems");
		assert.deepStrictEqual(items[0], { id: 1 });
		assert.deepStrictEqual(items[14], { id: 15 });
	});

	test("maxItems of 1 returns only the first item", async () => {
		const { search } = createMockSearch(100, 10);

		const items = await fetchAllPages(search, {}, 10, 1);

		assert.strictEqual(items.length, 1);
		assert.deepStrictEqual(items[0], { id: 1 });
	});

	test("maxItems larger than total returns all items", async () => {
		const { search } = createMockSearch(10, 5);

		const items = await fetchAllPages(search, {}, 5, 9999);

		assert.strictEqual(
			items.length,
			10,
			"should return all items when maxItems > total",
		);
	});

	test("maxItems equal to total returns all items", async () => {
		const { search } = createMockSearch(20, 10);

		const items = await fetchAllPages(search, {}, 10, 20);

		assert.strictEqual(items.length, 20);
	});

	test("maxItems truncates mid-page", async () => {
		// 30 items, page size 10, limit 25 → gets 3 pages (30 items) then truncates to 25
		const { search } = createMockSearch(30, 10);

		const items = await fetchAllPages(search, {}, 10, 25);

		assert.strictEqual(
			items.length,
			25,
			"should truncate to maxItems even mid-page",
		);
	});

	test("stops when search returns duplicate cursor", async () => {
		let callCount = 0;
		const stuckSearch = async (
			_filter: Record<string, unknown>,
			_opts: SearchConsistencyOpts,
		): Promise<PagedResponse<{ id: number }>> => {
			callCount++;
			return makePage([{ id: callCount }], {
				totalItems: 999,
				endCursor: "same-cursor-forever",
			});
		};

		const items = await fetchAllPages(stuckSearch, {});

		// First call adds cursor, second call sees duplicate and breaks
		assert.strictEqual(callCount, 2);
		assert.strictEqual(items.length, 2);
	});

	test("stops when search returns no endCursor", async () => {
		let callCount = 0;
		const noCursorSearch = async (
			_filter: Record<string, unknown>,
			_opts: SearchConsistencyOpts,
		): Promise<PagedResponse<{ id: number }>> => {
			callCount++;
			return makePage([{ id: callCount }], {
				totalItems: 999,
				endCursor: null,
			});
		};

		const items = await fetchAllPages(noCursorSearch, {});

		assert.strictEqual(callCount, 1);
		assert.strictEqual(items.length, 1);
	});

	test("stops when search returns empty items", async () => {
		let callCount = 0;
		const emptySearch = async (
			_filter: Record<string, unknown>,
			_opts: SearchConsistencyOpts,
		): Promise<PagedResponse<{ id: number }>> => {
			callCount++;
			if (callCount === 1) {
				return makePage([{ id: 1 }], {
					totalItems: 10,
					endCursor: "cursor-1",
				});
			}
			return makePage<{ id: number }>([], {
				totalItems: 10,
				endCursor: "cursor-2",
			});
		};

		const items = await fetchAllPages(emptySearch, {});

		assert.strictEqual(items.length, 1);
	});

	test("passes filter through to search function", async () => {
		let receivedFilter:
			| (Record<string, unknown> & { page?: Record<string, unknown> })
			| undefined;
		const capturingSearch = async (
			filter: { filter: { state: string } } & {
				page?: Record<string, unknown>;
			},
			_opts: SearchConsistencyOpts,
		): Promise<PagedResponse<never>> => {
			receivedFilter = filter;
			return makePage<never>([]);
		};

		await fetchAllPages(capturingSearch, { filter: { state: "ACTIVE" } }, 50);

		assert.ok(receivedFilter, "search function should have been called");
		assert.deepStrictEqual(receivedFilter.filter, { state: "ACTIVE" });
		assert.strictEqual(receivedFilter.page?.limit, 50);
	});

	test("passes cursor in page.after on subsequent calls", async () => {
		const receivedFilters: Array<{
			page?: { after?: unknown; limit?: unknown };
		}> = [];
		let callCount = 0;
		const trackingSearch = async (
			filter: Record<string, unknown> & { page?: Record<string, unknown> },
			_opts: SearchConsistencyOpts,
		): Promise<PagedResponse<{ id: number }>> => {
			receivedFilters.push(JSON.parse(JSON.stringify(filter)));
			callCount++;
			if (callCount === 1) {
				return makePage([{ id: 1 }], {
					totalItems: 2,
					endCursor: "abc123",
				});
			}
			return makePage([{ id: 2 }], {
				totalItems: 2,
				endCursor: null,
			});
		};

		await fetchAllPages(trackingSearch, {});

		assert.strictEqual(receivedFilters.length, 2);
		assert.strictEqual(
			receivedFilters[0].page?.after,
			undefined,
			"first call should not have after",
		);
		assert.strictEqual(
			receivedFilters[1].page?.after,
			"abc123",
			"second call should have cursor",
		);
	});

	test("DEFAULT_MAX_ITEMS is 1000000", () => {
		assert.strictEqual(DEFAULT_MAX_ITEMS, 1_000_000);
	});

	test("handles BigInt totalItems from SDK Zod schema without throwing", async () => {
		// The Camunda 8 SDK uses z.coerce.bigint() for totalItems, so it returns BigInt at runtime.
		// fetchAllPages must convert it to number before comparing with allItems.length (a number).
		let callCount = 0;
		const bigintTotalItemsSearch = async (
			_filter: Record<string, unknown>,
			_opts: SearchConsistencyOpts,
		): Promise<PagedResponse<{ id: number }>> => {
			callCount++;
			return makePage([{ id: 1 }, { id: 2 }], {
				totalItems: 2n, // BigInt, as returned by the SDK
				endCursor: null,
			});
		};

		// Should NOT throw TypeError: Cannot mix BigInt and other types
		const items = await fetchAllPages(bigintTotalItemsSearch, {});

		assert.strictEqual(callCount, 1, "should only make one API call");
		assert.strictEqual(items.length, 2);
	});
});
