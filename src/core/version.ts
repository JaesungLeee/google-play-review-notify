/**
 * Package version, inlined at build time by tsup (`define`), used for `--version` and outbound
 * User-Agent headers. Falls back to npm's env var (npm scripts, tsx dev runs) or a dev marker.
 */
declare const __PKG_VERSION__: string | undefined;

export const PACKAGE_VERSION: string =
  typeof __PKG_VERSION__ === 'string'
    ? __PKG_VERSION__
    : (process.env['npm_package_version'] ?? '0.0.0-dev');
