/**
 * CLI language selection and message tables.
 *
 * The language is decided once, before the commander program is built, so that help text is
 * localized too. Precedence: `--lang`, then `$PLAY_REVIEW_NOTIFY_LANG`, then the language saved in
 * the user's preferences file (see ./prefs), then a one-question gate in an interactive terminal,
 * then English. The gate's answer is saved, so it is asked once per user; the `lang` command shows
 * or changes it. The gate is skipped for `--json` (machine output), `--version`, the `lang`
 * command itself, and whenever stdin or stdout is not a TTY, so cron jobs and CI never block on it.
 *
 * Only CLI-facing text is translated. Core log lines, generated config files, and the JSON output
 * stay in English so that scripts and documentation can rely on them.
 */

export type Lang = 'en' | 'ko';
export const LANGS: readonly Lang[] = ['en', 'ko'];
export const LANG_ENV = 'PLAY_REVIEW_NOTIFY_LANG';

export class LangError extends Error {
  override name = 'LangError';
}

/** Accepts option values, gate answers, and a few spellings people are likely to type. */
export function parseLang(raw: string): Lang | undefined {
  const v = raw.trim().toLowerCase();
  if (['1', 'en', 'eng', 'english', '영어'].includes(v)) return 'en';
  if (['2', 'ko', 'kr', 'kor', 'korean', '한국어', '한글'].includes(v)) return 'ko';
  return undefined;
}

export function unknownLangError(raw: string, where: string): LangError {
  return new LangError(
    `${where}: unknown language "${raw}". Use one of: ${LANGS.join(', ')}\n` +
      `${where}: 알 수 없는 언어 "${raw}". 다음 중 하나를 사용하세요: ${LANGS.join(', ')}`,
  );
}

/** `--lang ko` or `--lang=ko`, anywhere in the arguments (it is a global option). */
export function langFromArgv(argv: readonly string[]): Lang | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') return undefined;
    let raw: string | undefined;
    if (arg === '--lang') raw = argv[i + 1];
    else if (arg.startsWith('--lang=')) raw = arg.slice('--lang='.length);
    else continue;
    if (raw === undefined) throw unknownLangError('', '--lang');
    const lang = parseLang(raw);
    if (!lang) throw unknownLangError(raw, '--lang');
    return lang;
  }
  return undefined;
}

export function langFromEnv(env: NodeJS.ProcessEnv): Lang | undefined {
  const raw = env[LANG_ENV];
  if (raw === undefined || raw.trim() === '') return undefined;
  const lang = parseLang(raw);
  if (!lang) throw unknownLangError(raw, LANG_ENV);
  return lang;
}

/** The gate's default answer follows the system locale (LC_ALL, LC_MESSAGES, LANG). */
export function systemLang(env: NodeJS.ProcessEnv): Lang {
  const locale = env['LC_ALL'] || env['LC_MESSAGES'] || env['LANG'] || '';
  return /^ko(?![a-z])/i.test(locale) ? 'ko' : 'en';
}

/** Global options that take a value; `commandOf` must skip the value too. */
const GLOBAL_VALUE_OPTIONS = new Set(['-c', '--config', '--lang']);

/** The subcommand named on the command line, ignoring global options; undefined if none. */
export function commandOf(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') return undefined;
    if (GLOBAL_VALUE_OPTIONS.has(arg)) i++;
    else if (!arg.startsWith('-')) return arg;
  }
  return undefined;
}

/**
 * Arguments for which asking a language question would be pointless or harmful: machine output,
 * the version banner, and the `lang` command (which manages the language itself).
 */
export function skipsGate(argv: readonly string[]): boolean {
  return (
    argv.some((a) => a === '--json' || a === '--version' || a === '-V') ||
    commandOf(argv) === 'lang'
  );
}

export interface GateIo {
  ask(prompt: string): Promise<string>;
  out(text: string): void;
}

/** The language gate: a bilingual question asked before anything else in a terminal. */
export async function promptLang(io: GateIo, defaultLang: Lang): Promise<Lang> {
  io.out('Language / 언어\n  1) English\n  2) 한국어\n');
  for (;;) {
    const raw = (await io.ask(`Choose / 선택 [${defaultLang === 'ko' ? '2' : '1'}]: `)).trim();
    if (raw === '') return defaultLang;
    const lang = parseLang(raw);
    if (lang) return lang;
    io.out('Please enter 1 or 2. / 1 또는 2를 입력하세요.\n');
  }
}

/** Where the language came from; `gate` answers are saved by the caller, `option` ones are not. */
export type LangSource = 'option' | 'env' | 'saved' | 'gate' | 'default';

