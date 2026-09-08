/**
 * Email classification engine. Rules are evaluated top-to-bottom; the first subject/body match wins.
 * Extraction patterns are `regex:<pattern>` (first capture group) or `section:<Heading|Alt>` (text
 * following a heading line until a blank line). See docs/design.md, "Email rule sets".
 */
import { readFileSync } from 'node:fs';
import type { ReviewEventType } from '../../core/types';

export interface EmailRule {
  type: ReviewEventType;
  subject?: string[];
  body?: string[];
}

export interface EmailRuleSet {
  locale: string;
  rules: EmailRule[];
  extract?: Partial<
    Record<'packageName' | 'appName' | 'versionName' | 'versionCode' | 'reason', string[]>
  >;
}

export interface ParsedEmail {
  id: string;
  from: string;
  subject: string;
  /** Plain-text body (HTML already stripped). */
  body: string;
  receivedAt: string;
}

export interface Classification {
  type: ReviewEventType;
  packageName?: string;
  appName?: string;
  versionName?: string;
  versionCode?: string;
  reason?: string;
}

import enRules from '../../../rules/email/en.json';
import koRules from '../../../rules/email/ko.json';

/**
 * Rule sets bundled with the package (embedded at build time, no filesystem lookup).
 * Evaluated in order; English first so its extractors act as the fallback for unmatched mail.
 */
export function loadBuiltinRuleSets(): EmailRuleSet[] {
  return [enRules as EmailRuleSet, koRules as EmailRuleSet];
}

export function loadRuleSetFiles(paths: string[]): EmailRuleSet[] {
  return paths.map((p) => JSON.parse(readFileSync(p, 'utf8')) as EmailRuleSet);
}

export function senderAllowed(from: string, allowlist: string[]): boolean {
  const addr = (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();
  return allowlist.some((a) => {
    const rule = a.toLowerCase();
    return rule.startsWith('@') ? addr.endsWith(rule) : addr === rule;
  });
}

function matches(text: string, needles: string[] | undefined): boolean {
  if (!needles || needles.length === 0) return false;
  const hay = text.toLowerCase();
  return needles.some((n) => hay.includes(n.toLowerCase()));
}

function runExtractor(pattern: string, text: string): string | undefined {
  if (pattern.startsWith('regex:')) {
    const m = new RegExp(pattern.slice(6), 'm').exec(text);
    return m?.[1]?.trim() || undefined;
  }
  if (pattern.startsWith('section:')) {
    const headings = pattern
      .slice(8)
      .split('|')
      .map((h) => h.trim());
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]?.trim() ?? '';
      // No `\b` here: JS word boundaries are ASCII-only and never match after Korean text.
      if (headings.some((h) => new RegExp(`^${h}(?=[:：\\s]|$)`, 'i').test(line))) {
        const inline = line
          .replace(new RegExp(`^(?:${headings.join('|')})[:：\\s]*`, 'i'), '')
          .trim();
        const collected: string[] = inline ? [inline] : [];
        for (let j = i + 1; j < lines.length; j++) {
          const next = lines[j]?.trim() ?? '';
          if (!next) {
            if (collected.length) break;
            continue;
          }
          collected.push(next);
        }
        const joined = collected.join(' ').trim();
        if (joined) return joined;
      }
    }
  }
  return undefined;
}

export function classifyEmail(
  email: ParsedEmail,
  ruleSets: EmailRuleSet[],
  opts: { reasonMaxLength?: number } = {},
): Classification {
  let type: ReviewEventType = 'UNKNOWN_NOTICE';
  let matched: EmailRuleSet | undefined;
  outer: for (const set of ruleSets) {
    for (const rule of set.rules) {
      if (matches(email.subject, rule.subject) || matches(email.body, rule.body)) {
        type = rule.type;
        matched = set;
        break outer;
      }
    }
  }

  const result: Classification = { type };
  const text = `${email.subject}\n${email.body}`;
  const extractors = { ...ruleSets[0]?.extract, ...matched?.extract };
  for (const [field, patterns] of Object.entries(extractors) as Array<
    [keyof Classification, string[]]
  >) {
    if (field === 'type') continue;
    for (const p of patterns) {
      const v = runExtractor(p, field === 'reason' ? email.body : text);
      if (v) {
        (result as unknown as Record<string, string>)[field] = v;
        break;
      }
    }
  }
  if (result.reason) {
    const max = opts.reasonMaxLength ?? 1000;
    if (result.reason.length > max) result.reason = result.reason.slice(0, max - 1) + '…';
  }
  return result;
}

/** Very small HTML → text conversion good enough for notification emails. */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
