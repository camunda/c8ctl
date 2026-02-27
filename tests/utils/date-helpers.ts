/**
 * Date helper utilities for integration tests.
 */

/** Milliseconds in one calendar day */
export const MS_PER_DAY = 86_400_000;

/**
 * Returns a `YYYY-MM-DD..YYYY-MM-DD` date range spanning yesterday to tomorrow,
 * so any resource created during the current test run falls inside the window.
 */
export function todayRange(): string {
  const yesterday = new Date(Date.now() - MS_PER_DAY).toISOString().slice(0, 10);
  const tomorrow  = new Date(Date.now() + MS_PER_DAY).toISOString().slice(0, 10);
  return `${yesterday}..${tomorrow}`;
}