export interface LangResolution {
  lang: Lang;
  source: LangSource;
}

export interface ResolveLangInput {
  /** Arguments after the executable and script (process.argv.slice(2)). */
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  /** The language from the user's preferences file, if any. */
  saved?: Lang | undefined;
  /** Both stdin and stdout are TTYs. */
  interactive: boolean;
  /** Runs the gate; only called when nothing else decided the language. */
  gate: (defaultLang: Lang) => Promise<Lang>;
}

export async function resolveLang(input: ResolveLangInput): Promise<LangResolution> {
  const option = langFromArgv(input.argv);
  if (option) return { lang: option, source: 'option' };
  const env = langFromEnv(input.env);
  if (env) return { lang: env, source: 'env' };
  if (input.saved) return { lang: input.saved, source: 'saved' };
  if (!input.interactive || skipsGate(input.argv)) return { lang: 'en', source: 'default' };
  return { lang: await input.gate(systemLang(input.env)), source: 'gate' };
}

const DOCS_URL = 'https://github.com/JaesungLeee/google-play-review-notify/blob/main/docs';

const en = {
  /** File names under docs/ (the Korean table points at the translated pages). */
  docs: { gmailOauth: 'gmail-oauth.md', playApiSetup: 'play-api-setup.md' },
  docsUrl: DOCS_URL,
  help: {
    titles: {
      'Usage:': 'Usage:',
      'Arguments:': 'Arguments:',
      'Options:': 'Options:',
      'Global Options:': 'Global Options:',
      'Commands:': 'Commands:',
    } as Record<string, string>,
    helpOption: 'display help for command',
    helpCommand: 'display help for command',
    versionOption: 'output the version number',
    /** commander appends "(default: x)" to option descriptions; this is its label. */
    defaultLabel: 'default: ',
  },
  cli: {
    description: 'Detect Google Play review outcomes and notify Slack, Discord, or any webhook.',
    optConfig: 'config file (YAML or JSON)',
    optJson: 'structured JSON logs and output',
    optVerbose: 'debug logging',
    optLang: `output language for this run: ${LANGS.join(' | ')} (overrides the saved language and $${LANG_ENV})`,
    run: 'Poll all enabled sources once, notify, and exit',
    runDryRun: 'render messages but do not send or save state',
    runStateStore: 'override state store: file | none',
    runDone: (events: number, delivered: number, baseline: boolean) =>
      `Done: ${events} new event(s), ${delivered} delivered` +
      (baseline ? ' (baseline run, notifications suppressed)' : ''),
    testNotify: 'Send a sample event to configured channels',
    optEventType: 'event type',
    optPackageDefault: 'package name (defaults to first app in config)',
    testReason: 'This is a test notification from google-play-review-notify.',
    channelMissing: (name: string) => `Channel ${name} is missing or has no notifier`,
    sentTest: (type: string, name: string) => `Sent test ${type} to ${name}`,
    sendFailed: (name: string, err: string) => `Failed to send to ${name}: ${err}`,
    emit: 'Emit an event from an external pipeline (e.g. SUBMITTED right after upload)',
    optPackage: 'package name',
    optTrack: 'track',
    optVersionCode: 'version code',
    optVersionName: 'version name',
    emitDryRun: 'do not send or save state',
    state: 'Inspect or reset persisted state',
    stateShow: 'Print the persisted state as JSON',
    stateReset: 'Forget all state; the next run records a fresh baseline',
    stateResetUnsupported: 'state reset is only supported for the file state store in this version',
    stateRemoved: 'State removed',
    doctor: 'Check config, credentials, sources, channels, and state store without sending',
    init: 'Create play-review-notify.yml (and a GitHub workflow) by answering a few questions',
    initPackages: 'comma-separated package names (skips the prompt)',
    initTarget: (choices: string) => `${choices} (skips the prompt)`,
    initSources: (choices: string) => `comma-separated: ${choices} (skips the prompts)`,
    initChannel: (choices: string) => `${choices} (skips the prompt)`,
    initWorkflowPath: 'workflow file to create',
    initYes: 'no prompts; use flags and defaults',
    initForce: 'overwrite existing files',
    initFailed: (err: string) => `init failed: ${err}`,
    auth: (doc: string) => `Obtain an OAuth refresh token (one-time setup). See docs/${doc}`,
    authProvider: 'gmail',
    authClientId: 'OAuth client id (default: $GMAIL_CLIENT_ID)',
    authClientSecret: 'OAuth client secret (default: $GMAIL_CLIENT_SECRET)',
    authPort: 'local callback port (default: a free port)',
    authNoOpen: 'print the consent URL instead of opening a browser',
    unknownProvider: (p: string) => `Unknown provider "${p}". Supported: gmail`,
    missingOauthClient: (doc: string) =>
      'Missing OAuth client. Pass --client-id/--client-secret or set GMAIL_CLIENT_ID and ' +
      `GMAIL_CLIENT_SECRET (create a "Desktop app" OAuth client; see docs/${doc}).`,
    openingBrowser: 'Opening your browser. If it does not open, visit:',
    visit: 'Visit:',
    waitingRedirect: 'Waiting for Google to redirect back to this machine...',
    authorized: (email: string | undefined) =>
      `\nAuthorized${email ? ` as ${email}` : ''}. Add this to your environment or CI secrets:\n`,
    keepSecret:
      '\nKeep it secret. If the OAuth consent screen is still in "Testing", the token ' +
      'expires after 7 days; publish the app to production to make it permanent.',
    authFailed: (err: string) => `auth gmail failed: ${err}`,
    lang: 'Show or save the output language used by every command',
    langArg: `${LANGS.join(' | ')}; omit to show the current language`,
    langReset: 'forget the saved language; a terminal asks again next time',
    langNames: { en: 'English', ko: '한국어' } as Record<Lang, string>,
    langFrom: {
      option: 'from --lang, for this run only',
      env: `from $${LANG_ENV}`,
      saved: (path: string) => `saved in ${path}`,
      gate: 'chosen in the terminal, for this run only',
      default: 'default; nothing saved yet',
    },
    langHowToSave: 'Save one for every command with: play-review-notify lang en|ko',
    langSaved: (name: string, path: string) =>
      `Language set to ${name}. Saved in ${path}; every command uses it from now on ` +
      '(override a single run with --lang).',
    langCleared: (path: string) =>
      `Saved language removed from ${path}. A terminal asks again next time; other runs use English.`,
    langSaveFailed: (path: string, err: string) => `Could not save the language to ${path}: ${err}`,
    langGateSaved: (path: string) =>
      `Saved in ${path}. Change it any time with: play-review-notify lang en|ko`,
  },
  init: {
    choiceKinds: { target: 'target', channel: 'channel', source: 'source' } as Record<
      'target' | 'channel' | 'source',
      string
    >,
    invalidPackage: (n: string) =>
      `"${n}" is not a valid Android package name (e.g. com.example.app)`,
    unknownChoice: (what: string, raw: string, allowed: string) =>
      `Unknown ${what} "${raw}". Choose one of: ${allowed}`,
    answerYesNo: (raw: string) => `Please answer y or n (got "${raw}")`,
    askPackages: 'Package name(s), comma-separated',
    noPackages:
      'No package name given. Pass --packages com.example.app (comma-separated for several).',
    askDisplayName: (pkg: string) => `Display name for ${pkg} as shown in Play Console`,
    askTarget: 'Where will this run? (github-actions | cli)',
    askEmail:
      'Watch the Play Console inbox via Gmail for policy warnings and rejection reasons? (y/n)',
    askPlayApi:
      'Use the Play Developer API to track releases (submitted, approved, rejected, live)? (needs a service account) (y/n)',
    noSources: 'At least one source must be enabled (email, play-api).',
    askChannel: 'Notification channel (slack | discord | webhook)',
    stepGmail: 'Create a Gmail OAuth client and refresh token (one-time, about 10 minutes):',
    stepGmailAuthComment: 'prints GMAIL_REFRESH_TOKEN',
    stepPlayApi: 'Create a Play service account with read-only access and download its key:',
    stepChannel: {
      slack: 'Create a Slack Incoming Webhook: https://api.slack.com/messaging/webhooks',
      discord: 'Create a Discord webhook: Server settings → Integrations → Webhooks',
      webhook: 'Point WEBHOOK_URL at your receiver (n8n, Make, Zapier, your server)',
    } as Record<'slack' | 'discord' | 'webhook', string>,
    stepSecrets: 'Add the secrets to your repository (Settings → Secrets and variables → Actions):',
    stepVerifyBeforeSchedule: 'Verify locally before the first scheduled run:',
    stepCommit: (config: string, workflow: string | undefined) =>
      `Commit ${config}${workflow ? ` and ${workflow}` : ''} and push.`,
    stepCommitBaseline: 'The first run only records a baseline; later runs notify.',
    stepCommitTrigger: 'Trigger one manually from the Actions tab to check it is green.',
    stepExportVerify: 'Export the variables and verify:',
    stepSchedule: 'Schedule `run` (the first run only records a baseline):',
    stepGitignore: 'Add .play-review-notify/ to .gitignore if this directory is a repository.',
    alreadyExists: (rel: string) => `${rel} already exists. Use --force to overwrite it.`,
    wrote: (files: string) => `\nWrote ${files}\n`,
    keptExisting: (file: string) => `Kept existing ${file} (use --force to overwrite)\n`,
    nextSteps: '\nNext steps:\n',
  },
  doctor: {
    nodeOk: (v: string) => `Node.js ${v}`,
    nodeTooOld: (v: string) => `Node.js ${v} is too old`,
    nodeHint: 'Node.js 20 or newer is required.',
    apps: (n: number, list: string) => `${n} app(s): ${list}`,
    sourcesEnabled: (list: string) => `Sources enabled: ${list}`,
    noSource: 'No source is enabled',
    noSourceHint:
      'Enable sources.playApi (release states) and/or sources.email (policy warnings, rejection reasons).',
    emailOff: 'Email source is off, so POLICY_WARNING and rejection reasons will not be detected',
    emailOffHint: (doc: string) =>
      `Policy warnings and the reason for a rejection only arrive by email. See docs/${doc}.`,
    playOff:
      'Play API source is off, so SUBMITTED, APPROVED, REJECTED and LIVE will not be detected',
    playOffHint: (doc: string) =>
      `Release states come from the Play Developer API release lifecycle. See docs/${doc}.`,
    eventsOn: (list: string) => `Events on: ${list}`,
    noChannelFor: (list: string) => `No channel for: ${list}`,
    noChannelForHint:
      'Set apps[].channels or defaultChannels; events for these apps are detected but go nowhere.',
    emailDisabled: 'Email source disabled',
    emailAuthMissing: 'sources.email.auth is missing',
    emailAuthMissingHint: 'Set clientId, clientSecret and refreshToken (run `auth gmail`).',
    authorizedAs: (email: string) => `Authorized as ${email}`,
    gmailAccepted: 'Gmail credentials accepted',
    gmailAuthFailed: (err: string) => `Gmail auth failed: ${err}`,
    gmailEmails: (n: number, days: number) => `${n} Google Play email(s) in the last ${days} days`,
    gmailNoEmails: (days: number) => `No Google Play emails in the last ${days} days`,
    gmailNoEmailsHint:
      'Normal for a quiet account. If Play emails do arrive, check that this is the mailbox that receives them and that Play Console email notifications are on.',
    gmailSearchFailed: (err: string) => `Gmail search failed: ${err}`,
    gmailHintExpired:
      'The refresh token is expired or revoked. If the OAuth consent screen is in "Testing", tokens expire after 7 days: publish it, then run `auth gmail` again.',
    gmailHintClient:
      'Client id or secret is wrong. Copy them again from Google Cloud → Credentials.',
    gmailHintScope:
      'The token lacks gmail.readonly. Run `auth gmail` again and accept the permission.',
    gmailHintApi: (doc: string) =>
      `Enable the Gmail API in the Cloud project (docs/${doc}, step 1).`,
    gmailHintDefault: (doc: string) => `See docs/${doc}, "Troubleshooting".`,
    playDisabled: 'Play API source disabled',
    playKeyMissing: 'sources.playApi.serviceAccountJson is missing',
    playKeyMissingHint: (doc: string) => `Provide the service account key JSON (docs/${doc}).`,
    playKeyUnreadable: (err: string) => `Service account key could not be read: ${err}`,
    playKeyUnreadableHint:
      'serviceAccountJson must be the key JSON content or a path to the key file.',
    playTracks: (pkg: string, summary: string) => `${pkg}: ${summary}`,
    playTracksFailed: (list: string) =>
      `Track(s) that could not be listed: ${list}. Check apps[].tracks and the app permissions.`,
    playHintApi: (doc: string) =>
      `Enable the Google Play Android Developer API in the Cloud project (docs/${doc}, step 1).`,
    playHintPermission:
      'Invite the service account in Play Console → Users and permissions with "View app information (read-only)" for this app. Propagation can take several minutes.',
    playHintNotFound:
      'The developer account that the service account was invited to does not own this package.',
    playHintKey: 'The key JSON is corrupted or the system clock is off. Re-download the key.',
    playHintDefault: (doc: string) => `See docs/${doc}, "Troubleshooting".`,
    noChannels: 'No channels configured; events will be detected but not delivered',
    noChannelsHint: 'Add channels (slack, discord, webhook) and defaultChannels.',
    slackUrlHint: 'Slack Incoming Webhook URLs start with https://hooks.slack.com/services/.',
    discordUrlHint: 'Discord webhook URLs start with https://discord.com/api/webhooks/.',
    httpsHint: 'Use an https:// URL.',
    channel: (name: string, type: string, unusual: boolean) =>
      `${name}: ${type}${unusual ? ' (unusual URL)' : ''}`,
    channelHintSuffix: 'Run `test-notify` to send a real test message.',
    fileStore: (path: string, exists: boolean) =>
      `file store at ${path}${exists ? '' : ' (no state yet: the first run records a baseline)'}`,
    fileStoreFailed: (err: string) => `file store: ${err}`,
    fileStoreFailedHint: 'The directory must be writable.',
    cacheStore: 'github-cache store (Actions cache)',
    cacheStoreOutside: 'github-cache store selected outside GitHub Actions',
    cacheStoreOutsideHint: 'Use stateStore.type: file for local or cron runs.',
    noneStore: 'no state store: every run is a baseline and nothing is ever notified',
    noneStoreHint: 'Use file or github-cache for real runs.',
    customStoreLoads: (module: string) => `custom store module ${module} loads`,
    customStoreFailed: (err: string) => `custom store: ${err}`,
    summaryProblems: (fails: number, warns: number) => `${fails} problem(s), ${warns} warning(s)`,
    summaryAllGood: (warns: number) => `All good, ${warns} warning(s)`,
  },
};

