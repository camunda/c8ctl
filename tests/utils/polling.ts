/**
 * Test utilities for polling operations
 * Provides generic polling functionality for waiting on asynchronous operations in tests
 */

// Enable debug logging when DEBUG environment variable is set
const DEBUG = process.env.DEBUG === 'true' || process.env.DEBUG === '1';

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
  interval: number
): Promise<boolean> {
  const startTime = Date.now();
  const maxAttempts = Math.ceil(maxDuration / interval);
  
  DEBUG && console.debug(`[Polling] Starting poll - max duration: ${maxDuration}ms, interval: ${interval}ms, max attempts: ${maxAttempts}`);
  
  const attemptPoll = async (attemptNumber: number): Promise<boolean> => {
    const elapsedTime = Date.now() - startTime;
    
    // Check timeout conditions
    if (attemptNumber >= maxAttempts || elapsedTime >= maxDuration) {
      DEBUG && console.debug(`[Polling] Timeout reached after ${attemptNumber} attempts (${elapsedTime}ms elapsed)`);
      return false;
    }
    
    DEBUG && console.debug(`[Polling] Attempt ${attemptNumber + 1}/${maxAttempts} (${elapsedTime}ms elapsed)`);
    
    try {
      // Check if condition is met
      const conditionMet = await checkCondition();
      if (conditionMet) {
        DEBUG && console.debug(`[Polling] ✓ Condition met after ${attemptNumber + 1} attempts (${elapsedTime}ms elapsed)`);
        return true;
      }
      DEBUG && console.debug(`[Polling] Condition not yet met, will retry...`);
    } catch (error) {
      // Continue polling on error - condition not met yet
      const errorMessage = error instanceof Error ? error.message : String(error);
      DEBUG && console.debug(`[Polling] Error during attempt ${attemptNumber + 1}: ${errorMessage} - continuing...`);
    }
    
    // Wait before next attempt
    await new Promise(resolve => setTimeout(resolve, interval));
    return attemptPoll(attemptNumber + 1);
  };
  
  return attemptPoll(0);
}
