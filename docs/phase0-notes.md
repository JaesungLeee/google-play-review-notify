# Phase 0 관측 노트

PRD §10 Phase 0(기술 검증) 진행 기록. 실제 계정으로 확인한 사실만 적고, 확정되면 PRD에 반영한다.

## 관측 대상

| 항목 | 값 |
| --- | --- |
| 패키지 | `com.mino.gguk` (첫 출시, 2026-09-08 기준 심사 중, 스토어 미게시) |
| 트랙 | production |
| 관리형 게시 | 사용 중 (켬/끔 모두 지원이 목표) |
| Play Console 이메일 알림 | "앱 게시 업데이트" 모든 앱에 대해 이메일 사용 중 |
| Play Console 언어 | 한국어 (알림 메일 대부분 한국어, 2023년 메일 1통은 영어) |

## 확인된 사실 (2026-09-08)

### 이메일

- **거절과 경고는 제목이 같다.** `조치 필요: 앱이 Google Play 정책을 준수하지 않음(앱명)` 제목으로 거절(KokKok, 찰나)과 기한부 경고(PIC)가 모두 온다. 본문 `Publishing Status` 아래 줄이 `앱 상태: 거부됨`이면 거절, `상태: 추가 조치 필요`면 경고다. 영어도 동일하게 `App Status: Rejected`. 룰은 이 본문 줄로 판정하도록 수정했다.
- 본문 구조: `앱명(패키지명) 앱을 검토한 결과` 문장에서 앱명·패키지명, `발견된 문제: <사유>` 줄에서 사유, `버전 코드: N:` 에서 versionCode를 추출한다. 영어는 `your app <앱명> (<패키지명>)`, `Issue found: <사유>`.
- 정책·심사 결과 메일은 `Google Play Support <no-reply-googleplay-developer@google.com>`, 뉴스레터·약관·세금 공지는 `Google Play <googleplay-noreply@google.com>`에서 온다. 둘 다 allowlist에 두되 후자는 대부분 `UNKNOWN_NOTICE`로 분류된다(기본 알림 꺼짐).

- 발신자는 `Google Play Support <no-reply-googleplay-developer@google.com>`. PRD 기본 allowlist(`googleplay-noreply@google.com`, `googleplay-developer-support@google.com`)에 없던 주소이므로 기본값을 교체해야 한다.
- 수집한 메일 9통 모두 `text/plain` 파트가 있어 HTML 파싱 없이 본문을 읽을 수 있다.
- 업데이트 거절 메일 제목: 한국어 `조치 필요: 앱이 Google Play 정책을 준수하지 않음`, 영어 `Action Required: Your app is not compliant with Google Play Policies`. 제목만으로는 "업데이트 거절"과 "기존 앱 정책 경고"를 구분할 수 없을 가능성이 있어 본문 패턴 분석이 필요하다.
- 기존 앱 정책 경고 메일 제목: `[조치 필요] 귀하의 앱이 Google Play 대상 API 수준 요구사항의 영향을 받습니다`.
- **일반 업데이트 승인 시 이메일이 오지 않는다**(사용자 경험 기준). PRD의 "APPROVED는 이메일이 1차 출처" 가정은 성립하지 않는다. 승인은 Play API 관측 또는 스토어 리스팅 변화로 추론해야 한다.

### 스토어 리스팅

- 공개 앱 페이지 HTML에 "업데이트 날짜"가 `2026. 9. 4.` 형태(ko/KR)로 포함되어 추출 가능하다.
- 미게시 앱은 HTTP 404. 첫 출시 전에는 스토어 신호를 쓸 수 없다.
- 관리형 게시 사용 시 승인과 실제 게시 사이의 "게시 대기" 상태는 스토어로 알 수 없다.

## 픽스처 정답표

`test/fixtures/email/private/` (git 제외)에 보관. 마스킹 후 `test/fixtures/email/`에 커밋 예정.

