/**
 * Phase 0 spike: snapshot what the Play Developer Publishing API exposes for an app.
 *
 * Runs the read-only flow  edits.insert → tracks.list + bundles.list → edits.delete
 * and writes the raw responses to test/fixtures/play-api/private/<timestamp>-<label>.json
 * (git-ignored). Run it at each stage of a review cycle (in review, rejected, approved,
 * published, live) so the responses can be diffed against the decision table in docs/design.md.
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

  const edit = await api.edits.insert({ packageName });
  const editId = edit.data.id;
  if (!editId) throw new Error('edits.insert returned no edit id');
  process.stdout.write(`edit ${editId} opened for ${packageName}\n`);

  const call = async <T>(name: string, fn: () => Promise<{ data: T }>): Promise<T | null> => {
    try {
      return (await fn()).data;
    } catch (e) {
      errors[name] = e instanceof Error ? e.message : String(e);
      process.stderr.write(`${name} failed: ${errors[name]}\n`);
      return null;
    }
  };

  const tracks = await call('tracks.list', () => api.edits.tracks.list({ packageName, editId }));
  const bundles = await call('bundles.list', () => api.edits.bundles.list({ packageName, editId }));
  const details = await call('details.get', () => api.edits.details.get({ packageName, editId }));

  await call('edits.delete', () => api.edits.delete({ packageName, editId }));

  const snapshot = { capturedAt, label, packageName, editId, tracks, bundles, details, errors };
  mkdirSync(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, `${capturedAt.replace(/[:.]/g, '-')}-${label}.json`);
  writeFileSync(file, JSON.stringify(snapshot, null, 2) + '\n');

  process.stdout.write(`\nSnapshot written: ${file}\n\n`);
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
