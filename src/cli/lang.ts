/**
 * The `lang` command: show the language in effect and where it came from, save one so that every
 * later command uses it, or forget the saved one. Confirmations are printed in the language that
 * is in effect after the command, so `lang ko` answers in Korean.
 */
import {
  messages,
  parseLang,
  unknownLangError,
  type Lang,
  type LangResolution,
  type LangSource,
} from './i18n';
import { writePrefs } from './prefs';

export type LangAction = 'show' | 'save' | 'reset';

export interface LangCommandInput {
  /** The language to save; omitted to show the current one. */
  value?: string | undefined;
  /** Forget the saved language instead. */
  reset?: boolean | undefined;
  /** The language this run resolved to, before the command. */
  current: LangResolution;
  prefsPath: string;
}

export interface LangCommandResult {
  action: LangAction;
  /** The language in effect after the command. */
  lang: Lang;
  source: LangSource;
  path: string;
}

export function runLangCommand(input: LangCommandInput): LangCommandResult {
  const { current, prefsPath: path } = input;
  if (input.reset) {
    writePrefs(path, { lang: undefined });
    const after: LangResolution =
      current.source === 'saved' ? { lang: 'en', source: 'default' } : current;
    return { action: 'reset', ...after, path };
  }
  if (input.value === undefined) return { action: 'show', ...current, path };
  const lang = parseLang(input.value);
  if (!lang) throw unknownLangError(input.value, 'lang');
  writePrefs(path, { lang });
  return { action: 'save', lang, source: 'saved', path };
}

/** `uiLang` is the language the user was reading before the command ran. */
export function formatLangResult(result: LangCommandResult, uiLang: Lang): string {
  const m = messages(result.action === 'save' ? result.lang : uiLang).cli;
  const name = m.langNames[result.lang];
  switch (result.action) {
    case 'save':
      return m.langSaved(name, result.path);
    case 'reset':
      return m.langCleared(result.path);
    case 'show': {
      const from =
        result.source === 'saved' ? m.langFrom.saved(result.path) : m.langFrom[result.source];
      const line = `${result.lang} (${name}): ${from}`;
      // Only suggest saving when nothing decided the language on purpose.
      return result.source === 'default' ? `${line}\n${m.langHowToSave}` : line;
    }
  }
}
