import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv from 'ajv';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  buildConfigJsonSchema,
  buildWebhookPayloadJsonSchema,
  renderConfigJsonSchema,
  renderWebhookPayloadJsonSchema,
} from '../../scripts/generate-schema';
import { WebhookNotifier } from '../../src/notifiers/webhook';
import { renderMessage } from '../../src/templates';
import { makeConfig, makeEvent } from '../helpers';
import { parseConfig } from '../../src/core/config';

const root = resolve(__dirname, '..', '..');
const schemaPath = resolve(root, 'schemas', 'config.schema.json');
const ajv = new Ajv({ strict: false, allErrors: true });
const validate = ajv.compile(buildConfigJsonSchema());

describe('config JSON schema', () => {
  it('is checked in and up to date', async () => {
    const committed = readFileSync(schemaPath, 'utf8');
    expect(committed, 'schemas/config.schema.json is stale: run `npm run schema`').toBe(
      await renderConfigJsonSchema(),
    );
  });

  it('keeps the webhook payload schema checked in and matching real payloads', async () => {
    const committed = readFileSync(resolve(root, 'schemas', 'webhook-payload.schema.json'), 'utf8');
    expect(committed, 'schemas/webhook-payload.schema.json is stale: run `npm run schema`').toBe(
      await renderWebhookPayloadJsonSchema(),
    );
    const validatePayload = ajv.compile(buildWebhookPayloadJsonSchema());
    const config = makeConfig();
    const n = new WebhookNotifier({ runId: 'gha:1' });
    const single = JSON.parse(
      JSON.stringify(n.buildPayload(renderMessage(config, makeEvent(), config.apps[0]))),
    );
    expect(validatePayload(single), JSON.stringify(validatePayload.errors)).toBe(true);
    expect(validatePayload([single, single])).toBe(true);
    expect(validatePayload([])).toBe(false);
    expect(validatePayload({ ...single, payloadVersion: 2 })).toBe(false);
  });

  it('accepts the example config with unresolved ${ENV} references', () => {
    const raw = parseYaml(
      readFileSync(resolve(root, 'examples', 'play-review-notify.yml'), 'utf8'),
    );
    expect(validate(raw), JSON.stringify(validate.errors)).toBe(true);
  });

  it('agrees with the runtime parser on a full config', () => {
    const raw = {
      $schema: 'https://example.com/schema.json',
      version: 1,
      apps: [{ packageName: 'com.example.app', name: 'Example', tracks: ['production', 'beta'] }],
      sources: {
        email: { enabled: true, auth: { clientId: 'a', clientSecret: 'b', refreshToken: 'c' } },
        playApi: { enabled: true, serviceAccountJson: '{}', emitLiveWithoutConfirmation: true },
        storeListing: { enabled: true, locale: 'ko', country: 'KR' },
      },
      events: {
        REJECTED: { enabled: true, mentions: ['<!channel>'] },
        LIVE: { enabled: true, mergeInto: 'APPROVED' },
      },
      channels: {
        slack: { type: 'slack', webhookUrl: 'https://hooks.slack.com/services/x' },
        hook: {
          type: 'webhook',
          url: 'https://example.com/hook',
          secret: 's',
          batch: true,
          headers: { 'X-A': '1' },
        },
      },
      defaultChannels: ['slack'],
      templates: { REJECTED: '{{appName}} rejected' },
      stateStore: { type: 'github-cache', keyPrefix: 'k' },
      includeReason: false,
      maxRetries: 0,
    };
    expect(validate(raw), JSON.stringify(validate.errors)).toBe(true);
    expect(() => parseConfig(raw, {})).not.toThrow();
  });

  it.each([
    ['unknown top-level key', { apps: [{ packageName: 'a' }], colour: 'red' }],
    [
      'typo in a nested key',
      { apps: [{ packageName: 'a' }], sources: { email: { enabld: true } } },
    ],
    [
      'unknown event type',
      { apps: [{ packageName: 'a' }], events: { REJECTD: { enabled: true } } },
    ],
    [
      'unknown channel type',
      { apps: [{ packageName: 'a' }], channels: { x: { type: 'teams', webhookUrl: 'https://x' } } },
    ],
    ['missing apps', { channels: {} }],
  ])('rejects %s', (_name, raw) => {
    expect(validate(raw)).toBe(false);
  });
});
