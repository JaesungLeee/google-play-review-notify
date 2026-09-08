# PRD: Google Play Review Notify

> 구글 플레이 앱 심사 결과(승인/거절 등)를 자동으로 감지해 Slack·Discord로 알리는 범용 워크플로우

| 항목 | 내용 |
| --- | --- |
| 문서 버전 | 1.0 |
| 작성일 | 2026-09-07 |
| 상태 | 확정 (2026-09-07) |
| 기본 언어 | 한국어 (영문판: [PRD_en.md](./PRD_en.md)) |

---

## 1. 배경 및 문제 정의

Google Play Console에 앱(또는 업데이트)을 제출하면 심사 결과는 Play Console 화면과 개발자 계정 이메일로만 통보된다. 팀은 다음과 같은 불편을 겪는다.

- 심사 결과를 알기 위해 담당자가 Play Console을 반복해서 열어봐야 한다.
- 거절 알림 이메일이 특정 개인 계정으로만 가서 팀 채널에 공유가 늦어진다.
- CI/CD로 업로드까지는 자동화되어 있지만, "심사 통과 후 라이브" 시점은 사람이 확인한다.
- 프로젝트마다 이 감시 스크립트를 따로 만들어 유지보수가 중복된다.

**공식 제약**: Google Play Developer Publishing API는 릴리즈 상태로 `draft / inProgress / halted / completed`만 제공하며, **심사 중·승인·거절을 나타내는 필드가 없다.** 거절 사유 또한 API로 얻을 수 없다. 따라서 심사 결과의 신뢰할 수 있는 1차 출처는 Google이 개발자 계정으로 보내는 알림 이메일이다.

## 2. 목표

1. Google Play 심사 관련 이벤트(심사 중 진입, 승인, 거절, 정책 경고, 삭제/정지 등)를 사람 개입 없이 감지한다.
2. 감지된 이벤트를 Slack 또는 Discord 채널로 지연 최소화하여 전달한다.
3. **어떤 프로젝트에서도 붙일 수 있는 범용 워크플로우**로 제공한다.
   - GitHub Actions: `uses:` 한 줄로 도입
   - CLI: `npx`로 어디서든(GitLab CI, Jenkins, 서버 크론 등) 실행
4. 감지 소스·상태 저장소·알림 채널을 플러그인 구조로 분리해 확장 가능하게 한다.

### 비목표 (Non-Goals)

- Play Console 웹 UI 스크래핑/브라우저 자동화 (ToS 위반 위험, 불안정)
- 앱 업로드/릴리즈 생성 자체 (Fastlane, gradle-play-publisher 등 기존 도구 영역)
- App Store Connect(iOS) 지원 — 어댑터 구조상 향후 가능하나 v1 범위 밖
- 사용자 리뷰(별점/댓글) 알림 — 별개 도메인
- 상시 실행 서버/데몬 제공 — 실행 주체는 스케줄러(cron, GitHub schedule)에 위임

## 3. 사용자 및 시나리오

| 사용자 | 니즈 |
| --- | --- |
| 모바일 앱 개발자 | 배포 후 심사 결과를 채널에서 바로 확인, 거절 시 사유를 즉시 파악 |
| 릴리즈 매니저 / QA | 여러 앱의 심사 현황을 하나의 채널에서 추적 |
| DevOps | 저장소마다 스크립트를 만들지 않고 표준 액션으로 도입, 시크릿 관리 단순화 |
| 오픈소스 기여자 | 새 채널(Teams 등)이나 새 소스를 어댑터로 추가 |

**대표 시나리오**

1. 개발자가 CI로 프로덕션 트랙에 AAB를 업로드한다. 10분 후 워크플로우가 "심사 중" 이벤트를 감지해 `#release` 채널에 알린다.
2. 이틀 뒤 Google이 거절 이메일을 보낸다. 다음 실행에서 이메일을 파싱해 거절 사유와 Play Console 링크를 포함한 메시지를 Discord에 보낸다.
3. 수정 후 재제출. 승인 이메일이 오면 "승인됨" 알림, 이어서 스토어 리스팅에서 새 버전이 확인되면 "라이브 확인" 알림을 보낸다.
4. 다른 팀이 같은 액션을 자기 저장소에 붙이며, 앱 2개를 각각 다른 Slack 채널로 라우팅한다.

## 4. 확정된 설계 결정 요약

| # | 결정 사항 | 선택 | 비고 |
| --- | --- | --- | --- |
| D1 | 감지 방식 | 이메일(1차) + Play API(보조) + 스토어 리스팅(선택) | API는 심사 상태 미제공 |
| D2 | 실행 환경 | GitHub Action + CLI 동시 제공 | 코어는 라이브러리, Action은 얇은 래퍼 |
| D3 | 기술 스택 | TypeScript / Node.js 20+ | Actions 네이티브 런타임, googleapis SDK |
| D4 | 알림 채널 | Slack, Discord — Incoming Webhook 기본 + 범용 HTTP Webhook(n8n 등 연동용) | Notifier 인터페이스로 확장 |
| D5 | 상태 저장 | 플러그인 방식. 기본: Actions Cache(Action) / 로컬 파일(CLI) | 커밋 노이즈 없음 |
| D6 | 다중 앱 | 지원. 앱별 채널 라우팅 가능 | |
| D7 | 이벤트 범위 | 심사 중·승인·거절 + 정책 경고·삭제·정지 등 | 이벤트별 on/off |
| D8 | Gmail 인증 | OAuth2 Refresh Token | `gmail.readonly` 최소 스코프 |
| D9 | 메시지 | 영어 기본 템플릿 + 사용자 템플릿 오버라이드 | |
| D10 | 배포 | npm 패키지 + GitHub Marketplace 액션 | semver, `v1` 메이저 태그 |
| D11 | 초기/상태 유실 시 | 베이스라인만 기록, 알림 없음 | 이메일은 최근 N시간 창만 조회 |
| D12 | 외부 워크플로우 연동 | 범용 Webhook 채널로 n8n Webhook Trigger에 이벤트 전달(기본), 셀프호스팅은 Execute Command로 CLI 실행(보조) | n8n 커뮤니티 노드는 Phase 4 |

