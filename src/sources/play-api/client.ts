/** Thin Play Developer Publishing API client (service account, read-only edit flow). FR-SRC-API-1. */
import { androidpublisher, auth as authPlus } from '@googleapis/androidpublisher';
import { readFileSync } from 'node:fs';

const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

export interface TrackRelease {
  name?: string;
  status?: string;
  versionCodes: string[];
  userFraction?: number;
}

export interface TrackSnapshot {
  track: string;
  releases: TrackRelease[];
}

export interface PlayApiClient {
  /** All tracks of the app as currently stored on Play (one edit is opened and discarded). */
  listTracks(packageName: string): Promise<TrackSnapshot[]>;
}

/**
 * `serviceAccount` is either the JSON key content (as injected from a secret) or a path to the
 * key file. Only the "View app information (read-only)" Play Console permission is required.
 */
export function createPlayApiClient(serviceAccount: string): PlayApiClient {
  const raw = serviceAccount.trim().startsWith('{')
    ? serviceAccount
    : readFileSync(serviceAccount, 'utf8');
  const credentials = JSON.parse(raw) as Record<string, unknown>;
  const auth = new authPlus.GoogleAuth({ credentials, scopes: [SCOPE] });
  const api = androidpublisher({ version: 'v3', auth });

  return {
    async listTracks(packageName) {
      const edit = await api.edits.insert({ packageName });
      const editId = edit.data.id;
      if (!editId) throw new Error(`edits.insert returned no edit id for ${packageName}`);
      try {
        const res = await api.edits.tracks.list({ packageName, editId });
        return (res.data.tracks ?? [])
          .filter((t) => !!t.track)
          .map((t) => ({
            track: t.track as string,
            releases: (t.releases ?? []).map((r) => {
              const rel: TrackRelease = { versionCodes: [...(r.versionCodes ?? [])] };
              if (r.name) rel.name = r.name;
              if (r.status) rel.status = r.status;
              if (typeof r.userFraction === 'number') rel.userFraction = r.userFraction;
              return rel;
            }),
          }));
      } finally {
        // Read-only flow: never commit the edit.
        await api.edits.delete({ packageName, editId }).catch(() => undefined);
      }
    },
  };
}
