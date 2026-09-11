/** Thin Play Developer Publishing API client (service account, read-only). */
import { androidpublisher, auth as authPlus } from '@googleapis/androidpublisher';
import { readFileSync } from 'node:fs';

const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

/**
 * `releaseLifecycleState` values of `applications.tracks.releases.list`, without the
 * `RELEASE_LIFECYCLE_STATE_` prefix. Unknown values are passed through as-is.
 */
export const RELEASE_STATES = [
  'DRAFT',
  'NOT_SENT_FOR_REVIEW',
  'IN_REVIEW',
  'APPROVED_NOT_PUBLISHED',
  'NOT_APPROVED',
  'PUBLISHED',
] as const;
export type ReleaseState = (typeof RELEASE_STATES)[number];

export interface ReleaseSummary {
  name?: string;
  /** One of RELEASE_STATES, or the raw API value when it is not recognised. */
  state: string;
  /** Version codes of the release's active artifacts, as strings. */
  versionCodes: string[];
}

export interface PlayApiClient {
  /** Releases currently on one track (obsolete releases excluded by the API). */
  listReleases(packageName: string, track: string): Promise<ReleaseSummary[]>;
}

const STATE_PREFIX = 'RELEASE_LIFECYCLE_STATE_';

export function normalizeReleaseState(raw: string | null | undefined): string {
  const v = raw ?? 'UNSPECIFIED';
  return v.startsWith(STATE_PREFIX) ? v.slice(STATE_PREFIX.length) : v;
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
    async listReleases(packageName, track) {
      const res = await api.applications.tracks.releases.list({
        parent: `applications/${packageName}/tracks/${track}`,
      });
      return (res.data.releases ?? []).map((r) => {
        const rel: ReleaseSummary = {
          state: normalizeReleaseState(r.releaseLifecycleState),
          versionCodes: (r.activeArtifacts ?? [])
            .map((a) => a.versionCode)
            .filter((v): v is number => typeof v === 'number')
            .map(String),
        };
        if (r.releaseName) rel.name = r.releaseName;
        return rel;
      });
    },
  };
}