## 5. 기능 요구사항

요구사항 ID 규칙: `FR-<영역>-<번호>`. 우선순위는 **P0(필수) / P1(중요) / P2(선택)**.

### 5.1 이벤트 모델

시스템 내부는 소스와 무관한 정규화된 `ReviewEvent`로 동작한다.

| 이벤트 타입 | 의미 | 주 출처 | 우선순위 |
| --- | --- | --- | --- |
| `SUBMITTED` | 새 버전이 심사 대기/심사 중 상태로 진입 | Play API(새 versionCode 관측), 명시적 트리거 | P1 |
| `APPROVED` | 심사 통과 | 이메일 | P0 |
| `REJECTED` | 심사 거절 (사유 포함) | 이메일 | P0 |
| `LIVE` | 스토어에 실제 반영 확인 | 스토어 리스팅, Play API | P1 |
| `POLICY_WARNING` | 정책 위반 경고/시정 요구 | 이메일 | P1 |
| `REMOVED` | 앱 삭제(removed) | 이메일 | P1 |
| `SUSPENDED` | 앱/계정 정지 | 이메일 | P1 |
| `UNKNOWN_NOTICE` | Play에서 온 것은 확실하나 분류 불가한 알림 | 이메일 | P2 |

`ReviewEvent` 필드 (최소):

```ts
interface ReviewEvent {
  id: string;               // 중복 제거 키. 예: "email:<gmailMessageId>", "api:<pkg>:<track>:<versionCode>:LIVE"
  type: ReviewEventType;
  packageName: string | null; // 이메일에서 식별 실패 시 null 허용, 앱명으로 보정 시도
  appName?: string;
  track?: string;           // production | beta | alpha | internal | custom
  versionCode?: string;
  versionName?: string;
  reason?: string;          // 거절/경고 사유 (plain text)
  consoleUrl?: string;      // Play Console 딥링크
  source: 'email' | 'play-api' | 'store-listing' | 'manual';
  confidence: 'high' | 'medium' | 'low';
  observedAt: string;       // ISO 8601
  raw?: unknown;            // 디버그용, 알림에는 포함하지 않음
}
```

- **FR-EVT-1 (P0)** 모든 소스는 `ReviewEvent`로 정규화되어야 하며 소스별 필드는 `raw`에만 존재한다.
- **FR-EVT-2 (P0)** 동일 `id`의 이벤트는 상태 저장소에 기록되어 있으면 재알림하지 않는다(멱등성).
- **FR-EVT-3 (P1)** 같은 실행에서 여러 소스가 같은 사실을 보고하면(예: 이메일 APPROVED + API LIVE) 각각 별도 이벤트로 취급하되, 설정으로 `LIVE`를 `APPROVED`에 병합 가능해야 한다.
- **FR-EVT-4 (P0)** 이벤트별 알림 on/off를 설정할 수 있어야 한다. 기본값: `APPROVED, REJECTED, LIVE, POLICY_WARNING, REMOVED, SUSPENDED` on / `SUBMITTED, UNKNOWN_NOTICE` off.

### 5.2 감지 소스 어댑터

공통 인터페이스:

```ts
interface SourceAdapter {
  name: string;
  poll(ctx: PollContext, state: SourceState): Promise<{ events: ReviewEvent[]; nextState: SourceState }>;
}
```

#### 5.2.1 이메일 어댑터 (Gmail) — 1차 신호

- **FR-SRC-EMAIL-1 (P0)** Gmail API를 OAuth2 Refresh Token으로 호출하며, 필요한 스코프는 `https://www.googleapis.com/auth/gmail.readonly`뿐이어야 한다.
- **FR-SRC-EMAIL-2 (P0)** 발신자 allowlist(기본: `googleplay-noreply@google.com`, `googleplay-developer-support@google.com`, 도메인 `@google.com`)와 제목/본문 패턴 룰셋으로 Play Console 알림만 선별한다. 룰셋은 설정으로 확장·재정의 가능해야 한다.
- **FR-SRC-EMAIL-3 (P0)** 룰셋은 이메일을 `APPROVED / REJECTED / POLICY_WARNING / REMOVED / SUSPENDED / UNKNOWN_NOTICE`로 분류하고, 가능한 경우 앱명, 패키지명, 버전, 거절 사유를 추출한다.
- **FR-SRC-EMAIL-4 (P0)** 최초 실행 또는 상태 유실 시 `lookbackHours`(기본 24) 이내의 메시지만 조회하고, 이 실행은 베이스라인 기록만 하며 알림을 보내지 않는다(D11).
- **FR-SRC-EMAIL-5 (P0)** 정상 실행 시 마지막 처리 시각(watermark)과 최근 처리 messageId 목록을 상태로 보관해 중복을 방지한다.
- **FR-SRC-EMAIL-6 (P1)** 기본 룰셋은 패키지 내부에 버전 관리되며(`rules/email/*.json`), 새 Google 이메일 포맷에 대응하는 룰 업데이트가 코드 변경 없이 배포 가능해야 한다.
- **FR-SRC-EMAIL-7 (P1)** 이메일 언어가 영어가 아닌 경우(Play Console 언어 설정에 따름)를 고려해 룰은 locale별로 정의 가능해야 한다. v1 기본 룰셋은 영어, 한국어를 포함한다.
- **FR-SRC-EMAIL-8 (P1)** 패키지명이 이메일에 없으면 설정의 `apps[].name`(스토어 표시명)과 매칭해 보정한다. 매칭 실패 시 `packageName: null`로 전달하고 기본 채널로 알린다.
- **FR-SRC-EMAIL-9 (P2)** `gmail.modify` 스코프를 선택적으로 허용해 처리된 메일에 라벨을 붙일 수 있다(기본 비활성).
- **보안**: 이메일 본문 전체를 로그·상태·알림에 남기지 않는다. 사유는 추출된 텍스트만, 길이 제한(기본 1,000자) 적용.

