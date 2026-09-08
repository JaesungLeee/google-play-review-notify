/**
 * Minimal Mustache-compatible renderer: `{{path.to.value}}` and `{{#key}}...{{/key}}` sections.
 * No HTML escaping (messages go to chat tools, not browsers). Missing values render as ''.
 */

type Ctx = Record<string, unknown>;

function lookup(ctx: Ctx, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key];
    return undefined;
  }, ctx);
}

const SECTION = /\{\{#([\w.]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g;
const INVERTED = /\{\{\^([\w.]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g;
const VAR = /\{\{\s*([\w.]+)\s*\}\}/g;

export function renderTemplate(template: string, ctx: Ctx): string {
  let out = template;
  // Truthy sections first, then inverted, then plain variables.
  out = out.replace(SECTION, (_m, key: string, inner: string) => {
    const v = lookup(ctx, key);
    if (!v || (Array.isArray(v) && v.length === 0)) return '';
    return renderTemplate(inner, ctx);
  });
  out = out.replace(INVERTED, (_m, key: string, inner: string) => {
    const v = lookup(ctx, key);
    if (!v || (Array.isArray(v) && v.length === 0)) return renderTemplate(inner, ctx);
    return '';
  });
  out = out.replace(VAR, (_m, key: string) => {
    const v = lookup(ctx, key);
    if (v === undefined || v === null) return '';
    return typeof v === 'string' ? v : String(v);
  });
  return out;
}
