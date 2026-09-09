/**
 * Generates schemas/config.schema.json from the zod config schema.
 * Run `npm run schema` after changing src/core/config.ts; CI fails when the file is stale.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { format } from 'prettier';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { configSchema } from '../src/core/config';
import { REVIEW_EVENT_TYPES } from '../src/core/types';

const SCHEMA_ID =
  'https://raw.githubusercontent.com/JaesungLeee/google-play-review-notify/main/schemas/config.schema.json';

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

export async function renderConfigJsonSchema(): Promise<string> {
  return format(JSON.stringify(buildConfigJsonSchema()), { parser: 'json' });
}

if (require.main === module) {
  const out = resolve(__dirname, '..', 'schemas', 'config.schema.json');
  renderConfigJsonSchema()
    .then((text) => {
      writeFileSync(out, text);
      console.log(`Wrote ${out}`);
    })
    .catch((e: unknown) => {
      console.error(e);
      process.exit(1);
    });
}