#### 5.2.2 Play Developer API 어댑터 — 보조 신호

- **FR-SRC-API-1 (P1)** 서비스 계정 JSON으로 `androidpublisher` v3에 인증하고, 설정된 앱·트랙에 대해 `edits.insert → edits.tracks.get → edits.delete`(읽기 전용 흐름)로 릴리즈 목록을 조회한다.
- **FR-SRC-API-2 (P1)** 이전 상태와 비교해 새 `versionCode`가 트랙에 나타나면 `SUBMITTED`(confidence: medium)를 발생시킨다.
- **FR-SRC-API-3 (P1)** 릴리즈 `status`가 `completed` 또는 `inProgress`로 관측되고 스토어 리스팅 어댑터 또는 이메일이 승인을 확인하면 `LIVE`를 발생시킨다. API 단독으로는 `LIVE`를 발생시키지 않는다(기본값). 설정으로 단독 발생 허용 가능(confidence: low).
- **FR-SRC-API-4 (P1)** 이전에 관측된 versionCode가 더 높은 버전 없이 트랙에서 사라지면 `REJECTED` 후보로 기록만 하고, 이메일 확인 없이는 알리지 않는다(오탐 방지).
- **FR-SRC-API-5 (P0)** Phase 0 스파이크에서 실제 계정으로 위 추론 규칙을 검증한 뒤 결정표(decision table)를 이 문서 부록에 확정한다. 검증 전까지 API 어댑터의 이벤트 발생 규칙은 "가설"로 표기한다.
- 필요 권한: 서비스 계정에 Play Console "앱 정보 보기(읽기 전용)" 권한. 앱 업로드 권한은 요구하지 않는다.

#### 5.2.3 스토어 리스팅 어댑터 — 선택

- **FR-SRC-STORE-1 (P2)** 인증 없이 `https://play.google.com/store/apps/details?id=<pkg>&hl=<lang>&gl=<country>`를 조회해 표시 버전명과 "업데이트 날짜"를 추출한다.
- **FR-SRC-STORE-2 (P2)** 이전 상태와 달라지면 `LIVE`(confidence: medium)를 발생시킨다. 버전명이 "기기에 따라 다름"으로 노출되면 업데이트 날짜 변화만으로 판단한다.
- **FR-SRC-STORE-3 (P2)** 기본 비활성. HTML 구조 변경 등으로 파싱에 실패하면 경고 로그만 남기고 실행은 계속되어야 한다. 실패가 `storeListing.failureThreshold`(기본 5회) 연속되면 1회 경고 알림을 보낸다.
- **FR-SRC-STORE-4 (P2)** 요청 간격은 앱당 실행마다 1회로 제한하고 User-Agent를 명시한다.

#### 5.2.4 수동/외부 트리거

- **FR-SRC-MANUAL-1 (P2)** 배포 파이프라인이 업로드 직후 `SUBMITTED` 이벤트를 직접 발행할 수 있는 CLI 명령(`emit --type SUBMITTED --package ... --version-code ...`)과 Action 입력(`emit-event`)을 제공한다. 이렇게 발행된 이벤트는 API 어댑터의 `SUBMITTED`와 같은 `id` 규칙을 써서 중복되지 않는다.

### 5.3 상태 저장소

```ts
interface StateStore {
  load(): Promise<State | null>;
  save(state: State): Promise<void>;
}
```

- **FR-STATE-1 (P0)** 상태는 단일 JSON 문서로 직렬화되며 스키마 버전 필드를 가진다. 스키마 마이그레이션은 로드 시 자동 수행한다.
- **FR-STATE-2 (P0)** 기본 구현
  - `github-cache`: `@actions/cache`를 사용. 캐시는 불변이므로 저장 키는 `<prefix>-<runId>-<attempt>`, 복원은 `restore-keys: <prefix>-`로 최신 항목을 가져온다. 7일 미접근 시 삭제되는 특성은 문서에 명시한다.
  - `file`: 지정 경로(기본 `.play-review-notify/state.json`)의 로컬 파일. CLI 기본값.
  - `none`: 상태를 저장하지 않음. 이메일 lookback 창 기반으로만 동작(테스트/디버그용).
