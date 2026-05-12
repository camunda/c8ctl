/**
 * Test fixture for #373.
 *
 * This plugin declares a verb (`verb-scoped-demo`) whose flags collide
 * with **verb-scoped** built-in flag names (e.g. `limit`, which lives
 * in `SEARCH_FLAGS` and is therefore valid only on `search` and `get`).
 *
 * Today's flat-namespace parser (`deriveParseArgsOptions()`) unions every
 * verb's flags into one global option set, so the plugin pre-parse
 * blocks `--limit` for ANY plugin verb on the grounds that it collides
 * with the union — even though `--limit` is not a global flag and would
 * never be relevant to this plugin's verb.
 *
 * Under the per-verb scoping that #373 introduces, a plugin verb's
 * effective flag table is `GLOBAL_FLAGS ∪ plugin.flags`. `--limit` is
 * not in `GLOBAL_FLAGS`, so the plugin's `--limit` should be parsed
 * and forwarded to the handler.
 *
 * The handler echoes args + flags as JSON so the contract test can
 * assert what value (if any) reached it.
 */

export const commands = {
	'verb-scoped-demo': {
		flags: {
			limit: {
				type: 'string',
				description: "Plugin's own --limit (collides with SEARCH_FLAGS.limit)",
			},
			between: {
				type: 'string',
				description: "Plugin's own --between (collides with SEARCH_FLAGS.between)",
			},
		},
		handler: async (args, flags) => {
			console.log(JSON.stringify({ args, flags: flags || {} }));
		},
	},
};

export const metadata = {
	name: 'plugin-with-verb-scoped-flag',
	description: 'Fixture pinning the per-verb flag scoping contract for #373',
	commands: {
		'verb-scoped-demo': {
			description: 'Echoes args and flags as JSON for contract assertions',
		},
	},
};
