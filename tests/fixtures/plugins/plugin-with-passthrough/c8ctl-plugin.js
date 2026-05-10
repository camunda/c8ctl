/**
 * Test plugin for the passthrough contract (#366).
 *
 * - `pass-through-cmd` is a bare-function handler. Its metadata declares
 *   `passthrough: true` with a `passthroughHint`. c8ctl strips GLOBAL_FLAGS
 *   and forwards everything else verbatim. The handler echoes its argv as
 *   JSON so tests can assert what reached it.
 * - `bad-passthrough-with-flags` declares both `passthrough: true` AND
 *   `flags`. This is invalid — load-time validation must reject the
 *   command (drop it from the registered command set). Tests assert it
 *   is unreachable from the CLI.
 */

export const commands = {
	'pass-through-cmd': async (args) => {
		console.log(JSON.stringify({ args }));
	},
	'bad-passthrough-with-flags': {
		flags: {
			something: { type: 'string', description: 'A flag (invalid alongside passthrough)' },
		},
		handler: async (args, flags) => {
			console.log(JSON.stringify({ args, flags: flags || {} }));
		},
	},
};

export const metadata = {
	name: 'plugin-with-passthrough',
	description: 'Plugin for testing passthrough contract',
	commands: {
		'pass-through-cmd': {
			description: 'Forward all args to a hypothetical underlying tool',
			helpDescription: 'A passthrough command used to exercise the #366 contract.',
			passthrough: true,
			passthroughHint: 'Forwards args to `external-tool`',
			flagsHint: ['--from <url>', '--to <path>', '--dry'],
			examples: [
				{ command: 'c8ctl pass-through-cmd --from URL --to PATH', description: 'Forward URL/PATH to external-tool' },
			],
		},
		'bad-passthrough-with-flags': {
			description: 'Invalid combination — should be rejected at load time',
			passthrough: true,
			passthroughHint: 'irrelevant — flags are also declared which is invalid',
		},
	},
};