- **FR-STATE-3 (P1)** 저장소 커밋 방식(`git`)은 v1에서 제공하지 않으나, `StateStore` 인터페이스만 구현하면 사용자 정의 저장소를 등록할 수 있어야 한다(`stateStore.module` 설정으로 로컬 모듈 로드).
- **FR-STATE-4 (P0)** 저장 실패 시 알림은 이미 전송되었을 수 있으므로, 알림 전송은 "상태 저장 성공 후"가 아니라 "상태에 이벤트 id를 먼저 기록 → 저장 → 전송 → 전송 결과 기록"의 순서로 처리하고, 전송 실패 이벤트는 다음 실행에서 `maxRetries`(기본 3)까지 재시도한다.

### 5.4 알림 채널

```ts
interface Notifier {
  name: string;
  send(message: RenderedMessage, target: ChannelTarget): Promise<void>;
}
```

- **FR-NOTIFY-1 (P0)** Slack Incoming Webhook: Block Kit 형식으로 이벤트 타입별 색상/이모지, 앱명·패키지명·트랙·버전·사유·Play Console 링크를 포함한다.
- **FR-NOTIFY-2 (P0)** Discord Webhook: Embed 형식으로 동일 정보를 포함한다.
- **FR-NOTIFY-3 (P0)** 채널은 이름으로 정의하고(`channels.<name>`), 앱별·이벤트별로 라우팅할 수 있다. 라우팅 미지정 시 `defaultChannels`를 사용한다.
- **FR-NOTIFY-4 (P1)** 전송 실패 시 지수 백오프로 3회 재시도하고, 429 응답의 `Retry-After`를 존중한다.
- **FR-NOTIFY-5 (P1)** `dryRun` 모드에서는 렌더링된 메시지를 로그(및 Action job summary)에 출력만 하고 전송하지 않는다.
- **FR-NOTIFY-6 (P1)** 멘션 설정: 이벤트 타입별 `mentions`(예: REJECTED 시 `<!channel>` 또는 Discord role id).
- **FR-NOTIFY-7 (P1)** 범용 HTTP Webhook 채널(`type: webhook`)을 제공한다. 이벤트를 정규화된 JSON 페이로드(5.9.1)로 POST하며 n8n, Make, Zapier, 자체 서버 등 어떤 수신자든 연동할 수 있다.
- **FR-NOTIFY-8 (P1)** Webhook 채널은 `secret` 설정 시 요청 본문의 HMAC-SHA256 서명을 `X-Play-Review-Signature` 헤더로, 재전송 방지용 타임스탬프를 `X-Play-Review-Timestamp` 헤더로 보낸다. 사용자 정의 헤더(`headers`)도 지원한다.
- **FR-NOTIFY-9 (P1)** Webhook 채널은 이벤트를 개별 요청으로 보내는 것을 기본으로 하고, `batch: true`이면 한 실행의 이벤트를 배열로 묶어 1회 전송한다.
- **FR-NOTIFY-10 (P2)** 새 채널(Teams, 이메일 등)은 `Notifier` 구현체를 추가하는 것만으로 등록 가능해야 한다.

### 5.5 메시지 템플릿

- **FR-TPL-1 (P0)** 이벤트 타입별 기본 영어 템플릿을 제공한다.
- **FR-TPL-2 (P0)** 설정에서 이벤트 타입별로 템플릿 문자열을 오버라이드할 수 있다. 템플릿 엔진은 의존성이 가벼운 Mustache 호환 문법을 사용하며, 사용 가능한 변수는 `ReviewEvent` 필드 전부와 `app.*`(설정에서 가져온 앱 메타데이터)이다.
- **FR-TPL-3 (P1)** 사유(`reason`) 포함 여부를 `includeReason`(기본 true)으로 제어할 수 있다.
- **FR-TPL-4 (P2)** 템플릿을 별도 파일(`templates/*.md`)로도 지정 가능하다.

### 5.6 설정

- **FR-CFG-1 (P0)** 설정 파일은 YAML(`play-review-notify.yml`)이며 JSON Schema를 제공해 검증한다.
- **FR-CFG-2 (P0)** 시크릿(Gmail 토큰, 서비스 계정 JSON, webhook URL)은 설정 파일에 직접 쓰지 않고 환경 변수 참조(`${ENV_NAME}`)로 주입한다.
- **FR-CFG-3 (P0)** GitHub Action은 설정 파일 경로 입력과 함께, 파일 없이도 동작하도록 주요 항목을 개별 입력(inputs)으로도 받는다. 우선순위: inputs > env > 설정 파일.
- **FR-CFG-4 (P1)** `init` 명령이 대화형으로 설정 파일 초안을 생성한다.

설정 예시:

