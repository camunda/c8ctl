/**
 * Test fixture: a plugin declaring `engines.c8ctl` (#523).
 *
 * Both command forms are represented on purpose. When the host requirement is
 * not met the loader swaps each handler for one that throws the explanation,
 * and the `{ flags, handler }` form has to survive that swap with its `flags`
 * intact — otherwise the user gets a flag-parse error instead of the reason.
 */

export const commands = {
  'host-bare': async () => {
    console.log(JSON.stringify({ ran: 'host-bare' }));
  },
  'host-flagged': {
    flags: {
      label: { type: 'string', description: 'Echoed back verbatim' },
    },
    handler: async (_args, flags) => {
      console.log(JSON.stringify({ ran: 'host-flagged', label: flags?.label ?? null }));
    },
  },
  // A required flag is validated by the host before dispatch, so a disabled
  // plugin has to be exempt from that check or "--label is required" replaces
  // the explanation of why the command cannot run at all.
  'host-required-flag': {
    flags: {
      label: { type: 'string', description: 'Required', required: true },
    },
    handler: async (_args, flags) => {
      console.log(JSON.stringify({ ran: 'host-required-flag', label: flags?.label ?? null }));
    },
  },
};

export const metadata = {
  name: 'plugin-with-host-requirement',
  description: 'Fixture: plugin declaring a c8ctl host requirement',
  commands: {
    'host-bare': { description: 'Bare-function command' },
    'host-flagged': { description: 'Command declaring typed flags' },
    'host-required-flag': { description: 'Command declaring a required flag' },
  },
};
