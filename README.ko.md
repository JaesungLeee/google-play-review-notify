# google-play-review-notify

[![CI](https://github.com/JaesungLeee/google-play-review-notify/actions/workflows/ci.yml/badge.svg)](https://github.com/JaesungLeee/google-play-review-notify/actions/workflows/ci.yml)
[![CodeQL](https://github.com/JaesungLeee/google-play-review-notify/actions/workflows/codeql.yml/badge.svg)](https://github.com/JaesungLeee/google-play-review-notify/actions/workflows/codeql.yml)
[![npm](https://img.shields.io/npm/v/play-review-notify)](https://www.npmjs.com/package/play-review-notify)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Google Play가 앱을 **거절**했을 때, 릴리즈가 **스토어에 반영**됐을 때, **정책 알림**을 보냈을 때 Slack·Discord·Webhook으로 메시지를 받습니다.
GitHub Action 또는 CLI로 동작하고, 서버가 필요 없으며, 어떤 Play Console 계정의 어떤 앱에도 붙일 수 있습니다.

English: [README.md](README.md)

## 왜 필요한가

Google Play에는 심사 결과 Webhook이 없습니다. 대신 Play Developer API가 릴리스별 심사 상태(`applications.tracks.releases.list`의 `releaseLifecycleState`)를 알려주고, API에 없는 정책 경고와 거부 사유는 개발자 메일함으로 옵니다. 이 도구는 둘을 주기적으로 조회해 정규화된 이벤트로 바꿉니다.

| 이벤트               | 출처               | 방법                                                                         |
| -------------------- | ------------------ | ---------------------------------------------------------------------------- |
| `PENDING_SUBMISSION` | Play Developer API | 릴리스는 만들었지만 아직 심사에 보내지 않음 (기본 꺼짐)                       |
| `SUBMITTED`          | Play Developer API | 릴리스가 심사에 들어감 (기본 꺼짐)                                            |
| `APPROVED`           | Play Developer API | 심사 통과, 게시 버튼 대기 중 (관리형 게시)                                    |
| `REJECTED`           | Play Developer API | 심사 거부. 이후 Play Console 메일이 오면 사유를 후속 알림으로 보냄            |
| `LIVE`               | Play Developer API | 해당 트랙 사용자에게 배포됨. production 외 트랙도 포함                        |
| `POLICY_WARNING`     | Gmail              | 기한이 있는 "조치 필요" 안내, 대상 API 수준 경고                              |

모든 이벤트는 멱등입니다. 이벤트마다 안정적인 id가 있고, 상태가 실행 사이에 유지되며, 첫 실행은 알림 없이 기준점만 기록합니다.

> API 이벤트의 전이표와 메일 룰은 [docs/design.md](docs/design.md#what-each-signal-can-and-cannot-say)(영어)에 있습니다. 릴리스 생명주기 엔드포인트는 2026년 봄에 새로 생긴 것이라 실제 계정에서 확인 중인 경계 사례가 그곳에 정리돼 있습니다.

## 빠른 시작: GitHub Action

1. [docs/play-api-setup.ko.md](docs/play-api-setup.ko.md)를 따라 읽기 전용 Play 서비스 계정을 만듭니다(약 10분). 릴리스 이벤트는 여기서 옵니다. 정책 경고와 거부 사유까지 받으려면 [docs/gmail-oauth.ko.md](docs/gmail-oauth.ko.md)로 Gmail 시크릿 세 개도 추가합니다.
2. 저장소에 `play-review-notify.yml`을 추가합니다. `npx play-review-notify init`이 몇 가지 질문 뒤에 설정 파일과 아래 워크플로우를 만들어 주며, [examples/play-review-notify.yml](examples/play-review-notify.yml)에서 시작해도 됩니다.
3. 워크플로우를 추가합니다.

```yaml
name: Play review notify
on:
  schedule:
    - cron: '*/10 * * * *'
  workflow_dispatch:

jobs:
  notify:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      actions: write # 상태를 Actions 캐시에 저장
    steps:
      - uses: actions/checkout@v4
      - uses: JaesungLeee/google-play-review-notify@v1
        with:
          config-path: play-review-notify.yml
        env:
          GMAIL_CLIENT_ID: ${{ secrets.GMAIL_CLIENT_ID }}
          GMAIL_CLIENT_SECRET: ${{ secrets.GMAIL_CLIENT_SECRET }}
          GMAIL_REFRESH_TOKEN: ${{ secrets.GMAIL_REFRESH_TOKEN }}
          PLAY_SERVICE_ACCOUNT_JSON: ${{ secrets.PLAY_SERVICE_ACCOUNT_JSON }}
          SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
```

권한·체크아웃·Action을 묶은 재사용 워크플로우를 호출해도 됩니다.

```yaml
jobs:
  notify:
    permissions:
      contents: read
      actions: write # 호출되는 워크플로우는 호출 측이 준 권한 이상을 요구할 수 없음
    uses: JaesungLeee/google-play-review-notify/.github/workflows/notify.yml@v1
    with:
      config-path: play-review-notify.yml
    secrets: inherit
```

설정 파일 없이 쓰고 싶으면 주요 항목을 Action 입력으로 줄 수 있고(`packages`, `gmail-*`, `play-service-account-json`, `slack-webhook-url`, `discord-webhook-url`, `webhook-url`, `webhook-secret`, `state-store`, `dry-run`, `emit-event`), 후속 스텝용으로 `events`, `events-count`, `has-rejection` 출력을 제공합니다. [action.yml](action.yml)을 참고하세요.

GitHub 스케줄 트리거는 최소 5분 간격이며 지연될 수 있습니다. 더 빠른 알림이 필요하면 CLI를 크론으로 실행하세요.

## 빠른 시작: CLI

```bash
npm i -g play-review-notify                       # 또는 npx play-review-notify ...
play-review-notify init                            # 몇 가지 질문에 답하면 play-review-notify.yml 생성

export GMAIL_CLIENT_ID=... GMAIL_CLIENT_SECRET=... # docs/gmail-oauth.ko.md
play-review-notify auth gmail                      # 브라우저 동의 → GMAIL_REFRESH_TOKEN 출력
export GMAIL_REFRESH_TOKEN=... SLACK_WEBHOOK_URL=...

play-review-notify doctor                          # 인증과 설정을 점검하고 고칠 점을 알려줌
play-review-notify test-notify                     # 샘플 REJECTED를 채널로 전송
play-review-notify run --dry-run --verbose         # 감지 결과만 출력, 전송 없음
play-review-notify run                             # 첫 실행은 기준점 기록, 이후 실행부터 알림
```

`gprn`은 `play-review-notify`의 약어입니다. `run`을 크론, CI 잡, n8n Schedule Trigger로 주기 실행하세요. 상태는 기본적으로 `.play-review-notify/state.json`에 저장됩니다.

| 명령                  | 용도                                                          |
| --------------------- | ------------------------------------------------------------- |
| `init`                | 질문 몇 개로 설정 파일(과 GitHub 워크플로우) 생성               |
| `run`                 | 활성화된 소스를 한 번 폴링하고 알림 후 상태 저장, 종료          |
| `auth gmail`          | `gmail.readonly` Refresh Token을 발급하는 최초 1회 OAuth 흐름   |
| `doctor`              | 설정·인증·소스·채널·상태 저장소를 점검하고 해결 방법 안내         |
| `test-notify`         | 설정된 채널로 샘플 이벤트 전송                                  |
| `emit`                | 파이프라인에서 이벤트 직접 발행 (예: 업로드 직후 `SUBMITTED`)   |
| `state show \| reset` | 저장된 상태 확인·초기화                                         |
| `lang [en\|ko]`       | 모든 명령에 적용되는 출력 언어 확인·저장                          |

종료 코드: `0` 성공, `1` 설정·인증 오류, `2` 소스 실패(알림은 전송됨), `3` 알림 전송 실패. `--json`으로 구조화 출력.

**언어.** 터미널에서 처음 실행하면 CLI가 영어/한국어 중 무엇으로 진행할지 묻고(Enter를 누르면 시스템 로케일의 언어) 답을 `~/.config/play-review-notify/preferences.json`(`$XDG_CONFIG_HOME` 또는 `%APPDATA%`가 있으면 그 아래)에 저장합니다. 이후에는 같은 사용자로 실행하는 cron을 포함해 모든 명령이 묻지 않고 그 언어를 씁니다. `play-review-notify lang`은 현재 언어와 출처를 보여주고, `lang en|ko`는 새 언어를 저장하며, `lang --reset`은 저장된 언어를 지웁니다. `--lang en|ko`는 한 번의 실행에만 적용되고, `PLAY_REVIEW_NOTIFY_LANG`은 스크립트에서 저장된 언어보다 우선합니다. 저장된 언어가 없으면 터미널 밖(cron, CI)이나 `--json`, `--version`에서는 묻지 않고 영어로 출력합니다. 생성되는 파일, JSON 출력, 코어 로그는 언어와 관계없이 영어입니다.

## 설정

시크릿은 파일에 쓰지 않고 `${ENV_VAR}` 참조로 넣습니다.

JSON Schema를 [schemas/config.schema.json](schemas/config.schema.json)에 제공합니다. YAML 첫 줄에
아래 주석을 넣으면 VS Code(YAML 확장), JetBrains IDE 등에서 자동완성·설명·오타 검사가 됩니다.

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/JaesungLeee/google-play-review-notify/main/schemas/config.schema.json
version: 1

apps:
  - packageName: com.example.app
    name: 'Example App' # 패키지명이 없는 메일을 앱명으로 매칭할 때 사용
    tracks: [production]
    channels: [release-slack] # 앱별 라우팅. 없으면 defaultChannels

sources:
  email:
    enabled: true
    auth:
      clientId: ${GMAIL_CLIENT_ID}
      clientSecret: ${GMAIL_CLIENT_SECRET}
      refreshToken: ${GMAIL_REFRESH_TOKEN}
    lookbackHours: 24 # 첫 실행과 상태 유실 시 조회 창
    # senderAllowlist: [...]      # 기본값이 Google Play 발신 주소를 포함
    # rules: [./my-rules.json]    # 내장 룰셋 확장·교체
  playApi:
    enabled: true
    serviceAccountJson: ${PLAY_SERVICE_ACCOUNT_JSON}

events: # 기본값: PENDING_SUBMISSION, SUBMITTED만 꺼짐
  REJECTED: { enabled: true, mentions: ['<!channel>'], reasonFollowUp: true }
  SUBMITTED: { enabled: true }
  LIVE: { enabled: true, mergeInto: APPROVED } # 승인 + 출시 대신 릴리스당 메시지 하나

channels:
  release-slack: { type: slack, webhookUrl: ${SLACK_WEBHOOK_URL} }
  ops-discord: { type: discord, webhookUrl: ${DISCORD_WEBHOOK_URL} }
  n8n:
    type: webhook # n8n, Make, Zapier, 자체 서버 등 아무 HTTP 수신자
    url: ${N8N_WEBHOOK_URL}
    secret: ${N8N_WEBHOOK_SECRET} # HMAC-SHA256 서명 헤더 (선택)
    batch: false
defaultChannels: [release-slack]

templates: # 이벤트 타입별 Mustache 스타일 오버라이드
  REJECTED: |
    :x: *{{appName}}* ({{packageName}}) v{{versionName}} 거절됨.
    사유: {{reason}}
    {{consoleUrl}}

stateStore:
  type: file # file | github-cache | none | custom
  path: .play-review-notify/state.json

includeReason: true
maxRetries: 3
```

- **채널**: `slack`(Incoming Webhook, Block Kit), `discord`(webhook embed), `webhook`(JSON 페이로드 + `X-Play-Review-Event`, `X-Play-Review-Timestamp`, `X-Play-Review-Signature: sha256=HMAC(secret, timestamp + "." + body)` 헤더. `batch: true`면 실행당 배열 1회 전송). 페이로드 형식은 [schemas/webhook-payload.schema.json](schemas/webhook-payload.schema.json)에, 바로 가져올 수 있는 n8n 워크플로우는 [examples/n8n](examples/n8n/README.md)에 있습니다.
- **상태 저장소**: `file`(CLI 기본), `github-cache`(Action 기본. 7일간 접근 없으면 만료되므로 그보다 짧은 주기면 문제없음), `none`(lookback 창만 사용), `custom`(`StateStore`를 export하는 로컬 모듈).
- **템플릿**에는 이벤트의 모든 필드와 설정의 `app.*`를 쓸 수 있습니다.

## 신호의 실제 동작

- **릴리스 상태**는 `applications.tracks.releases.list`에서 옵니다. `releaseLifecycleState`는 `NOT_SENT_FOR_REVIEW → IN_REVIEW → APPROVED_NOT_PUBLISHED | NOT_APPROVED → PUBLISHED`로 움직이고, 어댑터는 릴리스마다 마지막 상태를 기억해 새 상태에 들어갈 때마다 이벤트를 하나씩 냅니다. 폴링 간격 사이에 전이를 건너뛸 수 있어서, `IN_REVIEW` 다음에 바로 `PUBLISHED`가 보이면 `APPROVED`와 `LIVE`를 함께 냅니다.
- **관리형 게시 켜짐**: "게시 준비됨"에 도달하면 `APPROVED`, 게시 버튼을 누르면 `LIVE`. **꺼짐**: 승인 즉시 게시되므로 보통 같은 실행에서 둘이 함께 옵니다 (메시지 하나면 충분하면 `LIVE: { mergeInto: APPROVED }`).
- **거절**은 API가 사유 없이 먼저 알립니다. 사유는 보통 몇 분 뒤 `no-reply-googleplay-developer@google.com` 메일로 오고, 같은 거절에 대한 후속 알림으로 전송됩니다 (`reasonFollowUp: false`로 끌 수 있음). 거절과 기한부 경고의 제목이 같아서 본문으로 분류합니다.
- **메일 언어**는 Play Console 언어 설정을 따릅니다. 영어·한국어 룰셋이 내장돼 있고 다른 언어 기여를 환영합니다.

## 문서

- [Gmail 연동 설정](docs/gmail-oauth.ko.md) · [English](docs/gmail-oauth.md)
- [Play Developer API 연동 설정](docs/play-api-setup.ko.md) · [English](docs/play-api-setup.md)
- [설계 문서: 이벤트 모델, 신호, 파이프라인, 확장 지점](docs/design.md) (영어)
- [n8n 연동](examples/n8n/README.md)
- [변경 이력](CHANGELOG.md)

## 기여

버그 제보, 새 메일 형식 제보, 다른 언어 룰셋이 가장 가치 있는 기여입니다. 분류되지 않은 Play 메일이 있으면 `--verbose`로 실행해 확인한 뒤(매치되지 않은 메일은 제목과 함께 로그에 남습니다) 마스킹한 제목·본문으로 "Unrecognized Play email" 이슈를 열어주세요. 개발 환경과 룰셋 테스트 방법은 [CONTRIBUTING.md](CONTRIBUTING.md)에 있습니다.

보안 문제는 [SECURITY.md](SECURITY.md)를 따라 비공개로 알려주세요.

## 개인정보와 권한

- Gmail은 읽기 전용 스코프 `gmail.readonly`만 사용합니다. 메일은 저장하지 않으며, 상태 파일에는 메시지 id와 시각만, 알림에는 추출된 필드(앱, 버전, `reasonMaxLength`로 제한된 사유)만 들어갑니다.
- Play 서비스 계정은 "앱 정보 보기(읽기 전용)" 권한만 필요합니다. `applications.tracks.releases.list`만 호출하며 edit은 열지 않습니다.
- 설정에서 참조한 시크릿은 로그에서 마스킹됩니다.

## 개발

```bash
npm ci
npm run lint && npm run typecheck && npm test
npm run build            # dist/ (CLI, 라이브러리) + dist/action/index.js (커밋 대상 Action 번들)
npm run cli -- --help
```

## 라이선스

[Apache-2.0](LICENSE)
