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
 */

export const commands = {
  'npm-version': async () => {
    const { stdout } = globalThis.c8ctl.npm({ args: ['--version'], stdout: true });
    console.log(JSON.stringify({ version: stdout.trim() }));
  },
  'npm-shape': async () => {
    console.log(JSON.stringify({ npmType: typeof globalThis.c8ctl.npm }));
  },
};

export const metadata = {
  name: 'plugin-with-npm',
  description: 'Fixture: plugin consumption of the runtime npm runner',
  commands: {
    'npm-version': { description: 'Print npm --version via c8ctl.npm()' },
    'npm-shape': { description: 'Report the type of c8ctl.npm' },
  },
};
