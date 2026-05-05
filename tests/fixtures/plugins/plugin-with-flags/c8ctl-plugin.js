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
			verbose: {
				type: 'boolean',
				description: 'Enable verbose output',
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
