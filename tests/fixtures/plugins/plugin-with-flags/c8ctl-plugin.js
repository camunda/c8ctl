/**
 * Test plugin with custom flags for testing flag support
 */

export const commands = {
	'test-flags': {
		flags: {
			source: {
				type: 'string',
				description: 'Source element ID',
			},
			target: {
				type: 'string',
				description: 'Target element ID',
			},
			debug: {
				type: 'boolean',
				description: 'Enable debug output',
			},
		},
		handler: async (args, flags) => {
			// Output args and flags as JSON so tests can validate them
			console.log(JSON.stringify({
				args,
				flags: flags || {},
			}));
		},
	},

	'test-required': {
		flags: {
			'required-name': {
				type: 'string',
				description: 'A required string flag',
				required: true,
			},
		},
		handler: async (args, flags) => {
			console.log(JSON.stringify({ args, flags: flags || {} }));
		},
	},

	'test-collision': {
		flags: {
			verbose: {
				type: 'string',
				description: 'Collides with built-in --verbose flag',
			},
			safe: {
				type: 'string',
				description: 'A non-colliding flag',
			},
		},
		handler: async (args, flags) => {
			console.log(JSON.stringify({ args, flags: flags || {} }));
		},
	},
};

export const metadata = {
	name: 'test-flags-plugin',
	description: 'Plugin for testing flag support',
	commands: {
		'test-flags': {
			description: 'Test command with custom flags',
			examples: [
				{ command: 'c8ctl test-flags --source Gateway_1 --target Task_2', description: 'Test with flags' },
			],
		},
	},
};
