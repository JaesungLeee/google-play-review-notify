# google-play-review-notify

Google Play 앱 심사 결과(승인/거절/정책 알림 등)를 감지해 Slack·Discord 또는 임의의 Webhook(n8n 등)으로 알리는 범용 워크플로우.
GitHub Action과 CLI 두 형태로 제공됩니다.

> 상태: Phase 0 진행 중. 이메일 어댑터의 거절·정책 경고 룰(영어·한국어)은 실제 Play Console 메일로 검증됐고, 승인 관련 룰은 아직 초안입니다. 스토어 리스팅 어댑터(라이브 확인)는 구현됐고, Play API 어댑터는 스텁입니다. 로드맵은 [PRD](docs/PRD_ko.md#10-로드맵)를 참고하세요.

## Docs

- [PRD (한국어, 기본)](docs/PRD_ko.md)
- [PRD (English)](docs/PRD_en.md)
- [Gmail 연동 설정 (OAuth Refresh Token 발급)](docs/gmail-oauth.md)
- [Phase 0 관측 노트](docs/phase0-notes.md)

## Quick start (CLI)

```bash
cp examples/play-review-notify.yml play-review-notify.yml   # 설정 편집
export GMAIL_CLIENT_ID=... GMAIL_CLIENT_SECRET=...           # docs/gmail-oauth.md 참고
npx play-review-notify auth gmail         # 브라우저 동의 → GMAIL_REFRESH_TOKEN 출력 (최초 1회)
export GMAIL_REFRESH_TOKEN=... SLACK_WEBHOOK_URL=...

npx play-review-notify test-notify        # 채널 연결 확인
npx play-review-notify run --dry-run      # 감지 결과만 출력
npx play-review-notify run                # 실제 전송 (첫 실행은 베이스라인만 기록)
```

전역 설치 시 `play-review-notify` 또는 약어 `gprn`으로 실행할 수 있습니다.

```bash
npm i -g play-review-notify
gprn run --dry-run
```

## Quick start (GitHub Action)

```yaml
on:
  schedule:
    - cron: '*/10 * * * *'
jobs:
  notify:
    runs-on: ubuntu-latest
    permissions: { contents: read, actions: write }
    steps:
      - uses: actions/checkout@v4
      - uses: JaesungLeee/google-play-review-notify@v1
        with:
          config-path: play-review-notify.yml
        env:
          GMAIL_CLIENT_ID: ${{ secrets.GMAIL_CLIENT_ID }}
          GMAIL_CLIENT_SECRET: ${{ secrets.GMAIL_CLIENT_SECRET }}
          GMAIL_REFRESH_TOKEN: ${{ secrets.GMAIL_REFRESH_TOKEN }}
          SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
```

## Development

```bash
npm ci
npm run typecheck && npm run lint && npm test
npm run build        # dist/ (CLI, library) + dist/action/index.js (Action bundle, 커밋 대상)
npm run cli -- --help
```

## License

Apache-2.0
