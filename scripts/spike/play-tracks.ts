/**
 * Spike: snapshot what the Play Developer Publishing API exposes for an app.
 *
 * Captures two views side by side and writes the raw responses to
 * test/fixtures/play-api/private/<timestamp>-<label>.json (git-ignored):
 *
 *   1. `applications.tracks.releases.list` per track, the release lifecycle view the adapter
 *      is built on (`releaseLifecycleState`: DRAFT, NOT_SENT_FOR_REVIEW, IN_REVIEW,
 *      APPROVED_NOT_PUBLISHED, NOT_APPROVED, PUBLISHED);
 *   2. the legacy edit flow  edits.insert → tracks.list + bundles.list → edits.delete,
 *      kept so the two can be diffed at each stage of a review cycle.
 *
 * Run it at each stage (in-review, approved, rejected, published) so the responses can be
 * checked against the transition table in docs/design.md.
 *
 * Usage:
 *   PLAY_SERVICE_ACCOUNT_FILE=./sa.json npm run spike:play -- com.example.app in-review
 *   PLAY_SERVICE_ACCOUNT_JSON='{...}'   npm run spike:play -- com.example.app approved
 */
import { androidpublisher, auth as authPlus } from '@googleapis/androidpublisher';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT_DIR = join(__dirname, '..', '..', 'test', 'fixtures', 'play-api', 'private');
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const TRACKS = ['production', 'beta', 'alpha', 'internal'];

function loadCredentials(): Record<string, unknown> {
  const file = process.env['PLAY_SERVICE_ACCOUNT_FILE'];
  const json = process.env['PLAY_SERVICE_ACCOUNT_JSON'];
  const raw = file ? readFileSync(file, 'utf8') : json;
  if (!raw) {
    throw new Error('Set PLAY_SERVICE_ACCOUNT_FILE=<path> or PLAY_SERVICE_ACCOUNT_JSON=<json>');
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

async function main(): Promise<void> {
  const [packageName, labelArg] = process.argv.slice(2);
  if (!packageName) {
    process.stderr.write('Usage: npm run spike:play -- <packageName> [label]\n');
    process.exit(1);
  }
  const label = (labelArg ?? 'snapshot').replace(/[^a-zA-Z0-9_-]+/g, '-');

  const credentials = loadCredentials();
  const auth = new authPlus.GoogleAuth({ credentials, scopes: [SCOPE] });
  const api = androidpublisher({ version: 'v3', auth });

  const capturedAt = new Date().toISOString();
  const errors: Record<string, string> = {};

  const call = async <T>(name: string, fn: () => Promise<{ data: T }>): Promise<T | null> => {
    try {
      return (await fn()).data;
    } catch (e) {
      errors[name] = e instanceof Error ? e.message : String(e);
      process.stderr.write(`${name} failed: ${errors[name]}\n`);
      return null;
    }
  };

  // 1. Release lifecycle view (no edit needed).
  const releases: Record<string, unknown> = {};
  for (const track of TRACKS) {
    const res = await call(`releases.list(${track})`, () =>
      api.applications.tracks.releases.list({
        parent: `applications/${packageName}/tracks/${track}`,
      }),
    );
    if (res) releases[track] = res;
  }

  // 2. Legacy edit flow.
  let tracks: Awaited<ReturnType<typeof api.edits.tracks.list>>['data'] | null = null;
  let bundles: Awaited<ReturnType<typeof api.edits.bundles.list>>['data'] | null = null;
  let editId: string | undefined;
  const edit = await call('edits.insert', () => api.edits.insert({ packageName }));
  if (edit?.id) {
    editId = edit.id;
    process.stdout.write(`edit ${editId} opened for ${packageName}\n`);
    tracks = await call('tracks.list', () => api.edits.tracks.list({ packageName, editId }));
    bundles = await call('bundles.list', () => api.edits.bundles.list({ packageName, editId }));
    await call('edits.delete', () => api.edits.delete({ packageName, editId }));
  }

  const snapshot = { capturedAt, label, packageName, editId, releases, tracks, bundles, errors };
  mkdirSync(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, `${capturedAt.replace(/[:.]/g, '-')}-${label}.json`);
  writeFileSync(file, JSON.stringify(snapshot, null, 2) + '\n');

  process.stdout.write(`\nSnapshot written: ${file}\n\n`);
  process.stdout.write('release lifecycle (applications.tracks.releases.list):\n');
  for (const track of TRACKS) {
    const res = releases[track] as { releases?: Array<Record<string, unknown>> } | undefined;
    if (!res) continue;
    process.stdout.write(`track ${track}\n`);
    for (const r of res.releases ?? []) {
      const artifacts = (r['activeArtifacts'] as Array<{ versionCode?: number }> | undefined) ?? [];
      process.stdout.write(
        `  release name=${r['releaseName'] ?? '-'} state=${r['releaseLifecycleState'] ?? '-'} ` +
          `versionCodes=${artifacts.map((a) => a.versionCode).join(',') || '-'}\n`,
      );
    }
    if (!res.releases?.length) process.stdout.write('  (no releases)\n');
  }

  process.stdout.write('\nlegacy edit view (edits.tracks.list):\n');
  for (const t of tracks?.tracks ?? []) {
    process.stdout.write(`track ${t.track}\n`);
    for (const r of t.releases ?? []) {
      process.stdout.write(
        `  release name=${r.name ?? '-'} status=${r.status ?? '-'} ` +
          `versionCodes=${(r.versionCodes ?? []).join(',') || '-'} userFraction=${r.userFraction ?? '-'}\n`,
      );
    }
    if (!t.releases?.length) process.stdout.write('  (no releases)\n');
  }
  const codes = (bundles?.bundles ?? []).map((b) => b.versionCode).join(', ');
  process.stdout.write(`uploaded bundles: ${codes || '(none)'}\n`);
  if (Object.keys(errors).length) process.stdout.write(`errors: ${JSON.stringify(errors)}\n`);
}

main().catch((e: unknown) => {
  process.stderr.write((e instanceof Error ? (e.stack ?? e.message) : String(e)) + '\n');
  process.exit(1);
});