```yaml
version: 1

apps:
  - packageName: com.example.app
    name: "Example App"            # 이메일에서 패키지명 식별 실패 시 매칭용
    tracks: [production, beta]
    channels: [release-slack]       # 앱별 라우팅 (생략 시 defaultChannels)
  - packageName: com.example.other
    name: "Other App"
    channels: [ops-discord]

sources:
  email:
    enabled: true
    auth:
      clientId: ${GMAIL_CLIENT_ID}
      clientSecret: ${GMAIL_CLIENT_SECRET}
      refreshToken: ${GMAIL_REFRESH_TOKEN}
    lookbackHours: 24
    senderAllowlist:
      - googleplay-noreply@google.com
      - googleplay-developer-support@google.com
    rules: builtin               # 또는 사용자 룰 파일 경로 배열
  playApi:
    enabled: true
    serviceAccountJson: ${PLAY_SERVICE_ACCOUNT_JSON}
    emitLiveWithoutConfirmation: false
  storeListing:
    enabled: false
    locale: en
    country: US

events:
  SUBMITTED: { enabled: true }
  APPROVED:  { enabled: true }
  REJECTED:  { enabled: true, mentions: ["<!channel>"] }
  LIVE:      { enabled: true, mergeInto: APPROVED }
  POLICY_WARNING: { enabled: true }
  REMOVED:   { enabled: true }
  SUSPENDED: { enabled: true, mentions: ["<!channel>"] }
  UNKNOWN_NOTICE: { enabled: false }

channels:
  release-slack:
    type: slack
    webhookUrl: ${SLACK_WEBHOOK_URL}
  ops-discord:
    type: discord
    webhookUrl: ${DISCORD_WEBHOOK_URL}
  n8n:
    type: webhook                    # 범용 HTTP Webhook (n8n Webhook Trigger 등)
    url: ${N8N_WEBHOOK_URL}
    secret: ${N8N_WEBHOOK_SECRET}    # HMAC-SHA256 서명 (선택)
    batch: false
defaultChannels: [release-slack, n8n]

templates:
  REJECTED: |
    :x: *{{appName}}* ({{packageName}}) v{{versionName}} was rejected.
    Reason: {{reason}}
    {{consoleUrl}}

stateStore:
  type: file                   # file | github-cache | none | custom
  path: .play-review-notify/state.json

includeReason: true
```

### 5.7 CLI

패키지명: `play-review-notify`, 실행 명령: `npx play-review-notify <command>`. 전역 설치 시 bin `play-review-notify` 및 약어 `gprn` 제공.

| 명령 | 설명 | 우선순위 |
| --- | --- | --- |
| `run` | 설정대로 1회 폴링·알림 수행 후 종료. `--dry-run`, `--config`, `--state-store` 옵션 | P0 |
| `init` | 대화형으로 설정 파일 생성 | P1 |
| `auth gmail` | 로컬 브라우저로 OAuth 동의 후 Refresh Token 발급, 환경 변수 설정 안내 출력 | P0 |
| `doctor` | 인증·권한·webhook 연결·설정 스키마를 점검하고 결과 표 출력 | P1 |
| `test-notify` | 샘플 이벤트로 채널에 테스트 메시지 전송 | P1 |
| `emit` | 외부에서 이벤트 직접 발행 (5.2.4) | P2 |
| `state show / reset` | 현재 상태 확인·초기화 | P1 |

- **FR-CLI-1 (P0)** 종료 코드: 0 성공, 1 설정/인증 오류, 2 소스 조회 부분 실패(알림은 진행), 3 알림 전송 실패.
- **FR-CLI-2 (P0)** 로그는 사람이 읽는 형식 기본, `--json` 옵션으로 구조화 출력.
- **FR-CLI-3 (P1)** Node 20 이상에서 동작하며 의존성은 최소화한다(googleapis, undici/fetch, yaml, zod 수준).

### 5.8 GitHub Action

- **FR-GHA-1 (P0)** `action.yml`은 `runs.using: node20`(Docker 없음). 번들된 `dist/index.js`를 커밋한다.
- **FR-GHA-2 (P0)** 입력(inputs): `config-path`, `gmail-client-id`, `gmail-client-secret`, `gmail-refresh-token`, `play-service-account-json`, `slack-webhook-url`, `discord-webhook-url`, `packages`(쉼표 구분, 설정 파일 없이 사용할 때), `state-store`(기본 `github-cache`), `dry-run`, `emit-event`.
- **FR-GHA-3 (P0)** 출력(outputs): `events`(JSON 배열), `events-count`, `has-rejection`(boolean). 후속 스텝에서 조건 분기에 활용.
- **FR-GHA-4 (P1)** 실행 결과를 GitHub Job Summary에 표로 출력한다.
- **FR-GHA-5 (P1)** 재사용 가능 워크플로우(`.github/workflows/notify.yml`, `workflow_call`)를 함께 제공해 스케줄 설정·권한·캐시까지 캡슐화한다.
- **FR-GHA-6 (P0)** 필요한 권한은 `actions: write`(캐시 저장)뿐이며, `contents: read`로 충분함을 문서화한다.

사용 예시:

