/**
 * Test fixture for plugin host context (#377).
 *
 * Verb `echo-ctx` echoes the third `ctx` argument as JSON so the
 * contract test can assert which globals were reflected and with what
 * values.
 *
 * Verb `dry-run-echo` honours `ctx.dryRun` end-to-end: it prints a
 * dry-run summary instead of the "real" action so the contract test
 * can prove that `--dry-run` reached the plugin handler as a typed
 * boolean.
 */

export const commands = {
  'echo-ctx': {
    flags: {
      flag1: { type: 'string', description: 'A plugin-declared flag' },
    },
    handler: async (args, flags, ctx) => {
      // Snapshot only the documented shape — skip the lazy client getter
      // so JSON.stringify doesn't trigger credential resolution.
      const ctxSnapshot = ctx
        ? {
            dryRun: ctx.dryRun,
            verbose: ctx.verbose,
            outputMode: ctx.outputMode,
            fields: ctx.fields ?? null,
            profile: ctx.profile,
            hasLogger: typeof ctx.logger === 'object' && ctx.logger !== null,
            // hasClient: just probe whether the getter exists. Do NOT
            // read it — that resolves credentials.
            hasClient: 'client' in ctx,
          }
        : null;
      console.log(JSON.stringify({ args, flags: flags || {}, ctx: ctxSnapshot }));
    },
  },
  'dry-run-echo': {
    flags: {},
    handler: async (_args, _flags, ctx) => {
      if (ctx && ctx.dryRun) {
        console.log(JSON.stringify({ kind: 'dry-run', message: 'would do X' }));
        return;
      }
      console.log(JSON.stringify({ kind: 'executed' }));
    },
  },
  'legacy-two-arg': {
    flags: {},
    // Intentional: handler signature is `(args, flags)` only.
    // Backward-compat: a plugin written before #377 must still work
    // when the host passes a third arg.
    handler: async (args, flags) => {
      console.log(JSON.stringify({ args, flags: flags || {}, sawCtx: false }));
    },
  },
};

export const metadata = {
  name: 'plugin-with-host-context',
  description: 'Fixture for #377: plugin host context, --help, --version',
  commands: {
    'echo-ctx': {
      description: 'Echoes the host context as JSON',
      helpDescription:
        'Inspects ctx.{dryRun,verbose,outputMode,fields,profile,logger,client} and prints the snapshot.',
      examples: [
        { command: 'c8ctl echo-ctx --flag1 hello', description: 'Echo with a plugin flag' },
      ],
    },
    'dry-run-echo': {
      description: 'Demonstrates honouring ctx.dryRun',
    },
    'legacy-two-arg': {
      description: 'Legacy 2-arg handler — must keep working after #377',
    },
  },
};
