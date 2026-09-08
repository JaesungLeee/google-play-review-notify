/**
 * Package version for `--version` and outbound User-Agent headers.
 *
 * The CLI/library bundle gets it inlined by tsup (`define`), because it is built at publish time.
 * The GitHub Action bundle is committed to the repository and would go stale on every version
 * bump if the value were inlined, so it reads package.json next to the bundle at runtime instead.
 * Fallbacks cover tsx runs (npm's env var) and everything else (a dev marker).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

declare const __PKG_VERSION__: string | undefined;

function readPackageJsonVersion(): string | undefined {
  // dist/cli.js → ../package.json, dist/action/index.js → ../../package.json, src/core → ../../
  let dir = __dirname;
  for (let i = 0; i < 3; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === 'play-review-notify' && typeof pkg.version === 'string') return pkg.version;
    } catch {
      // keep walking up
    }
    dir = dirname(dir);
  }
  return undefined;
}

export const PACKAGE_VERSION: string =
  typeof __PKG_VERSION__ === 'string'
    ? __PKG_VERSION__
    : (readPackageJsonVersion() ?? process.env['npm_package_version'] ?? '0.0.0-dev');
