# Gmail 연동 설정 (OAuth Refresh Token 발급)

이 도구는 Google Play가 개발자 계정으로 보내는 알림 메일(거절, 정책 경고 등)을 Gmail API로 읽습니다.
Gmail API는 아이디·비밀번호로 쓸 수 없고 OAuth 동의를 거쳐 발급된 **Refresh Token**이 필요합니다.
아래 절차는 처음 한 번만 하면 되고, 결과로 환경 변수 세 개가 나옵니다.

| 환경 변수              | 값                       |
| ---------------------- | ------------------------ |
| `GMAIL_CLIENT_ID`      | OAuth 클라이언트 ID      |
| `GMAIL_CLIENT_SECRET`  | OAuth 클라이언트 시크릿  |
| `GMAIL_REFRESH_TOKEN`  | `auth gmail`이 출력한 값 |

요청하는 권한은 `https://www.googleapis.com/auth/gmail.readonly` 하나뿐입니다. 메일을 보내거나 지우거나 라벨을 바꿀 수 없습니다.

## 1. Google Cloud 프로젝트와 Gmail API

1. https://console.cloud.google.com 에서 프로젝트를 선택하거나 새로 만듭니다. Play API용으로 만든 프로젝트를 같이 써도 됩니다.
2. 아래 주소로 가서 **Gmail API**를 **사용** 설정합니다.

   ```
   https://console.cloud.google.com/apis/library/gmail.googleapis.com
   ```

## 2. OAuth 동의 화면

1. **API 및 서비스 → OAuth 동의 화면** (또는 "Google Auth Platform → 브랜딩").
2. 사용자 유형은 개인 Gmail 계정이면 **외부**, Google Workspace 조직 계정만 쓰면 **내부**를 선택합니다.
3. 앱 이름(예: `play-review-notify`)과 지원 이메일만 채우고 저장합니다. 범위(scope)는 따로 추가하지 않아도 됩니다.
4. **외부**를 골랐다면 **테스트 사용자**에 알림 메일을 받는 Gmail 주소를 추가합니다.

> **중요**: 동의 화면이 "테스트" 상태이면 Refresh Token이 **7일 뒤 만료**됩니다.
> 계속 쓰려면 "앱 게시" 버튼으로 **프로덕션** 상태로 바꾸세요. 민감하지 않은 범위만 쓰므로 Google 검토 없이 바로 전환되며, 검토 미완료 경고가 떠도 본인 계정으로 쓰는 데는 문제가 없습니다.

## 3. OAuth 클라이언트 만들기

1. **API 및 서비스 → 사용자 인증 정보 → 사용자 인증 정보 만들기 → OAuth 클라이언트 ID**.
2. 애플리케이션 유형은 반드시 **데스크톱 앱**을 선택합니다. `auth gmail`은 `http://127.0.0.1:<임의 포트>`로 돌아오는 방식을 쓰는데, 이 유형만 포트를 자유롭게 허용합니다. "웹 애플리케이션" 유형은 동작하지 않습니다.
3. 이름을 정하고 만들면 **클라이언트 ID**와 **클라이언트 보안 비밀번호**가 표시됩니다. 두 값을 복사해 둡니다.

## 4. Refresh Token 발급

알림 메일을 받는 Gmail 계정으로 로그인할 수 있는 컴퓨터에서 실행합니다.

```bash
export GMAIL_CLIENT_ID="...apps.googleusercontent.com"
export GMAIL_CLIENT_SECRET="..."
npx play-review-notify auth gmail
```

1. 브라우저가 열리고 Google 로그인 화면이 나옵니다. **알림 메일을 받는 계정**을 선택하세요.
2. "확인되지 않은 앱" 경고가 나오면 **고급 → (앱 이름)(으)로 이동**을 누릅니다. 본인이 방금 만든 앱입니다.
3. Gmail 읽기 권한에 **허용**을 누르면 브라우저에 "Authorization complete"가 뜨고 터미널에 토큰이 출력됩니다.

```
Authorized as you@gmail.com. Add this to your environment or CI secrets:

GMAIL_REFRESH_TOKEN=1//0g...
```

옵션:

- `--no-open`: 브라우저를 자동으로 열지 않고 URL만 출력합니다. SSH 접속 중이면 URL을 로컬 브라우저에 붙여넣되, 리디렉션이 `127.0.0.1`로 오므로 **같은 컴퓨터**에서 명령을 실행해야 합니다.
- `--port 8089`: 콜백 포트를 고정합니다. 기본은 빈 포트를 자동 선택합니다.
- `--json`: 결과를 `{"refreshToken":"...","emailAddress":"..."}` 형태로 출력합니다.

## 5. 값 저장

- 로컬/서버: `.env` 또는 셸 환경 변수로 세 값을 설정합니다. 설정 파일에는 `${GMAIL_CLIENT_ID}`처럼 참조만 적습니다.
- GitHub Actions: 저장소 **Settings → Secrets and variables → Actions**에 `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`을 등록하고 워크플로우 `env`로 넘깁니다.

동작 확인:

```bash
npx play-review-notify run --dry-run --verbose
```

## 문제 해결

| 증상                                              | 원인과 조치                                                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `redirect_uri_mismatch`                           | OAuth 클라이언트 유형이 "데스크톱 앱"이 아닙니다. 3단계에서 새로 만드세요.                                   |
| `access_denied` / "앱이 확인되지 않음"에서 막힘   | 외부 유형인데 테스트 사용자에 계정이 없습니다. 2단계 4번을 확인하세요.                                        |
| `Google did not return a refresh token`           | 이전에 같은 클라이언트를 승인한 적이 있습니다. https://myaccount.google.com/permissions 에서 앱을 삭제 후 재시도. |
| 며칠 뒤 `invalid_grant`                           | 동의 화면이 테스트 상태라 토큰이 만료됐습니다. 프로덕션으로 게시하고 다시 발급하세요.                         |
| 회사 계정에서 "관리자가 차단"                      | Workspace 관리자가 서드파티 앱을 제한한 상태입니다. 관리자에게 이 클라이언트 ID 허용을 요청하세요.            |

## 권장 사항

- 담당자 개인 계정보다 팀 공용 개발자 계정이나 그룹 메일을 쓰면 퇴사·이직 시 중단을 막을 수 있습니다.
- Refresh Token은 비밀번호와 같습니다. 저장소에 커밋하지 말고, 유출이 의심되면 위 권한 페이지에서 앱을 삭제해 즉시 무효화하세요.
