/**
 * Preload (`node --import`) that makes a spawned CLI believe stdin and
 * stderr are terminals, so interactive prompts (`select`) run under test
 * and can be driven by keystrokes written to the piped stdin.
 *
 * stdout stays piped by default — terminal-stdout behaviour (colored
 * step tags, the setup step spinner) is opt-in via
 * C8CTL_FAKE_TTY_STDOUT=true, with C8CTL_FAKE_TTY_COLUMNS setting the
 * simulated terminal width (default 200).
 */

Object.defineProperty(process.stdin, "isTTY", { value: true });
Object.defineProperty(process.stdin, "setRawMode", {
	value: () => process.stdin,
});
Object.defineProperty(process.stderr, "isTTY", { value: true });
Object.defineProperty(process.stderr, "columns", { value: 200 });

if (process.env.C8CTL_FAKE_TTY_STDOUT === "true") {
	Object.defineProperty(process.stdout, "isTTY", { value: true });
	Object.defineProperty(process.stdout, "columns", {
		value: Number(process.env.C8CTL_FAKE_TTY_COLUMNS ?? "200"),
	});
}
