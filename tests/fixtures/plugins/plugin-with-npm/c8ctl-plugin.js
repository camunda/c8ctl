/**
 * Test fixture: consuming `c8ctl.npm()` from a plugin.
 *
 * Verb `npm-version` runs `npm --version` through the runtime's
 * cross-platform npm runner and echoes the captured stdout, proving that
 * plugins reach the same Windows-safe invocation path the CLI uses instead
 * of hand-rolling `execSync('npm ...')`.
 *
 * Verb `npm-shape` reports what the runtime exposes without spawning
 * anything, so the surface can be asserted on hosts where npm is slow.
 *
 * Verb `npm-prefix-install` runs `npm install --prefix <dir>` for a directory
 * that is *not* the process cwd, which is how plugins scope an install to
 * their own dependency directory (#526).
 */

export const commands = {
  'npm-version': async () => {
    const { stdout } = globalThis.c8ctl.npm({ args: ['--version'], stdout: true });
    console.log(JSON.stringify({ version: stdout.trim() }));
  },
  'npm-shape': async () => {
    console.log(JSON.stringify({ npmType: typeof globalThis.c8ctl.npm }));
  },
  'npm-prefix-install': async (args) => {
    const prefix = args[0];
    try {
      globalThis.c8ctl.npm({
        args: [
          'install',
          '--prefix',
          prefix,
          '--package-lock-only',
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
        ],
        stdio: 'pipe',
      });
    } catch (error) {
      // npm's own diagnostics land on the child's stderr, which `stdio: 'pipe'`
      // captures onto the thrown error; surface them or the assertion failure
      // is unreadable.
      console.error(String(error.stderr ?? error.message ?? error));
      throw error;
    }
    console.log(JSON.stringify({ prefix }));
  },
};

export const metadata = {
  name: 'plugin-with-npm',
  description: 'Fixture: plugin consumption of the runtime npm runner',
  commands: {
    'npm-version': { description: 'Print npm --version via c8ctl.npm()' },
    'npm-shape': { description: 'Report the type of c8ctl.npm' },
    'npm-prefix-install': {
      description: 'Run npm install --prefix <dir> via c8ctl.npm()',
    },
  },
};
