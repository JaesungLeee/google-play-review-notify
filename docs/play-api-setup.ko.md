# Play Developer API 연동 설정 (서비스 계정)

English: [play-api-setup.md](./play-api-setup.md)

Play API 소스는 트랙에 새 versionCode가 나타나는 순간을 `SUBMITTED` 이벤트로 알립니다.
인증에는 Google Cloud **서비스 계정** JSON 키가 필요하고, Play Console에서는 **읽기 전용** 권한만 주면 됩니다.

> Play API가 알려주지 **못하는** 것: 심사 중·승인·거절 상태. 심사 중인 릴리즈도 `status: completed`로 보고됩니다(Phase 0에서 실제 확인).
> 거절은 이메일 소스, 라이브는 스토어 리스팅 소스가 담당합니다. 결정표는 [design.md](./design.md#play-api-decision-table)(영어)를 참고하세요.

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
    # emitLiveWithoutConfirmation: true   # 스토어 페이지가 없는 앱(내부 테스트 전용 등)에서만 고려
```

GitHub Actions에서는 키 파일 내용을 통째로 `PLAY_SERVICE_ACCOUNT_JSON` 시크릿에 넣고, Action 입력 `play-service-account-json`으로 넘깁니다.

동작 확인:

```bash
npx play-review-notify run --dry-run --verbose
# [DEBUG] Play API com.example.app: production=[3] ...
```

응답 원본을 그대로 보고 싶으면 스파이크 스크립트를 쓰세요.

```bash
PLAY_SERVICE_ACCOUNT_FILE=~/secrets/play-sa.json npm run spike:play -- com.example.app snapshot
```

## 감지 규칙

| 이전 상태            | 현재 관측                       | 동작                                                 |
| -------------------- | ------------------------------- | ---------------------------------------------------- |
| 패키지 첫 관측       | 무엇이든                        | 기록만                                               |
| versionCode V 없음   | 트랙에 V 등장                   | `SUBMITTED` (confidence medium), 릴리즈 이름을 버전명으로 |
| V 있음               | V 사라짐, 더 높은 버전 없음     | 로그만 (거절 후보). 거절 메일이 오면 그쪽에서 알림   |
| V 있음               | V 사라짐, 더 높은 W 등장        | `SUBMITTED`(W)                                       |
| 어떤 상태든          | `completed`/`inProgress`        | `emitLiveWithoutConfirmation: true`일 때만 `LIVE` (low) |

이벤트 id는 `api:<패키지>:<트랙>:<versionCode>:SUBMITTED`로, CI에서 업로드 직후 `emit --type SUBMITTED`로 보낸 이벤트와 같은 키를 씁니다. 둘을 함께 써도 알림은 한 번만 갑니다.

## 문제 해결

| 증상                                                   | 원인과 조치                                                                              |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `403 ... insufficient permissions` / `not have permission` | 3단계 권한 반영 대기 중이거나 앱 권한에 해당 앱이 없습니다. 10분 뒤 재시도.                |
| `403 ... accessNotConfigured` / `API has not been used`  | 1단계 API가 꺼져 있습니다. 메시지의 링크에서 사용 설정.                                   |
| `404 Package not found`                                | 서비스 계정을 초대한 개발자 계정에 그 앱이 없습니다. 앱이 있는 계정에서 초대했는지 확인. |
| `invalid_grant` / `Invalid JWT`                        | 키 JSON이 깨졌거나 시스템 시계가 틀렸습니다. 키를 다시 내려받거나 시간을 동기화.          |