```yaml
name: Play review notify
on:
  schedule:
    - cron: "*/10 * * * *"
  workflow_dispatch:

jobs:
  notify:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      actions: write
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

> GitHub 스케줄 트리거는 최소 5분 간격이며 지연될 수 있다. 실시간성이 필요하면 CLI를 서버 크론에서 1분 간격으로 실행한다.

### 5.9 외부 워크플로우 연동 (n8n)

이 도구는 "감지"에 집중하고, 알림 이후의 후처리(티켓 생성, 문서 기록, 다단계 승인 등)는 n8n 같은 워크플로우 자동화 도구에 위임할 수 있어야 한다. 세 가지 연동 방식을 지원 수준과 함께 정의한다.

| 방식 | 구조 | 지원 수준 | 비고 |
| --- | --- | --- | --- |
| A. 이벤트 푸시 (기본) | 이 도구 → `webhook` 채널 → n8n Webhook Trigger | P1, 공식 지원 | n8n Cloud/셀프호스팅 모두 가능 |
| B. n8n이 CLI 실행 | n8n Schedule Trigger → Execute Command(`npx play-review-notify run --json`) → n8n 노드로 라우팅 | P2, 문서·예시 제공 | Execute Command는 셀프호스팅 전용 |
| C. n8n 커뮤니티 노드 | 코어 라이브러리를 감싼 `n8n-nodes-google-play-review-notify` | Phase 4 검토 | 룰셋 이중 관리를 피하기 위해 코어 재사용 필수 |

n8n 네이티브 노드만으로 전체 파이프라인을 재구현하는 방식은 이메일 룰셋과 중복 제거 로직이 이중화되므로 채택하지 않는다.

#### 5.9.1 Webhook 이벤트 페이로드

- **FR-INTEG-1 (P1)** 페이로드는 버전 필드를 가진 JSON이며, 스키마는 JSON Schema로 배포한다(`schemas/webhook-event.v1.json`). 하위 호환이 깨지는 변경은 `payloadVersion`을 올린다.
- **FR-INTEG-2 (P1)** `raw` 필드는 페이로드에 포함하지 않는다. `reason`은 `includeReason`과 길이 제한을 따른다.

```json
{
  "payloadVersion": 1,
  "sentAt": "2026-09-07T09:00:03Z",
  "event": {
    "id": "email:18f3...",
    "type": "REJECTED",
    "packageName": "com.example.app",
    "appName": "Example App",
    "track": "production",
    "versionCode": "1204",
    "versionName": "3.4.2",
    "reason": "The app's ...",
    "consoleUrl": "https://play.google.com/console/...",
    "source": "email",
    "confidence": "high",
    "observedAt": "2026-09-07T09:00:00Z"
  },
  "app": { "packageName": "com.example.app", "name": "Example App", "tracks": ["production"] },
  "run": { "id": "gha:1234567890", "dryRun": false }
}
```

요청 헤더:

| 헤더 | 값 |
| --- | --- |
| `Content-Type` | `application/json` |
| `User-Agent` | `google-play-review-notify/<version>` |
| `X-Play-Review-Event` | 이벤트 타입 (예: `REJECTED`) |
| `X-Play-Review-Timestamp` | Unix epoch 초 |
| `X-Play-Review-Signature` | `sha256=<HMAC-SHA256(secret, timestamp + "." + body)>` (secret 설정 시) |

- **FR-INTEG-3 (P1)** 2xx 이외 응답은 실패로 간주해 FR-NOTIFY-4의 재시도 정책을 따른다. 재전송 시 동일 `event.id`를 유지하므로 수신 측은 `event.id`로 멱등 처리할 수 있다.

#### 5.9.2 n8n 예시 워크플로우

- **FR-INTEG-4 (P1)** `examples/n8n/` 아래에 바로 가져오기(import) 가능한 워크플로우 JSON을 제공한다.
  - `webhook-to-slack-discord.json`: Webhook Trigger → HMAC 검증(Code 노드) → Switch(이벤트 타입) → Slack/Discord 노드
  - `rejected-to-jira.json`: `REJECTED` 이벤트를 Jira 이슈로 생성하고 채널에 링크 회신
  - `schedule-execute-cli.json`(방식 B): Schedule Trigger → Execute Command → Split Out → 알림 노드
- **FR-INTEG-5 (P2)** 문서에 n8n Cloud와 셀프호스팅의 차이(Execute Command 가용성, Webhook URL의 test/production 구분)를 명시한다.

#### 5.9.3 방식 B 사용 시 참고

- CLI 종료 코드와 `--json` 출력(FR-CLI-1, FR-CLI-2)을 그대로 사용한다. `--json` 출력의 최상위는 `{ "events": ReviewEvent[], "summary": {...} }`로 고정한다.
- 상태 저장은 `file` 저장소를 쓰며 n8n 컨테이너의 영속 볼륨 경로를 지정한다.
- 이 방식에서는 이 도구의 채널 설정을 비우고(`channels: {}`) n8n이 모든 알림을 담당하는 구성을 권장한다.

## 6. 비기능 요구사항

| 영역 | 요구사항 |
| --- | --- |
| 보안 | 최소 스코프(`gmail.readonly`, Play Console 읽기 권한). 시크릿은 로그에 마스킹. 이메일 본문·raw 응답은 상태·알림에 저장하지 않음. 의존성 취약점 CI 검사. |
| 신뢰성 | 모든 알림은 멱등. 소스 하나의 실패가 다른 소스·알림을 막지 않음(부분 실패 허용). 네트워크 오류 재시도. |
| 성능 | 앱 5개·소스 3개 기준 1회 실행 30초 이내. Gmail 조회는 `q` 필터로 서버 측 필터링. |
| 관측성 | 구조화 로그, 실행 요약(감지 이벤트 수, 전송 결과), Action Job Summary. `--verbose`로 소스별 원본 응답 요약. |
| 호환성 | Node 20/22, ubuntu/macos/windows 러너, GitHub Enterprise Server. |
| 테스트 | 단위(룰셋 파싱, 상태 diff, 템플릿) 90% 이상. 이메일 픽스처 기반 회귀 테스트. Play API·Gmail·webhook은 mock. E2E는 dry-run 워크플로우. |
| 문서 | README(5분 시작 가이드), Gmail OAuth 설정 가이드, 서비스 계정 가이드, 설정 레퍼런스, 어댑터 개발 가이드. 한/영 병기. |
| 라이선스 | 저장소 LICENSE(Apache-2.0) 유지. |

## 7. 아키텍처 개요

```
┌────────────┐  ┌─────────────┐  ┌───────────────┐
│ Email      │  │ Play API    │  │ Store Listing │   SourceAdapter[]
│ (Gmail)    │  │ (androidpub)│  │ (HTML)        │
└─────┬──────┘  └──────┬──────┘  └──────┬────────┘
      └────────────────┼────────────────┘
                       ▼
             ┌───────────────────┐
             │ Normalizer        │  → ReviewEvent[]
             └─────────┬─────────┘
                       ▼
             ┌───────────────────┐      ┌────────────┐
             │ Dedupe / Diff     │◄────►│ StateStore │ (github-cache | file | custom)
             └─────────┬─────────┘      └────────────┘
                       ▼
             ┌───────────────────┐
             │ Router + Template │  (앱별·이벤트별 채널, 템플릿 렌더링)
             └─────────┬─────────┘
                       ▼
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
  ┌───────────┐  ┌───────────┐  ┌───────────────┐
  │ Slack     │  │ Discord   │  │ HTTP Webhook  │   Notifier[]
  └───────────┘  └───────────┘  └───────┬───────┘
                                        ▼
                                  n8n / Make / 자체 서버

  진입점: CLI (`run`) / GitHub Action (`dist/index.js`) → 동일한 `runOnce(config)` 호출
