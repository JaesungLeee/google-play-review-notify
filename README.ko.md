# google-play-review-notify

[![CI](https://github.com/JaesungLeee/google-play-review-notify/actions/workflows/ci.yml/badge.svg)](https://github.com/JaesungLeee/google-play-review-notify/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/play-review-notify)](https://www.npmjs.com/package/play-review-notify)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Google Play가 앱을 **거절**했을 때, 릴리즈가 **스토어에 반영**됐을 때, **정책 알림**을 보냈을 때 Slack·Discord·Webhook으로 메시지를 받습니다.
GitHub Action 또는 CLI로 동작하고, 서버가 필요 없으며, 어떤 Play Console 계정의 어떤 앱에도 붙일 수 있습니다.

English: [README.md](README.md)

## 왜 필요한가

Google Play는 심사 결과를 Play Console 화면과 개발자 계정 메일함, 딱 두 곳에만 알려줍니다. Webhook은 없고, Publishing API에는 "심사 중 / 승인 / 거절" 상태가 없습니다. 이 도구는 실제로 존재하는 신호를 감시해 정규화된 이벤트로 바꿉니다.

| 이벤트                             | 출처                     | 방법                                                                                  |
| ---------------------------------- | ------------------------ | ------------------------------------------------------------------------------------- |
| `REJECTED`                         | Gmail (Play Console 정책 메일) | 본문의 `앱 상태: 거부됨` / `App Status: Rejected` 줄로 판정, 사유 추출              |
| `POLICY_WARNING`                   | Gmail                    | 기한이 있는 "조치 필요" 안내, 대상 API 수준 경고                                      |
| `SUBMITTED`                        | Play Developer API       | 설정한 트랙에 새 versionCode 등장                                                     |
| `LIVE`                             | 공개 스토어 페이지       | 404 → 200 전환(첫 출시) 또는 "업데이트 날짜" 변화                                     |
| `REMOVED`, `SUSPENDED`, `APPROVED` | Gmail                    | 룰은 있으나 검증 전 초안. Google은 업데이트 승인 시 **메일을 보내지 않는 것이 보통**   |
| `UNKNOWN_NOTICE`                   | Gmail                    | 룰이 분류하지 못한 Play 메일 (기본 꺼짐. 새 메일 형식을 잡으려면 켜세요)               |

모든 이벤트는 멱등입니다. 이벤트마다 안정적인 id가 있고, 상태가 실행 사이에 유지되며, 첫 실행은 알림 없이 기준점만 기록합니다.

> 감지 규칙은 실제 Play Console 메일과 Play API 응답으로 검증했습니다. 확정된 결정표와 한계(관리형 게시 포함)는 [docs/design.md](docs/design.md#what-each-signal-can-and-cannot-say)(영어)에 있습니다.

## 빠른 시작: GitHub Action

1. [docs/gmail-oauth.ko.md](docs/gmail-oauth.ko.md)를 따라 Gmail 시크릿 세 개를 만듭니다(최초 1회, 약 10분). `SUBMITTED` 이벤트가 필요하면 [docs/play-api-setup.ko.md](docs/play-api-setup.ko.md)로 Play 서비스 계정도 추가합니다.
2. 저장소에 `play-review-notify.yml`을 추가합니다([examples/play-review-notify.yml](examples/play-review-notify.yml)에서 시작).
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
cp examples/play-review-notify.yml play-review-notify.yml   # 앱과 채널 편집

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
| `run`                 | 활성화된 소스를 한 번 폴링하고 알림 후 상태 저장, 종료          |
| `auth gmail`          | `gmail.readonly` Refresh Token을 발급하는 최초 1회 OAuth 흐름   |
| `doctor`              | 설정·인증·소스·채널·상태 저장소를 점검하고 해결 방법 안내         |
| `test-notify`         | 설정된 채널로 샘플 이벤트 전송                                  |
| `emit`                | 파이프라인에서 이벤트 직접 발행 (예: 업로드 직후 `SUBMITTED`)   |
| `state show \| reset` | 저장된 상태 확인·초기화                                         |

종료 코드: `0` 성공, `1` 설정·인증 오류, `2` 소스 실패(알림은 전송됨), `3` 알림 전송 실패. `--json`으로 구조화 출력.

## 설정

시크릿은 파일에 쓰지 않고 `${ENV_VAR}` 참조로 넣습니다.

```yaml
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
  storeListing:
    enabled: true
    locale: ko
    country: KR

events: # 기본값: SUBMITTED, UNKNOWN_NOTICE만 꺼짐
  REJECTED: { enabled: true, mentions: ['<!channel>'] }
  SUBMITTED: { enabled: true }
  LIVE: { enabled: true, mergeInto: APPROVED }

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

- **채널**: `slack`(Incoming Webhook, Block Kit), `discord`(webhook embed), `webhook`(JSON 페이로드 + `X-Play-Review-Event`, `X-Play-Review-Timestamp`, `X-Play-Review-Signature: sha256=HMAC(secret, timestamp + "." + body)` 헤더. `batch: true`면 실행당 배열 1회 전송).
- **상태 저장소**: `file`(CLI 기본), `github-cache`(Action 기본. 7일간 접근 없으면 만료되므로 그보다 짧은 주기면 문제없음), `none`(lookback 창만 사용), `custom`(`StateStore`를 export하는 로컬 모듈).
- **템플릿**에는 이벤트의 모든 필드와 설정의 `app.*`를 쓸 수 있습니다.

## 신호의 실제 동작

- **거절**은 항상 `no-reply-googleplay-developer@google.com`에서 메일로 옵니다. 거절과 기한부 경고의 제목이 같아서 본문으로 분류합니다.
- **업데이트 승인**은 메일이 오지 않습니다. Play Developer API는 제출 직후부터 심사 중인 릴리즈를 `completed`로 보고합니다. 릴리즈가 사용자에게 도달했다는 유일한 증거는 공개 스토어 페이지이고, `storeListing` 소스가 그것을 감시합니다. production 트랙만 해당됩니다.
- **관리형 게시**: 게시 버튼을 눌러야 스토어가 바뀌므로 "승인됨, 게시 대기" 시점은 어떤 소스로도 알 수 없습니다.
- **메일 언어**는 Play Console 언어 설정을 따릅니다. 영어·한국어 룰셋이 내장돼 있고 다른 언어 기여를 환영합니다.

## 문서

- [Gmail 연동 설정](docs/gmail-oauth.ko.md) · [English](docs/gmail-oauth.md)
- [Play Developer API 연동 설정](docs/play-api-setup.ko.md) · [English](docs/play-api-setup.md)
- [설계 문서: 이벤트 모델, 신호, 파이프라인, 확장 지점](docs/design.md) (영어)
- [n8n 연동](examples/n8n/README.md)
- [변경 이력](CHANGELOG.md)

## 기여

버그 제보, 새 메일 형식 제보, 다른 언어 룰셋이 가장 가치 있는 기여입니다. 분류되지 않은 Play 메일이 있으면 `UNKNOWN_NOTICE`를 켜서 확인한 뒤 마스킹한 제목·본문으로 "Unrecognized Play email" 이슈를 열어주세요. 개발 환경과 룰셋 테스트 방법은 [CONTRIBUTING.md](CONTRIBUTING.md)에 있습니다.

보안 문제는 [SECURITY.md](SECURITY.md)를 따라 비공개로 알려주세요.

## 개인정보와 권한

- Gmail은 읽기 전용 스코프 `gmail.readonly`만 사용합니다. 메일은 저장하지 않으며, 상태 파일에는 메시지 id와 시각만, 알림에는 추출된 필드(앱, 버전, `reasonMaxLength`로 제한된 사유)만 들어갑니다.
- Play 서비스 계정은 "앱 정보 보기(읽기 전용)" 권한만 필요합니다. 트랙 조회용 edit은 항상 폐기됩니다.
- 스토어 리스팅 소스는 앱당 실행마다 인증 없는 요청 1회를 명시적 User-Agent로 보냅니다.
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
