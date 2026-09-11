# Play Developer API 연동 설정 (서비스 계정)

English: [play-api-setup.md](./play-api-setup.md)

Play API 소스는 설정한 트랙의 모든 릴리스를 심사 생명주기(`applications.tracks.releases.list`)로 추적해 `PENDING_SUBMISSION`, `SUBMITTED`, `APPROVED`, `REJECTED`, `LIVE`를 알립니다.
인증에는 Google Cloud **서비스 계정** JSON 키가 필요하고, Play Console에서는 **읽기 전용** 권한만 주면 됩니다.

> Play API가 알려주지 **못하는** 것: 거부 사유와 계정 단위 정책 안내. 이 둘은 이메일 소스가 담당합니다. 전이표는 [design.md](./design.md#play-api-transition-table)(영어)를 참고하세요.

| 환경 변수                   | 값                                 |
| --------------------------- | ---------------------------------- |
| `PLAY_SERVICE_ACCOUNT_JSON` | 서비스 계정 키 JSON **내용** 전체 |

로컬 CLI에서는 JSON 내용 대신 키 파일 경로를 설정에 직접 적어도 됩니다(`serviceAccountJson: /path/to/key.json`).

## 1. Google Cloud 프로젝트와 API

1. https://console.cloud.google.com 에서 프로젝트를 선택하거나 새로 만듭니다. Gmail용 프로젝트와 같이 써도 됩니다.
2. 아래 주소에서 **Google Play Android Developer API**를 **사용** 설정합니다.

   ```
   https://console.cloud.google.com/apis/library/androidpublisher.googleapis.com
   ```

Play Console에 Cloud 프로젝트를 "연결"하는 단계는 더 이상 필요 없습니다. 최신 Play Console에는 그 메뉴가 없습니다.

## 2. 서비스 계정과 키

1. https://console.cloud.google.com/iam-admin/serviceaccounts → **+ 서비스 계정 만들기**.
2. 이름(예: `play-review-notify`) 입력 → **만들고 계속하기** → 역할 부여는 건너뛰고 **완료**. Cloud IAM 역할은 필요 없습니다.
3. 만들어진 계정의 **이메일**(`이름@프로젝트ID.iam.gserviceaccount.com`)을 복사해 둡니다.
4. 계정 클릭 → **키** 탭 → **키 추가 → 새 키 만들기 → JSON**. 내려받은 파일을 저장소 밖에 보관합니다.

## 3. Play Console에서 앱 권한 부여

1. https://play.google.com/console → **사용자 및 권한 → 새 사용자 초대**.
2. 이메일에 2단계의 서비스 계정 이메일을 입력합니다.
3. **앱 권한** 탭 → **앱 추가** → 감시할 앱 선택 → **"앱 정보 보기(읽기 전용)"** 만 체크.
4. **사용자 초대**. 서비스 계정은 초대 수락이 필요 없고 바로 활성화되지만, API에 반영되기까지 몇 분에서 수십 분 걸릴 수 있습니다.

## 4. 설정

```yaml
sources:
  playApi:
    enabled: true
    serviceAccountJson: ${PLAY_SERVICE_ACCOUNT_JSON}

events:
  # SUBMITTED: { enabled: true }            # 기본 꺼짐
  # PENDING_SUBMISSION: { enabled: true }   # 기본 꺼짐
  # LIVE: { mergeInto: APPROVED }           # 승인 + 출시 대신 릴리스당 메시지 하나
```

GitHub Actions에서는 키 파일 내용을 통째로 `PLAY_SERVICE_ACCOUNT_JSON` 시크릿에 넣고, Action 입력 `play-service-account-json`으로 넘깁니다.

동작 확인:

```bash
npx play-review-notify doctor
# ✔ play-api.com.example.app: com.example.app: production=[1.1.0:IN_REVIEW(4)]
npx play-review-notify run --dry-run --verbose
# [DEBUG] Play API com.example.app/production: release 1.1.0 IN_REVIEW → APPROVED_NOT_PUBLISHED
```

응답 원본을 그대로 보고 싶으면 스파이크 스크립트를 쓰세요.

```bash
PLAY_SERVICE_ACCOUNT_FILE=~/secrets/play-sa.json npm run spike:play -- com.example.app snapshot
```

## 감지 규칙

어댑터는 릴리스마다 `releaseLifecycleState`를 기억하고, 새 상태에 들어갈 때마다 이벤트를 하나씩 냅니다.

| 진입한 상태              | 이벤트                                                              |
| ------------------------ | ------------------------------------------------------------------- |
| `NOT_SENT_FOR_REVIEW`    | `PENDING_SUBMISSION`                                                |
| `IN_REVIEW`              | `SUBMITTED`                                                         |
| `APPROVED_NOT_PUBLISHED` | `APPROVED` (관리형 게시: 게시 버튼 대기 중)                          |
| `NOT_APPROVED`           | `REJECTED` (사유는 메일이 후속 알림으로 추가)                        |
| `PUBLISHED`              | `LIVE`. 승인을 관측하지 못했으면(관리형 게시 꺼짐) `APPROVED`를 먼저 냄 |

패키지나 트랙의 첫 관측은 상태만 기록합니다. 목록에서 사라진 릴리스는 이벤트 없이 잊습니다. 전체 표는 [design.md](./design.md#play-api-transition-table)(영어)에 있습니다.

이벤트 id는 `api:<패키지>:<트랙>:<versionCode>:<TYPE>`로, CI에서 업로드 직후 `emit --type SUBMITTED`로 보낸 이벤트와 같은 키를 씁니다. 둘을 함께 써도 알림은 한 번만 갑니다.

## 문제 해결

| 증상                                                   | 원인과 조치                                                                              |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `403 ... insufficient permissions` / `not have permission` | 3단계 권한 반영 대기 중이거나 앱 권한에 해당 앱이 없습니다. 10분 뒤 재시도.                |
| `403 ... accessNotConfigured` / `API has not been used`  | 1단계 API가 꺼져 있습니다. 메시지의 링크에서 사용 설정.                                   |
| `404 Package not found`                                | 서비스 계정을 초대한 개발자 계정에 그 앱이 없습니다. 앱이 있는 계정에서 초대했는지 확인. |
| `invalid_grant` / `Invalid JWT`                        | 키 JSON이 깨졌거나 시스템 시계가 틀렸습니다. 키를 다시 내려받거나 시간을 동기화.          |