```

패키지 구조(가안, 단일 npm 패키지):

```
src/
  core/        # runOnce, event model, dedupe, router
  sources/     # email/, play-api/, store-listing/, manual/
  notifiers/   # slack/, discord/, webhook/
  state/       # github-cache, file, none
  templates/   # 기본 템플릿
  rules/email/ # 이메일 분류 룰셋 (locale별 JSON)
  schemas/     # 설정 및 webhook 페이로드 JSON Schema
examples/n8n/  # 가져오기 가능한 n8n 워크플로우 JSON
  cli/         # commander 기반 명령
  action/      # @actions/core 래퍼
action.yml
dist/index.js  # ncc 번들 (커밋)
```

## 8. 상세 설계 메모

### 8.1 이메일 룰셋 형식

```json
{
  "locale": "en",
  "rules": [
    {
      "type": "REJECTED",
      "subject": ["has been rejected", "Update rejected", "wasn't published"],
      "body": [],
      "extract": {
        "appName": "regex:Your app (.+?) \\(",
        "packageName": "regex:\\(([a-z][a-z0-9_]*(\\.[a-z0-9_]+)+)\\)",
        "reason": "section:Issue|Reason|Policy"
      }
    }
  ]
}
```

- 룰은 위에서 아래로 평가하고 첫 매치를 채택한다. 매치 없음 + 발신자 allowlist 통과 = `UNKNOWN_NOTICE`.
- Phase 0에서 실제 이메일 샘플(승인, 거절, 정책 경고, 삭제, 계정 정지)을 수집해 픽스처로 저장하고 룰을 확정한다. 이 문서의 패턴 문자열은 검증 전 초안이다.

### 8.2 Play API 추론 결정표 (가설 — Phase 0에서 확정)

| 이전 상태 | 현재 관측 | 이벤트 | confidence |
| --- | --- | --- | --- |
| versionCode V 없음 | 트랙에 V (completed/inProgress) | `SUBMITTED` | medium |
| V 관측됨, LIVE 미확인 | 이메일 APPROVED 또는 스토어 리스팅 변경 | `LIVE` | high |
| V 관측됨 | V 사라짐, 더 높은 버전 없음 | (기록만) 거절 후보 | low |
| V 관측됨 | V 사라짐, 더 높은 버전 W 등장 | `SUBMITTED`(W) | medium |
| status halted | — | (기록만) | — |

검증 항목: 심사 중 상태에서 `edits.tracks.get`이 새 릴리즈를 어떻게 노출하는지, 거절 후 릴리즈가 트랙에서 제거되는지, 관리형 게시(managed publishing) 사용 시 차이.

### 8.3 상태 스키마

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-09-07T09:00:00Z",
  "email": {
    "watermark": "2026-09-07T08:50:00Z",
    "processedMessageIds": ["18f3..."]
  },
  "apps": {
    "com.example.app": {
      "tracks": {
        "production": { "versionCodes": ["1203"], "status": "completed", "observedAt": "..." }
      },
      "storeListing": { "versionName": "3.4.1", "updatedOn": "Sep 5, 2026" },
      "lastLiveVersionCode": "1203"
    }
  },
  "events": {
    "email:18f3...": { "type": "REJECTED", "at": "...", "delivered": true, "attempts": 1 }
  }
}
```

- `events`는 최근 500건 또는 30일로 제한해 크기를 관리한다.

### 8.4 알림 메시지 기본 형식 (Slack 예)

```
🚫 REJECTED — Example App (com.example.app)
Track: production · Version: 3.4.2 (1204)
Reason: The app's ... (truncated)
Open in Play Console →
Source: email · 2026-09-07 09:00 UTC
```

이벤트별 색상: SUBMITTED 회색, APPROVED/LIVE 초록, REJECTED 빨강, POLICY_WARNING 주황, REMOVED/SUSPENDED 진빨강.

## 9. 배포 및 릴리즈

- npm: `play-review-notify`. `npx play-review-notify run`.
- GitHub Marketplace: `JaesungLeee/google-play-review-notify`. `v1` 메이저 태그를 최신 v1.x로 이동 유지.
- 릴리즈 자동화: Conventional Commits → changesets 또는 release-please로 CHANGELOG·태그·npm publish·`dist/` 번들 갱신.
- 이메일 룰셋 변경은 patch 버전으로 빠르게 배포한다.

## 10. 로드맵