| 파일 (앱) | 날짜 | 언어 | 정답 |
| --- | --- | --- | --- |
| 술술 | 2023-08-02 | en | REJECTED (업데이트 거절) |
| PIC | 2025-04-11 | ko | POLICY_WARNING (본문 `상태: 추가 조치 필요`, 기한부 시정 요구. 사용자 기억은 "업데이트 거절"이었으나 본문 기준으로 정정) |
| KokKok | 2025-07-30 | ko | REJECTED (업데이트 거절) |
| 찰나 - Challa | 2026-08-31 | ko | REJECTED (업데이트 거절) |
| 대상 API 수준 요구사항 | 2026-07-21 | ko | POLICY_WARNING (기존 앱 경고) |
| Google Play 서비스 약관 업데이트 | 2026-07-08 | ko | 무관 (알림 대상 아님) |
| 북마케도니아 세금 변경 | 2026-08-12 | ko | 무관 |
| Android 개발자 인증 요구사항 최종 알림 | 2026-09-03 | ko | 무관 |
| Brazil Digital Child and Adolescent | 2026-03-09 | en | 무관 |

### Play API (2026-09-08 심사 중 스냅샷)

- **심사 중인 첫 출시 릴리즈가 `tracks.list`에 `status: completed`로 보인다.** 같은 시각 스토어 페이지는 404. 즉 API의 `completed`는 "개발자가 의도한 상태"이고 심사 통과·라이브 여부와 무관하다. 가설 B 확정: **API만으로는 심사 중 / 승인 / 라이브를 구분할 수 없다.**
- 관리형 게시가 켜져 있어도 릴리즈는 `completed`로 표시된다. "게시 대기" 상태도 API로 구분되지 않을 가능성이 높다(승인 후 스냅샷으로 재확인).
- `bundles.list`는 업로드된 모든 versionCode(1, 2, 3)를 보여준다. 트랙에 올리지 않은 빌드까지 포함되므로 SUBMITTED 판단에는 `tracks.list`의 versionCodes를 써야 한다.
- `details.get`에는 연락처 이메일·전화번호가 포함된다. 스냅샷은 git 제외 폴더에만 두고, 어댑터 구현에서는 `details.get`을 호출하지 않는다.
- 결론: SUBMITTED는 API(트랙에 새 versionCode 등장), REJECTED는 이메일, LIVE는 스토어 리스팅(production 한정)으로 감지한다. APPROVED(관리형 게시의 게시 대기)는 이메일이 오는지에 달려 있다.

## Play API 관측 로그

`npm run spike:play -- com.mino.gguk <label>` 로 스냅샷을 `test/fixtures/play-api/private/`에 저장한다.
핵심 질문: **심사 중인 릴리즈가 `tracks.list`에 보이는가, 보인다면 status는 무엇인가.**

| 시점 | label | 실행일 | tracks.list 관측 | bundles.list 관측 |
| --- | --- | --- | --- | --- |
| 심사 중 | `in-review` | 2026-09-08 14:54 KST | production: release `1.0.0` versionCodes `[3]` **status `completed`**. internal: 동일 릴리즈 `completed`. beta/alpha: 비어 있음 | versionCode 1, 2, 3 |
| 거절 직후 (해당 시) | `rejected` | | | |
| 승인 직후 (관리형 게시: 게시 대기) | `approved` | | | |
| 게시 버튼 클릭 후 | `published` | | | |
| 스토어 반영 확인 후 | `live` | | | |

## 미결

- 관리형 게시 "게시 대기" 상태를 API가 구분해 주는지.
- 첫 출시(이전 라이브 버전 없음)와 업데이트(라이브 버전 존재)에서 API 응답 차이.
- `com.mino.gguk` 심사 결과 메일이 오는지("앱 게시 업데이트" 알림이 켜져 있으므로 올 수도 있음). 오면 `.eml`로 보관.
