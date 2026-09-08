/** Default English templates + user overrides. See README.md, "Configuration" (templates). */
import type { AppConfig, Config } from '../core/config';
import { renderTemplate } from '../core/template';
import type { RenderedMessage, ReviewEvent, ReviewEventType } from '../core/types';

export const EVENT_COLORS: Record<ReviewEventType, string> = {
  SUBMITTED: '6a737d',
  APPROVED: '28a745',
  LIVE: '28a745',
  REJECTED: 'd73a49',
  POLICY_WARNING: 'f66a0a',
  REMOVED: '9e1c23',
  SUSPENDED: '9e1c23',
  UNKNOWN_NOTICE: '6a737d',
};

export const EVENT_EMOJI: Record<ReviewEventType, string> = {
  SUBMITTED: '📤',
  APPROVED: '✅',
  LIVE: '🚀',
  REJECTED: '🚫',
  POLICY_WARNING: '⚠️',
  REMOVED: '🗑️',
  SUSPENDED: '⛔',
  UNKNOWN_NOTICE: 'ℹ️',
};

export const DEFAULT_TITLES: Record<ReviewEventType, string> = {
  SUBMITTED: '{{emoji}} Submitted for review — {{displayName}}',
  APPROVED: '{{emoji}} Approved — {{displayName}}',
  LIVE: '{{emoji}} Live on Google Play — {{displayName}}',
  REJECTED: '{{emoji}} Rejected — {{displayName}}',
  POLICY_WARNING: '{{emoji}} Policy warning — {{displayName}}',
  REMOVED: '{{emoji}} Removed from Google Play — {{displayName}}',
  SUSPENDED: '{{emoji}} Suspended — {{displayName}}',
  UNKNOWN_NOTICE: '{{emoji}} Google Play notice — {{displayName}}',
};

export const DEFAULT_BODY =
  '{{#track}}Track: {{track}}{{/track}}{{#versionLabel}} · Version: {{versionLabel}}{{/versionLabel}}\n' +
  '{{#reason}}Reason: {{reason}}\n{{/reason}}' +
  '{{#consoleUrl}}Open in Play Console → {{consoleUrl}}\n{{/consoleUrl}}' +
  'Source: {{source}} · {{observedAt}}';

export interface TemplateContext extends Record<string, unknown> {
  emoji: string;
  displayName: string;
  versionLabel: string;
  app: AppConfig | Record<string, never>;
}

export function buildContext(config: Config, event: ReviewEvent, app?: AppConfig): TemplateContext {
  const appName = event.appName ?? app?.name;
  const pkg = event.packageName ?? undefined;
  const displayName = appName && pkg ? `${appName} (${pkg})` : (appName ?? pkg ?? 'Unknown app');
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
  const override = config.templates[event.type];
  const title = renderTemplate(DEFAULT_TITLES[event.type], ctx);
  const body = renderTemplate(override ?? DEFAULT_BODY, ctx).trim();
  const fields: RenderedMessage['fields'] = [];
  if (event.packageName) fields.push({ label: 'Package', value: event.packageName });
  if (event.track) fields.push({ label: 'Track', value: event.track });
  if (ctx.versionLabel) fields.push({ label: 'Version', value: ctx.versionLabel });
  fields.push({ label: 'Source', value: `${event.source} (${event.confidence})` });
  return {
    event,
    title,
    body,
    color: EVENT_COLORS[event.type],
    mentions: config.events[event.type]?.mentions ?? [],
    fields,
  };
}
