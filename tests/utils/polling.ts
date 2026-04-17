/**
 * Test utilities for polling operations
 * Provides generic polling functionality for waiting on asynchronous operations in tests
 */

// Enable debug logging when DEBUG environment variable is set
const DEBUG = process.env.DEBUG === "true" || process.env.DEBUG === "1";

/**
 * Poll for a condition to become true with configurable interval and timeout
 *
 * @param checkCondition - Async function that returns true when condition is met
 * @param maxDuration - Maximum time to poll in milliseconds
 * @param interval - Polling interval in milliseconds
 * @returns Promise<boolean> - true if condition was met, false if timeout
 *
 * @example
 * ```typescript
 * const found = await pollUntil(
 *   async () => {
 *     const result = await client.searchProcessInstances({ filter: { ... } });
 *     return result.items && result.items.length > 0;
 *   },
 *   10000,  // max 10 seconds
 *   200     // check every 200ms
 * );
 * assert.ok(found, 'Condition should be met within timeout');
 * ```
 *
 * @remarks
 * Enable debug logging by setting the DEBUG environment variable:
 * DEBUG=true npm test
 */
export async function pollUntil(
	checkCondition: () => Promise<boolean>,
	maxDuration: number,
	interval: number,
): Promise<boolean> {
	const deadline = Date.now() + maxDuration;
	const maxAttempts = Math.ceil(maxDuration / interval);
	let attempt = 0;

	DEBUG &&
		console.debug(
			`[Polling] Starting poll - max duration: ${maxDuration}ms, interval: ${interval}ms, max attempts: ${maxAttempts}`,
		);

	while (Date.now() < deadline) {
		attempt++;
		const elapsedTime = Date.now() - (deadline - maxDuration);

		DEBUG &&
			console.debug(
				`[Polling] Attempt ${attempt}/${maxAttempts} (${elapsedTime}ms elapsed)`,
			);

		try {
			if (await checkCondition()) {
				DEBUG &&
					console.debug(
						`[Polling] ✓ Condition met after ${attempt} attempts (${elapsedTime}ms elapsed)`,
					);
				return true;
			}
			DEBUG && console.debug(`[Polling] Condition not yet met, will retry...`);
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			DEBUG &&
				console.debug(
					`[Polling] Error during attempt ${attempt}: ${errorMessage} - continuing...`,
				);
		}

		await new Promise((resolve) => setTimeout(resolve, interval));
	}

	DEBUG &&
		console.debug(
			`[Polling] Timeout reached after ${attempt} attempts (${maxDuration}ms elapsed)`,
		);
	return false;
}

/**
 * Poll until an async function returns a defined value; returns that value.
 * Throws with a descriptive message on timeout.
 *
 * Prefer over `let x: T | undefined` + `pollUntil` + non-null assertion:
 * the return type is narrowed to `T`, eliminating `!` at call sites.
 */
export async function pollUntilValue<T>(
	fetchValue: () => Promise<T | undefined | null>,
	maxDuration: number,
	interval: number,
	label = "value",
): Promise<T> {
	let captured: T | undefined;
	const found = await pollUntil(
		async () => {
			const result = await fetchValue();
			if (result === undefined || result === null) return false;
			captured = result;
			return true;
		},
		maxDuration,
		interval,
	);
	if (!found || captured === undefined) {
		throw new Error(
			`pollUntilValue: timed out waiting for ${label} after ${maxDuration}ms`,
		);
	}
	return captured;
}
