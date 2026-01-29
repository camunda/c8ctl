/**
 * c8ctl runtime object with environment information
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
/**
 * Get c8ctl version from package.json
 */
function getVersion() {
    try {
        const packageJsonPath = join(__dirname, '..', 'package.json');
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
        return packageJson.version || '0.0.0';
    }
    catch {
        return '0.0.0';
    }
}
/**
 * Create the c8ctl runtime object
 */
export const c8ctl = {
    env: {
        version: getVersion(),
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        cwd: process.cwd(),
        rootDir: join(__dirname, '..'),
    },
};
//# sourceMappingURL=runtime.js.map