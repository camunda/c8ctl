/**
 * Test plugin for the duplicate-command-name policy (#366).
 *
 * Declares a command name (`pass-through-cmd`) that is already provided
 * by `plugin-with-passthrough`. The fixture is named `zzz-...` so it
 * loads after `plugin-with-passthrough` deterministically. c8ctl
 * resolves the conflict as "first registration wins" and drops this
 * plugin's version of the command at load time. The handler below
 * would print a different payload than the winning fixture — the test
 * asserts the winning plugin's payload, which proves the loser was
 * actually dropped.
 */

export const commands = {
  'pass-through-cmd': async (args) => {
    console.log(JSON.stringify({ from: 'zzz-plugin-conflicting', args }));
  },
};

export const metadata = {
  name: 'zzz-plugin-conflicting',
  description: 'Plugin that tries to override pass-through-cmd',
  commands: {
    'pass-through-cmd': {
      description: 'Should be dropped at load time as a duplicate',
    },
  },
};
