/**
 * Built-in notification text (English and Korean, chosen by `language` in the config) + user
 * template overrides. See README.md, "Configuration" (templates).
 */
import type { AppConfig, Config, NotificationLanguage } from '../core/config';
import { renderTemplate } from '../core/template';
import type { RenderedMessage, ReviewEvent, ReviewEventType } from '../core/types';

export const EVENT_COLORS: Record<ReviewEventType, string> = {
  PENDING_SUBMISSION: '6a737d',
  SUBMITTED: '6a737d',
  APPROVED: '28a745',
  LIVE: '28a745',
  REJECTED: 'd73a49',
  POLICY_WARNING: 'f66a0a',
};

export const EVENT_EMOJI: Record<ReviewEventType, string> = {
  PENDING_SUBMISSION: '📝',
  SUBMITTED: '📤',
  APPROVED: '✅',
  LIVE: '🚀',
  REJECTED: '🚫',
  POLICY_WARNING: '⚠️',
};

export interface NotificationText {
  titles: Record<ReviewEventType, string>;
  /** Appended to the title of a follow-up (see `ReviewEvent.followUp`). */
  followUpSuffix: string;
  body: string;
  /** Labels of the structured fields shown next to the body (Slack fields, Discord embed). */
  fields: { package: string; track: string; version: string; source: string };
  unknownApp: string;
}

export const NOTIFICATION_TEXT: Record<NotificationLanguage, NotificationText> = {
  en: {
    titles: {
      PENDING_SUBMISSION: '{{emoji}} Ready to send for review — {{displayName}}',
      SUBMITTED: '{{emoji}} Submitted for review — {{displayName}}',
      APPROVED: '{{emoji}} Approved — {{displayName}}',
      LIVE: '{{emoji}} Live on Google Play — {{displayName}}',
      REJECTED: '{{emoji}} Rejected — {{displayName}}',
      POLICY_WARNING: '{{emoji}} Policy warning — {{displayName}}',
    },
    followUpSuffix: ' (reason added)',
    body:
      '{{#track}}Track: {{track}}{{/track}}{{#versionLabel}} · Version: {{versionLabel}}{{/versionLabel}}\n' +
      '{{#reason}}Reason: {{reason}}\n{{/reason}}' +
      '{{#consoleUrl}}Open in Play Console → {{consoleUrl}}\n{{/consoleUrl}}' +
      'Source: {{source}} · {{observedAt}}',
    fields: { package: 'Package', track: 'Track', version: 'Version', source: 'Source' },
    unknownApp: 'Unknown app',
  },
  ko: {
    titles: {
      PENDING_SUBMISSION: '{{emoji}} 검토 제출 준비됨 — {{displayName}}',
      SUBMITTED: '{{emoji}} 검토 제출됨 — {{displayName}}',
      APPROVED: '{{emoji}} 승인됨 — {{displayName}}',
      LIVE: '{{emoji}} Google Play 게시됨 — {{displayName}}',
      REJECTED: '{{emoji}} 거절됨 — {{displayName}}',
      POLICY_WARNING: '{{emoji}} 정책 경고 — {{displayName}}',
    },
    followUpSuffix: ' (사유 추가됨)',
    body:
      '{{#track}}트랙: {{track}}{{/track}}{{#versionLabel}} · 버전: {{versionLabel}}{{/versionLabel}}\n' +
      '{{#reason}}사유: {{reason}}\n{{/reason}}' +
      '{{#consoleUrl}}Play Console에서 열기 → {{consoleUrl}}\n{{/consoleUrl}}' +
      '출처: {{source}} · {{observedAt}}',
    fields: { package: '패키지', track: '트랙', version: '버전', source: '출처' },
    unknownApp: '알 수 없는 앱',
  },
};

/** The English defaults, kept under their original names for library users. */
export const DEFAULT_TITLES = NOTIFICATION_TEXT.en.titles;
export const FOLLOW_UP_SUFFIX = NOTIFICATION_TEXT.en.followUpSuffix;
export const DEFAULT_BODY = NOTIFICATION_TEXT.en.body;

export interface TemplateContext extends Record<string, unknown> {
  emoji: string;
  displayName: string;
  versionLabel: string;
  app: AppConfig | Record<string, never>;
}

export function buildContext(config: Config, event: ReviewEvent, app?: AppConfig): TemplateContext {
  const appName = event.appName ?? app?.name;
  const pkg = event.packageName ?? undefined;
  const text = NOTIFICATION_TEXT[config.language];
  const displayName = appName && pkg ? `${appName} (${pkg})` : (appName ?? pkg ?? text.unknownApp);
  const versionLabel =
    event.versionName && event.versionCode
      ? `${event.versionName} (${event.versionCode})`
      : (event.versionName ?? event.versionCode ?? '');
  const { raw: _raw, ...safeEvent } = event;
  const ctx: TemplateContext = {
    ...safeEvent,
    emoji: EVENT_EMOJI[event.type],
    displayName,
    versionLabel,
    app: app ?? {},
  };
  if (!config.includeReason) delete ctx['reason'];
  return ctx;
}

export function renderMessage(
  config: Config,
  event: ReviewEvent,
  app?: AppConfig,
): RenderedMessage {
  const ctx = buildContext(config, event, app);
  const text = NOTIFICATION_TEXT[config.language];
  const override = config.templates[event.type];
  const title =
    renderTemplate(text.titles[event.type], ctx) + (event.followUp ? text.followUpSuffix : '');
  const body = renderTemplate(override ?? text.body, ctx).trim();
  const fields: RenderedMessage['fields'] = [];
  if (event.packageName) fields.push({ label: text.fields.package, value: event.packageName });
  if (event.track) fields.push({ label: text.fields.track, value: event.track });
  if (ctx.versionLabel) fields.push({ label: text.fields.version, value: ctx.versionLabel });
  fields.push({ label: text.fields.source, value: `${event.source} (${event.confidence})` });
  const rendered: RenderedMessage = {
    event,
    title,
    body,
    color: EVENT_COLORS[event.type],
    mentions: config.events[event.type]?.mentions ?? [],
    fields,
  };
  if (app) rendered.app = app;
  return rendered;
}
