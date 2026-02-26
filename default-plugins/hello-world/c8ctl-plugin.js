/**
 * c8ctl-plugin-hello-world
 * 
 * A simple "hello world" plugin that demonstrates the c8ctl plugin API.
 * This plugin is loaded by default as an example of essential functionality.
 */

// Optional metadata for help text
export const metadata = {
  name: 'hello-world',
  description: 'Default hello world plugin - demonstrates the plugin API',
  commands: {
    'hello-world': {
      description: 'Display a hello world message with c8ctl runtime information',
    },
  },
};

// Required commands export
export const commands = {
  'hello-world': async (args) => {
    console.log('👋 Hello from c8ctl plugin system!');
    console.log('');
    console.log('This is the default hello-world plugin, demonstrating the plugin API.');
    console.log('');
    
    // Access c8ctl runtime information (available via globalThis.c8ctl)
    if (globalThis.c8ctl) {
      console.log('🔧 c8ctl Runtime Information:');
      console.log(`   Version: ${globalThis.c8ctl.version}`);
      console.log(`   Node.js: ${globalThis.c8ctl.nodeVersion}`);
      console.log(`   Platform: ${globalThis.c8ctl.platform}`);
      console.log(`   Architecture: ${globalThis.c8ctl.arch}`);
      console.log(`   Working Directory: ${globalThis.c8ctl.cwd}`);
      console.log(`   Output Mode: ${globalThis.c8ctl.outputMode}`);
      console.log('   Client Factory: available via globalThis.c8ctl.createClient(profile?, sdkConfig?)');
      console.log('   Logger Access: available via globalThis.c8ctl.getLogger()');
      
      if (globalThis.c8ctl.activeProfile) {
        console.log(`   Active Profile: ${globalThis.c8ctl.activeProfile}`);
      }
      
      if (globalThis.c8ctl.activeTenant) {
        console.log(`   Active Tenant: ${globalThis.c8ctl.activeTenant}`);
      }
    }
    
    console.log('');
    
    // Show provided arguments
    if (args && args.length > 0) {
      console.log('📝 Arguments provided:');
      args.forEach((arg, index) => {
        console.log(`   ${index + 1}. ${arg}`);
      });
      console.log('');
    }
    
    console.log('✨ Plugin API Features:');
    console.log('   - Access to c8ctl runtime via globalThis.c8ctl');
    console.log('   - Create SDK clients via globalThis.c8ctl.createClient()');
    console.log('   - Use c8ctl logger via globalThis.c8ctl.getLogger()');
    console.log('   - Commands receive arguments as string array');
    console.log('   - Metadata provides help text integration');
    console.log('   - Full Node.js API available');
    console.log('');
    console.log('📚 Learn more: https://github.com/camunda/c8ctl/blob/main/PLUGIN-HELP.md');
  },
};
