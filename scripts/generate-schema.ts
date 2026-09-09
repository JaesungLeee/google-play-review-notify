/**
 * Generates schemas/config.schema.json and schemas/webhook-payload.schema.json from the zod schemas.
 * Run `npm run schema` after changing src/core/config.ts; CI fails when the file is stale.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { format, resolveConfig } from 'prettier';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { configSchema } from '../src/core/config';
import { REVIEW_EVENT_TYPES } from '../src/core/types';
import { webhookBodySchema } from '../src/notifiers/webhook';

const SCHEMA_BASE =
  'https://raw.githubusercontent.com/JaesungLeee/google-play-review-notify/main/schemas';
const SCHEMA_ID = `${SCHEMA_BASE}/config.schema.json`;
const WEBHOOK_SCHEMA_ID = `${SCHEMA_BASE}/webhook-payload.schema.json`;

/**
 * Config values may be `${ENV_VAR}` references that are resolved before validation, so editor
 * validators must not apply `format: uri` to them. The runtime still validates real URLs.
 */
function relaxUriFormats(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) relaxUriFormats(item);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  if (obj['type'] === 'string' && obj['format'] === 'uri') {
    delete obj['format'];
    const desc = typeof obj['description'] === 'string' ? `${obj['description']} ` : '';
    obj['description'] = `${desc}Must be a URL after \${ENV_VAR} interpolation.`;
  }
  for (const value of Object.values(obj)) relaxUriFormats(value);
}

type JsonObject = Record<string, unknown>;

/**
 * zod records keyed by an enum become `additionalProperties` + `propertyNames`, which validates
 * but gives editors nothing to complete. Expand them into explicit `properties`.
 */
function expandEventKeyedRecord(record: JsonObject): void {
  const valueSchema = record['additionalProperties'];
  record['properties'] = Object.fromEntries(REVIEW_EVENT_TYPES.map((t) => [t, valueSchema]));
  record['additionalProperties'] = false;
  delete record['propertyNames'];
}

export function buildConfigJsonSchema(): JsonObject {
  const generated = zodToJsonSchema(configSchema, {
    $refStrategy: 'none',
    effectStrategy: 'input',
    errorMessages: false,
  }) as JsonObject;
  delete generated['$schema'];
  relaxUriFormats(generated);

  const properties = generated['properties'] as Record<string, JsonObject>;
  expandEventKeyedRecord(properties['events'] as JsonObject);
  expandEventKeyedRecord(properties['templates'] as JsonObject);

  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: SCHEMA_ID,
    title: 'play-review-notify configuration',
    description:
      'Configuration file for play-review-notify (play-review-notify.yml). String values may reference environment variables as ${VAR}; they are resolved before validation.',
    type: 'object',
    properties: {
      $schema: {
        type: 'string',
        description: 'JSON Schema reference for editor support (JSON configs).',
      },
      ...properties,
    },
    required: generated['required'],
    additionalProperties: false,
  };
}

export function buildWebhookPayloadJsonSchema(): JsonObject {
  const generated = zodToJsonSchema(webhookBodySchema, {
    $refStrategy: 'none',
    errorMessages: false,
  }) as JsonObject;
  delete generated['$schema'];
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: WEBHOOK_SCHEMA_ID,
    title: 'play-review-notify webhook payload',
    ...generated,
  };
}

/** Format with the repository's Prettier settings so `format:check` agrees with the output. */
async function renderJson(value: JsonObject): Promise<string> {
  const options = (await resolveConfig(resolve(__dirname, '..', 'schemas', 'x.json'))) ?? {};
  return format(JSON.stringify(value), { ...options, parser: 'json' });
}

export async function renderConfigJsonSchema(): Promise<string> {
  return renderJson(buildConfigJsonSchema());
}

export async function renderWebhookPayloadJsonSchema(): Promise<string> {
  return renderJson(buildWebhookPayloadJsonSchema());
}

if (require.main === module) {
  const dir = resolve(__dirname, '..', 'schemas');
  Promise.all([
    renderConfigJsonSchema().then((t) => writeFileSync(resolve(dir, 'config.schema.json'), t)),
    renderWebhookPayloadJsonSchema().then((t) =>
      writeFileSync(resolve(dir, 'webhook-payload.schema.json'), t),
    ),
  ])
    .then(() => console.log(`Wrote config.schema.json and webhook-payload.schema.json to ${dir}`))
    .catch((e: unknown) => {
      console.error(e);
      process.exit(1);
    });
}
