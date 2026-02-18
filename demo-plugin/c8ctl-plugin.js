// c8ctl-plugin.ts
export const metadata = {
  name: 'my-plugin',
  description: 'My custom c8ctl plugin',
  commands: {
    analyze: {
      description: 'Analyze BPMN processes'
    }
  }
};

export const commands = {
  analyze: async (args) => {
    console.log('Analyzing...', args);
  }
};