| Phase | 범위 | 완료 기준 |
| --- | --- | --- |
| **0. 기술 검증 (스파이크)** | 실제 계정으로 이메일 샘플 수집, Play API 트랙 응답 관찰(심사 중/거절/승인 각 1회 이상), 스토어 리스팅 파싱 가능성 확인 | 8.1 룰셋 초안 픽스처 확보, 8.2 결정표 확정 |
| **1. MVP** | 코어 파이프라인, 이메일 어댑터, Slack/Discord webhook, file/github-cache 상태 저장, CLI `run/auth gmail/test-notify`, GitHub Action, README | 실제 앱 1개에서 승인·거절 알림 수신 성공 |
| **2. 보조 신호 & 편의** | Play API 어댑터(SUBMITTED/LIVE), 앱별 라우팅, 템플릿 오버라이드, 범용 Webhook 채널(HMAC 서명, 페이로드 스키마), n8n 예시 워크플로우, `doctor`, `init`, Job Summary, 재사용 워크플로우 | 앱 2개 이상·채널 2개 이상 시나리오 통과, n8n Webhook Trigger로 이벤트 수신 확인 |
| **3. 확장** | 스토어 리스팅 어댑터, `emit`, 한국어 룰셋, 커스텀 StateStore/Notifier 로딩, Marketplace 등록, n8n Execute Command 방식 가이드 | 외부 저장소 도입 사례 1건 |
| **4. 생태계** | n8n 커뮤니티 노드(`n8n-nodes-google-play-review-notify`, 코어 라이브러리 재사용) | n8n 커뮤니티 노드 등록 |

## 11. 성공 지표

- 승인/거절 이메일 도착 후 알림까지 지연: 스케줄 간격 + 1분 이내 (P95)
- 오탐(잘못된 이벤트 타입) 비율: 픽스처 기준 0%, 운영 기준 월 1건 이하
- 중복 알림: 0건
- 신규 프로젝트 도입 소요 시간: 15분 이내(문서 기준 워크스루)
- 외부 프로젝트 도입 수, GitHub Stars/이슈 응답 시간(오픈소스 지표)

## 12. 리스크와 대응

| 리스크 | 영향 | 대응 |
| --- | --- | --- |
| Google이 이메일 제목/본문 형식을 변경 | 분류 실패 → 알림 누락 | `UNKNOWN_NOTICE` 이벤트로 최소 알림(옵션), 룰셋 패치 릴리즈, 픽스처 회귀 테스트 |
| Play Console이 일부 거절에 이메일을 보내지 않음(커뮤니티 보고 존재) | 감지 누락 | API 어댑터의 거절 후보 기록 + `doctor`로 안내, 문서에 한계 명시 |
| Gmail Refresh Token 만료(테스트 모드 OAuth 앱은 7일) | 인증 실패 | 문서에 OAuth 앱을 "프로덕션" 상태로 게시하도록 안내, 실패 시 1회 경고 알림 |
| Actions Cache 7일 만료 | 상태 유실 → 재베이스라인 | 스케줄이 7일 이내로 돌면 문제 없음, 유실 시 알림 없이 재기준점(D11), 커스텀 저장소 확장 여지 |
| 스토어 리스팅 HTML 변경 | 파싱 실패 | 기본 비활성, 실패 허용, 연속 실패 시 경고 |
| 개인 Gmail 계정 의존 | 담당자 퇴사 시 중단 | 조직 공용 개발자 계정/그룹 메일 사용 권고 문서화 |
| 서비스 계정 권한 과다 부여 | 보안 | 읽기 전용 권한만 요구하고 `doctor`에서 권한 과다 경고 |

## 13. 오픈 이슈

1. Play Console이 "심사 중 진입" 이메일을 보내지 않는 경우가 대부분이므로, `SUBMITTED` 이벤트는 API 어댑터 또는 `emit`에 의존한다. Phase 0에서 API 관측으로 충분한지 확인 필요.
2. 이메일에 패키지명이 포함되지 않는 케이스 비율 확인 후 앱명 매칭 전략 확정.
3. ~~npm 패키지명·GitHub 조직명 확정.~~ → 확정: npm `play-review-notify`(스코프 없는 짧은 이름, `@jaesunglee/google-play-review-notify`에서 변경, 2026-09-08), GitHub `JaesungLeee/google-play-review-notify` (2026-09-07)
4. 관리형 게시(managed publishing)를 사용하는 앱에서 "승인됨(게시 대기)"과 "라이브"를 구분하는 UX 결정.
5. Google Workspace 도메인 전체 위임 방식 지원 여부 — 현재 비목표, 요청이 있으면 P2로 검토.
6. n8n 커뮤니티 노드를 만들 경우 트리거 노드(폴링) 형태로 할지, 액션 노드(1회 실행) 형태로 할지 결정 필요. 코어 라이브러리의 `runOnce(config)`를 그대로 호출하는 액션 노드가 구현이 단순하다.

## 14. 부록: 용어

- **트랙(Track)**: production, beta(open testing), alpha(closed testing), internal, 사용자 정의 트랙
- **versionCode / versionName**: Android 빌드의 정수 버전과 표시 버전
- **관리형 게시(Managed publishing)**: 심사 승인 후 개발자가 수동으로 게시 시점을 정하는 Play Console 옵션
- **Incoming Webhook**: Slack/Discord가 제공하는 URL 기반 메시지 수신 엔드포인트
- **n8n**: 노드 기반 워크플로우 자동화 도구. Webhook Trigger 노드로 외부 HTTP 요청을 받아 워크플로우를 시작할 수 있으며, 셀프호스팅에서는 Execute Command 노드로 셸 명령을 실행할 수 있다.
