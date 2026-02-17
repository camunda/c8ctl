/**
 * c8ctl-test-scaffold2 - A c8ctl plugin
 */
// Optional metadata for help text
export const metadata = {
    name: 'c8ctl-test-scaffold2',
    description: 'A c8ctl plugin',
    commands: {
        hello: {
            description: 'Say hello from the plugin',
        },
    },
};
// Required commands export
export const commands = {
    hello: async (args) => {
        console.log('Hello from c8ctl-test-scaffold2!');
        console.log('c8ctl version:', c8ctl.version);
        console.log('Node version:', c8ctl.nodeVersion);
        if (args.length > 0) {
            console.log('Arguments:', args.join(', '));
        }
        // Example: Access c8ctl runtime
        console.log('Current directory:', c8ctl.cwd);
        console.log('Output mode:', c8ctl.outputMode);
        if (c8ctl.activeProfile) {
            console.log('Active profile:', c8ctl.activeProfile);
        }
    },
};
