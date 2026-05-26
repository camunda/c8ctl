/**
 * Helper script for confirm-interactive.test.ts.
 *
 * Forces the interactive (TTY) branch of confirmDeployTarget() by
 * stubbing isTTY on stdin and stderr, then prints the result to
 * stdout so the test can assert on it.
 */

// Stub isTTY before importing confirmDeployTarget so the readline
// branch fires even though we are running in a piped subprocess.
Object.defineProperty(process.stdin, "isTTY", { value: true });
Object.defineProperty(process.stderr, "isTTY", { value: true });

const { confirmDeployTarget } = await import("../../src/confirm.ts");

const result = await confirmDeployTarget({
	profileName: "production",
	baseUrl: "https://prod.zeebe.camunda.io",
});

process.stdout.write(result);
