/**
 * Preload (`node --import`) that makes a spawned CLI believe stdin and
 * stderr are terminals, so interactive prompts (`select`) run under test
 * and can be driven by keystrokes written to the piped stdin.
 */

Object.defineProperty(process.stdin, "isTTY", { value: true });
Object.defineProperty(process.stdin, "setRawMode", {
	value: () => process.stdin,
});
Object.defineProperty(process.stderr, "isTTY", { value: true });
Object.defineProperty(process.stderr, "columns", { value: 200 });
