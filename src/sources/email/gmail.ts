/** Thin Gmail API client (OAuth2 refresh token, gmail.readonly). FR-SRC-EMAIL-1. */
import { auth as googleAuth, gmail as gmailApi, type gmail_v1 } from '@googleapis/gmail';
import { htmlToText, type ParsedEmail } from './rules';

export interface GmailAuth {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface GmailClient {
  /** Returns messages matching the Gmail search query, newest first. */
  search(query: string, max?: number): Promise<ParsedEmail[]>;
}

export function createGmailClient(auth: GmailAuth): GmailClient {
  const oauth2 = new googleAuth.OAuth2(auth.clientId, auth.clientSecret);
  oauth2.setCredentials({ refresh_token: auth.refreshToken });
  const gmail = gmailApi({ version: 'v1', auth: oauth2 });

  return {
    async search(query, max = 50) {
      const list = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: max });
      const ids = (list.data.messages ?? []).map((m) => m.id).filter((id): id is string => !!id);
      const out: ParsedEmail[] = [];
      for (const id of ids) {
        const full = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
        out.push(toParsedEmail(full.data));
      }
      return out;
    },
  };
}

export function toParsedEmail(msg: gmail_v1.Schema$Message): ParsedEmail {
  const headers = msg.payload?.headers ?? [];
  const header = (name: string) =>
    headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
  const { text, html } = collectBodies(msg.payload);
  const body = text.trim() ? text : htmlToText(html);
  return {
    id: msg.id ?? '',
    from: header('From'),
    subject: header('Subject'),
    body,
    receivedAt: msg.internalDate
      ? new Date(Number(msg.internalDate)).toISOString()
      : new Date().toISOString(),
  };
}

function decode(data?: string | null): string {
  if (!data) return '';
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function collectBodies(part?: gmail_v1.Schema$MessagePart): { text: string; html: string } {
  if (!part) return { text: '', html: '' };
  let text = '';
  let html = '';
  if (part.mimeType === 'text/plain') text += decode(part.body?.data);
  else if (part.mimeType === 'text/html') html += decode(part.body?.data);
  for (const child of part.parts ?? []) {
    const c = collectBodies(child);
    text += c.text;
    html += c.html;
  }
  return { text, html };
}

/** Gmail search query for Play Console notifications newer than `since`. */
export function buildQuery(senders: string[], since: Date): string {
  const from = senders.map((s) => `from:${s}`).join(' OR ');
  const epoch = Math.floor(since.getTime() / 1000);
  return `(${from}) after:${epoch}`;
}