export type Messages = typeof en;

const ko: Messages = {
  docs: { gmailOauth: 'gmail-oauth.ko.md', playApiSetup: 'play-api-setup.ko.md' },
  docsUrl: DOCS_URL,
  help: {
    titles: {
      'Usage:': '사용법:',
      'Arguments:': '인자:',
      'Options:': '옵션:',
      'Global Options:': '전역 옵션:',
      'Commands:': '명령어:',
    },
    helpOption: '명령어 도움말 표시',
    helpCommand: '명령어 도움말 표시',
    versionOption: '버전 출력',
    defaultLabel: '기본값: ',
  },
  cli: {
    description: 'Google Play 검토 결과를 감지해 Slack, Discord 또는 웹훅으로 알립니다.',
    optConfig: '설정 파일 (YAML 또는 JSON)',
    optJson: 'JSON 형식의 구조화된 로그와 출력',
    optVerbose: '디버그 로그 출력',
    optLang: `이번 실행의 출력 언어: ${LANGS.join(' | ')} (저장된 언어와 $${LANG_ENV}보다 우선)`,
    run: '활성화된 모든 소스를 한 번 폴링하고 알린 뒤 종료',
    runDryRun: '메시지를 렌더링만 하고 전송이나 상태 저장은 하지 않음',
    runStateStore: '상태 저장소 재정의: file | none',
    runDone: (events, delivered, baseline) =>
      `완료: 새 이벤트 ${events}건, ${delivered}건 전송` +
      (baseline ? ' (기준선 실행이라 알림은 보내지 않음)' : ''),
    testNotify: '설정된 채널로 샘플 이벤트 전송',
    optEventType: '이벤트 유형',
    optPackageDefault: '패키지 이름 (기본값: 설정의 첫 번째 앱)',
    testReason: 'google-play-review-notify에서 보낸 테스트 알림입니다.',
    channelMissing: (name) => `채널 ${name}이(가) 없거나 알림 전송기가 없습니다`,
    sentTest: (type, name) => `${name}에 테스트 ${type} 전송 완료`,
    sendFailed: (name, err) => `${name} 전송 실패: ${err}`,
    emit: '외부 파이프라인에서 이벤트 발생 (예: 업로드 직후 SUBMITTED)',
    optPackage: '패키지 이름',
    optTrack: '트랙',
    optVersionCode: '버전 코드',
    optVersionName: '버전 이름',
    emitDryRun: '전송이나 상태 저장을 하지 않음',
    state: '저장된 상태 확인 또는 초기화',
    stateShow: '저장된 상태를 JSON으로 출력',
    stateReset: '모든 상태를 잊고 다음 실행에서 기준선을 새로 기록',
    stateResetUnsupported: '이 버전에서 state reset은 file 상태 저장소에서만 지원됩니다',
    stateRemoved: '상태를 삭제했습니다',
    doctor: '설정·인증·소스·채널·상태 저장소를 전송 없이 점검',
    init: '몇 가지 질문에 답해 play-review-notify.yml(과 GitHub 워크플로우) 생성',
    initPackages: '쉼표로 구분한 패키지 이름 (질문 생략)',
    initTarget: (choices) => `${choices} (질문 생략)`,
    initSources: (choices) => `쉼표로 구분: ${choices} (질문 생략)`,
    initChannel: (choices) => `${choices} (질문 생략)`,
    initWorkflowPath: '생성할 워크플로우 파일',
    initYes: '질문 없이 플래그와 기본값 사용',
    initForce: '기존 파일 덮어쓰기',
    initFailed: (err) => `init 실패: ${err}`,
    auth: (doc) => `OAuth 리프레시 토큰 발급 (최초 1회). docs/${doc} 참고`,
    authProvider: 'gmail',
    authClientId: 'OAuth 클라이언트 ID (기본값: $GMAIL_CLIENT_ID)',
    authClientSecret: 'OAuth 클라이언트 시크릿 (기본값: $GMAIL_CLIENT_SECRET)',
    authPort: '로컬 콜백 포트 (기본값: 빈 포트)',
    authNoOpen: '브라우저를 열지 않고 동의 URL만 출력',
    unknownProvider: (p) => `알 수 없는 제공자 "${p}". 지원: gmail`,
    missingOauthClient: (doc) =>
      'OAuth 클라이언트가 없습니다. --client-id/--client-secret을 넘기거나 GMAIL_CLIENT_ID와 ' +
      `GMAIL_CLIENT_SECRET을 설정하세요 ("데스크톱 앱" OAuth 클라이언트 생성; docs/${doc} 참고).`,
    openingBrowser: '브라우저를 엽니다. 열리지 않으면 다음 주소로 접속하세요:',
    visit: '다음 주소로 접속하세요:',
    waitingRedirect: 'Google이 이 컴퓨터로 리디렉션하기를 기다리는 중...',
    authorized: (email) =>
      `\n인증 완료${email ? ` (${email})` : ''}. 아래 값을 환경 변수나 CI 시크릿에 추가하세요:\n`,
    keepSecret:
      '\n이 값은 비밀로 유지하세요. OAuth 동의 화면이 아직 "테스트" 상태라면 토큰은 7일 뒤 만료됩니다. ' +
      '앱을 프로덕션으로 게시하면 영구적으로 유지됩니다.',
    authFailed: (err) => `auth gmail 실패: ${err}`,
    lang: '모든 명령에 적용되는 출력 언어 확인·저장',
    langArg: `${LANGS.join(' | ')}; 생략하면 현재 언어 표시`,
    langReset: '저장된 언어를 지움; 터미널에서는 다음에 다시 질문',
    langNames: { en: 'English', ko: '한국어' },
    langFrom: {
      option: '이번 실행에만 적용되는 --lang',
      env: `$${LANG_ENV}`,
      saved: (path) => `${path}에 저장됨`,
      gate: '이번 실행에서 터미널로 선택',
      default: '기본값; 아직 저장된 언어 없음',
    },
    langHowToSave: '모든 명령에 적용하려면: play-review-notify lang en|ko',
    langSaved: (name, path) =>
      `언어를 ${name}(으)로 설정했습니다. ${path}에 저장되어 이제 모든 명령에 적용됩니다 ` +
      '(한 번만 바꾸려면 --lang).',
    langCleared: (path) =>
      `${path}의 저장된 언어를 지웠습니다. 터미널에서는 다음에 다시 묻고, 그 외에는 영어로 출력합니다.`,
    langSaveFailed: (path, err) => `언어를 ${path}에 저장하지 못했습니다: ${err}`,
    langGateSaved: (path) => `${path}에 저장했습니다. 언제든 변경: play-review-notify lang en|ko`,
  },
  init: {
    choiceKinds: { target: '실행 대상', channel: '채널', source: '소스' },
    invalidPackage: (n) =>
      `"${n}"은(는) 올바른 Android 패키지 이름이 아닙니다 (예: com.example.app)`,
    unknownChoice: (what, raw, allowed) =>
      `알 수 없는 ${what} "${raw}". 다음 중 하나를 선택하세요: ${allowed}`,
    answerYesNo: (raw) => `y 또는 n으로 답해 주세요 (입력값: "${raw}")`,
    askPackages: '패키지 이름 (여러 개면 쉼표로 구분)',
    noPackages:
      '패키지 이름이 없습니다. --packages com.example.app 형태로 넘기세요 (여러 개면 쉼표로 구분).',
    askDisplayName: (pkg) => `Play Console에 표시되는 ${pkg}의 앱 이름`,
    askTarget: '어디에서 실행하나요? (github-actions | cli)',
    askEmail: 'Gmail로 Play Console 메일함을 감시해 정책 경고와 거부 사유를 감지할까요? (y/n)',
    askPlayApi:
      'Play Developer API로 릴리스 상태(제출·승인·거부·출시)를 추적할까요? (서비스 계정 필요) (y/n)',
    noSources: '소스를 하나 이상 활성화해야 합니다 (email, play-api).',
    askChannel: '알림 채널 (slack | discord | webhook)',
    stepGmail: 'Gmail OAuth 클라이언트와 리프레시 토큰을 만듭니다 (최초 1회, 약 10분):',
    stepGmailAuthComment: 'GMAIL_REFRESH_TOKEN을 출력',
    stepPlayApi: '읽기 전용 권한의 Play 서비스 계정을 만들고 키를 내려받습니다:',
    stepChannel: {
      slack: 'Slack Incoming Webhook을 만듭니다: https://api.slack.com/messaging/webhooks',
      discord: 'Discord 웹훅을 만듭니다: 서버 설정 → 연동 → 웹훅',
      webhook: 'WEBHOOK_URL을 수신 서버(n8n, Make, Zapier, 직접 만든 서버)로 지정합니다',
    },
    stepSecrets: '저장소에 시크릿을 추가합니다 (Settings → Secrets and variables → Actions):',
    stepVerifyBeforeSchedule: '첫 예약 실행 전에 로컬에서 확인합니다:',
    stepCommit: (config, workflow) =>
      `${config}${workflow ? `와 ${workflow}` : ''}을(를) 커밋하고 푸시합니다.`,
    stepCommitBaseline: '첫 실행은 기준선만 기록하고, 이후 실행부터 알립니다.',
    stepCommitTrigger: 'Actions 탭에서 수동으로 한 번 실행해 성공하는지 확인하세요.',
    stepExportVerify: '환경 변수를 내보내고 확인합니다:',
    stepSchedule: '`run`을 예약합니다 (첫 실행은 기준선만 기록):',
    stepGitignore: '이 디렉터리가 저장소라면 .play-review-notify/를 .gitignore에 추가하세요.',
    alreadyExists: (rel) => `${rel}이(가) 이미 있습니다. 덮어쓰려면 --force를 사용하세요.`,
    wrote: (files) => `\n생성: ${files}\n`,
    keptExisting: (file) => `기존 ${file} 유지 (덮어쓰려면 --force)\n`,
    nextSteps: '\n다음 단계:\n',
  },
  doctor: {
    nodeOk: (v) => `Node.js ${v}`,
    nodeTooOld: (v) => `Node.js ${v}은(는) 너무 오래되었습니다`,
    nodeHint: 'Node.js 20 이상이 필요합니다.',
    apps: (n, list) => `앱 ${n}개: ${list}`,
    sourcesEnabled: (list) => `활성 소스: ${list}`,
    noSource: '활성화된 소스가 없습니다',
    noSourceHint:
      'sources.playApi(릴리스 상태) 또는 sources.email(정책 경고, 거부 사유)을 활성화하세요.',
    emailOff: '이메일 소스가 꺼져 있어 POLICY_WARNING과 거부 사유를 감지하지 못합니다',
    emailOffHint: (doc) =>
      `정책 경고와 거부 사유는 이메일로만 통보됩니다. docs/${doc}를 참고하세요.`,
    playOff: 'Play API 소스가 꺼져 있어 SUBMITTED, APPROVED, REJECTED, LIVE를 감지하지 못합니다',
    playOffHint: (doc) => `릴리스 상태는 Play Developer API에서 옵니다. docs/${doc}를 참고하세요.`,
    eventsOn: (list) => `활성 이벤트: ${list}`,
    noChannelFor: (list) => `채널이 없는 앱: ${list}`,
    noChannelForHint:
      'apps[].channels 또는 defaultChannels를 설정하세요. 이 앱들의 이벤트는 감지되지만 어디로도 전달되지 않습니다.',
    emailDisabled: '이메일 소스 비활성화됨',
    emailAuthMissing: 'sources.email.auth가 없습니다',
    emailAuthMissingHint: 'clientId, clientSecret, refreshToken을 설정하세요 (`auth gmail` 실행).',
    authorizedAs: (email) => `${email}으로 인증됨`,
    gmailAccepted: 'Gmail 자격 증명 확인됨',
    gmailAuthFailed: (err) => `Gmail 인증 실패: ${err}`,
    gmailEmails: (n, days) => `최근 ${days}일간 Google Play 메일 ${n}건`,
    gmailNoEmails: (days) => `최근 ${days}일간 Google Play 메일이 없습니다`,
    gmailNoEmailsHint:
      '조용한 계정이라면 정상입니다. Play 메일이 오는데도 없다면 이 메일함이 실제 수신함인지, Play Console 이메일 알림이 켜져 있는지 확인하세요.',
    gmailSearchFailed: (err) => `Gmail 검색 실패: ${err}`,
    gmailHintExpired:
      '리프레시 토큰이 만료되었거나 취소되었습니다. OAuth 동의 화면이 "테스트" 상태면 토큰은 7일 뒤 만료됩니다. 게시한 뒤 `auth gmail`을 다시 실행하세요.',
    gmailHintClient:
      '클라이언트 ID 또는 시크릿이 잘못되었습니다. Google Cloud → 사용자 인증 정보에서 다시 복사하세요.',
    gmailHintScope:
      '토큰에 gmail.readonly 권한이 없습니다. `auth gmail`을 다시 실행하고 권한을 허용하세요.',
    gmailHintApi: (doc) => `Cloud 프로젝트에서 Gmail API를 사용 설정하세요 (docs/${doc}, 1단계).`,
    gmailHintDefault: (doc) => `docs/${doc}의 "문제 해결"을 참고하세요.`,
    playDisabled: 'Play API 소스 비활성화됨',
    playKeyMissing: 'sources.playApi.serviceAccountJson이 없습니다',
    playKeyMissingHint: (doc) => `서비스 계정 키 JSON을 지정하세요 (docs/${doc}).`,
    playKeyUnreadable: (err) => `서비스 계정 키를 읽을 수 없습니다: ${err}`,
    playKeyUnreadableHint: 'serviceAccountJson은 키 JSON 내용이거나 키 파일 경로여야 합니다.',
    playTracks: (pkg, summary) => `${pkg}: ${summary}`,
    playTracksFailed: (list) =>
      `조회하지 못한 트랙: ${list}. apps[].tracks와 앱 권한을 확인하세요.`,
    playHintApi: (doc) =>
      `Cloud 프로젝트에서 Google Play Android Developer API를 사용 설정하세요 (docs/${doc}, 1단계).`,
    playHintPermission:
      'Play Console → 사용자 및 권한에서 이 앱에 대해 "앱 정보 보기(읽기 전용)" 권한으로 서비스 계정을 초대하세요. 반영에 몇 분 걸릴 수 있습니다.',
    playHintNotFound: '서비스 계정을 초대한 개발자 계정이 이 패키지를 소유하고 있지 않습니다.',
    playHintKey: '키 JSON이 손상되었거나 시스템 시계가 맞지 않습니다. 키를 다시 내려받으세요.',
    playHintDefault: (doc) => `docs/${doc}의 "문제 해결"을 참고하세요.`,
    noChannels: '설정된 채널이 없습니다. 이벤트는 감지되지만 전달되지 않습니다',
    noChannelsHint: 'channels(slack, discord, webhook)와 defaultChannels를 추가하세요.',
    slackUrlHint: 'Slack Incoming Webhook URL은 https://hooks.slack.com/services/로 시작합니다.',
    discordUrlHint: 'Discord 웹훅 URL은 https://discord.com/api/webhooks/로 시작합니다.',
    httpsHint: 'https:// URL을 사용하세요.',
    channel: (name, type, unusual) => `${name}: ${type}${unusual ? ' (특이한 URL)' : ''}`,
    channelHintSuffix: '`test-notify`를 실행하면 실제 테스트 메시지를 보냅니다.',
    fileStore: (path, exists) =>
      `file 저장소 ${path}${exists ? '' : ' (아직 상태 없음: 첫 실행이 기준선을 기록)'}`,
    fileStoreFailed: (err) => `file 저장소: ${err}`,
    fileStoreFailedHint: '디렉터리에 쓰기 권한이 있어야 합니다.',
    cacheStore: 'github-cache 저장소 (Actions 캐시)',
    cacheStoreOutside: 'GitHub Actions 밖에서 github-cache 저장소가 선택됨',
    cacheStoreOutsideHint: '로컬이나 cron 실행에는 stateStore.type: file을 사용하세요.',
    noneStore: '상태 저장소 없음: 매 실행이 기준선이 되어 아무것도 알리지 않습니다',
    noneStoreHint: '실제 실행에는 file 또는 github-cache를 사용하세요.',
    customStoreLoads: (module) => `커스텀 저장소 모듈 ${module} 로드 성공`,
    customStoreFailed: (err) => `커스텀 저장소: ${err}`,
    summaryProblems: (fails, warns) => `문제 ${fails}건, 경고 ${warns}건`,
    summaryAllGood: (warns) => `모두 정상, 경고 ${warns}건`,
  },
};

export const MESSAGES: Record<Lang, Messages> = { en, ko };

export function messages(lang: Lang = 'en'): Messages {
  return MESSAGES[lang];
}
