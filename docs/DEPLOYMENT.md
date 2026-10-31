# 배포 및 운영 인계

2026-10-30 동료가 공유한 운영 정보와 현재 코드 기준이다.

## 운영 정보

- 저장소: https://github.com/yejinkimis/trick-or-treat
- Vercel: `trick-or-treat-gpln`, `glowyejin-8900’s projects` 개인 Hobby 계정. 대시보드·환경변수·설정 변경은 배포 담당 동료에게 요청한다.
- 현재 배포: https://trick-or-treat-gpln.vercel.app/prototype/trick-or-treat.html
- 이 변경 배포 후 기본 주소: https://trick-or-treat-gpln.vercel.app/
- 기존 `/prototype/trick-or-treat.html` 링크는 `/`로 임시 리다이렉트한다.
- `main` 머지 때만 Production으로 자동 배포한다. Hobby 플랜은 하루 배포 100번 한도가 있고 브랜치 push마다 생기던 Preview가 한도를 다 써서, `vercel.json`의 `git.deploymentEnabled`로 다른 브랜치 배포를 껐다. Preview도 운영 Firebase를 써서 테스트에는 쓰지 않는다. 확인은 로컬 에뮬레이터에서 한다.
- 실제 PR #2에서는 Vercel이 커밋 작성자 `choubung`을 Hobby 운영 계정의 구성원으로 인식하지 못해 Preview를 차단했다. Preview 자동 생성은 현재 보장되지 않으며, 배포 담당자가 운영 계정에서 배포 권한과 진행 방법을 확인해야 한다. GitHub PR: https://github.com/yejinkimis/trick-or-treat/pull/2
- Firebase 프로젝트 ID: `trick-or-treat-89de3`
- RTDB: https://trick-or-treat-89de3-default-rtdb.asia-southeast1.firebasedatabase.app/
- Firebase 구성원: `glow.yejin@gmail.com`을 편집자로 추가 완료. Vercel 초대와 Firebase 권한은 별도로 관리한다.

## 동료에게 요청할 Vercel 설정

Root Directory는 저장소 루트로 둔다. `prototype`을 지정하면 루트의 `api/`와 `vercel.json`을 사용할 수 없다.

| 설정 | 값 |
| --- | --- |
| Framework Preset | Other |
| Node.js | 24.x |
| Install Command | npm ci |
| Build Command | npm run build |
| Output Directory | dist |
| Production Branch | main |

빌드·출력 경로는 `vercel.json`에도 지정되어 있다. 빌드는 원본 HTML로 `dist/index.html`을 만들고, 분석 활성화 시 `dist/analytics.js`도 만든다. API는 저장소 루트의 `api/`에서 실행된다.

## 환경변수

Vercel Project Settings → Environment Variables에 등록한 뒤 다시 배포한다. Production과 Preview의 적용 범위를 각각 정한다. 같은 Firebase 프로젝트를 사용하는 Preview와 Production은 계정 정보를 공유한다. 테스트 계정을 분리하려면 Preview에 별도 Firebase 프로젝트와 그 프로젝트의 서비스 계정을 지정한다.

| 이름 | Production 값 또는 가져올 위치 |
| --- | --- |
| FIREBASE_PROJECT_ID | trick-or-treat-89de3 |
| FIREBASE_API_KEY | Firebase 프로젝트 설정 → 일반 → 웹 앱의 firebaseConfig.apiKey |
| FIREBASE_AUTH_DOMAIN | trick-or-treat-89de3.firebaseapp.com |
| FIREBASE_STORAGE_BUCKET | trick-or-treat-89de3.firebasestorage.app |
| FIREBASE_MESSAGING_SENDER_ID | 891696036211 |
| FIREBASE_APP_ID | 1:891696036211:web:a9ab62f17b940f1507ed06 |
| FIREBASE_DATABASE_URL | https://trick-or-treat-89de3-default-rtdb.asia-southeast1.firebasedatabase.app |
| GAME_ADMIN_UIDS | 이벤트 운영자 계정의 Firebase UID. 여러 명이면 쉼표로 구분 |
| GAME_MINIGAMES | 선택. 노크 때 랜덤으로 낼 게임을 쉼표로 제한한다(`fish,whack,spell,catch`). 비우면 네 개 모두, 문제가 생긴 게임은 빼고 재배포한다 |
| GAME_CANDY_RAIN_AT | 선택. 사탕 비 시각을 '시작 시각/분'으로 쉼표로 잇는다(`2026-10-31T22:30:00+09:00/30`). 설정하지 않으면 기본값(10/31 22:30~23:00), 빈 문자열이면 끈다 |
| GAME_RICH_RAID_AT | 선택. 부자 털기 시각을 '시작 시각/분'으로 쉼표로 잇는다. 설정하지 않으면 기본값(10/31 23:00~23:30), 빈 문자열이면 끈다 |
| FIREBASE_SERVICE_ACCOUNT_JSON | 프로젝트 설정 → 서비스 계정 → Firebase Admin SDK의 서비스 계정 JSON 전체 |

Web 설정은 공개 설정이고 `FIREBASE_SERVICE_ACCOUNT_JSON`은 서버 전용 비밀값이다. JSON 키는 Vercel 환경변수에서만 관리하며 Git이나 PR 본문에 올리지 않는다. `/api/firebase-config`는 이 비밀값을 반환하지 않는다.

`FIREBASE_AUTH_EMULATOR_HOST`와 `FIRESTORE_EMULATOR_HOST`는 Vercel에 등록하지 않는다. Analytics measurementId는 게임에 필요하지 않다.

PostHog를 쓰려면 Production 범위에 `POSTHOG_PROJECT_KEY=phc_…`와 `POSTHOG_HOST=https://us.i.posthog.com` (EU 프로젝트는 `https://eu.i.posthog.com`)을 추가하고 재배포한다. Preview와 로컬은 기본 비활성이다. 자세한 절차와 수집 범위는 [분석 설정](ANALYTICS.md)을 참고한다.

## Firebase 설정과 배포 확인

Firestore가 `asia-northeast3`(서울)에 있어서 `vercel.json`의 `regions`로 서버 함수도 서울(`icn1`)에서 실행한다. 기본값(미국 동부)에서는 요청마다 서버와 Firestore가 태평양을 여러 번 오가 호박 따기·노크 응답이 늦었다. Firestore 위치를 바꾸면 이 값도 함께 바꾼다.

1. 대상 프로젝트가 `trick-or-treat-89de3`인지 확인하고 `firestore.rules`와 `firestore.indexes.json`을 Firestore에, `database.rules.json`의 rules 내용을 Realtime Database에 게시한다. 한쪽만 적용하면 실시간 게임이 정상 동작하지 않는다. 캐릭터 위치·뿅망치 경로가 `presence/{마을}`·`events/{마을}`로, 채팅이 `chat`, 접속자 목록이 `online`으로 바뀌므로, 규칙과 새 배포를 같은 때에 반영한다. 이전 화면을 띄워 둔 사람은 새로고침해야 접속된다.
2. 서비스 계정 JSON을 Vercel 환경변수에 등록한다. JSON의 `project_id`와 `FIREBASE_PROJECT_ID`가 일치해야 한다.
3. 로컬 에뮬레이터에서 가입 → 분장 선택 → 로그아웃 → 같은 계정 로그인 → 다른 브라우저 로그인 순으로 확인한다. 중복 닉네임과 잘못된 비밀번호도 거부되어야 한다.
4. `/`에서 게임이 열리고 기존 HTML 링크가 `/`로 연결되는지 확인한다. `/api/firebase-config`는 200이어야 하며 비밀 키가 없어야 한다.
5. 운영자도 일반 가입 화면으로 가입한다. Firebase Authentication의 해당 계정 UID를 `GAME_ADMIN_UIDS`에 등록하고 재배포한다. 등록한 계정에만 순위 창의 시작·종료 버튼이 나타난다. 닉네임을 넣으면 권한이 생기지 않는다.
6. 두 계정으로 로그인해 서로의 캐릭터 이동·채팅·노크 결과와 순위를 확인한다. 이벤트 시작 전 기록은 연습 라운드로 저장되며, 시작 버튼을 누르면 모두 사탕 10개로 새 라운드를 시작한다. 종료 후 노크·구매를 거부하고 최종 사탕 순위를 보존한다. 시간이 다 되어 자연 종료되면 운영자의 ‘결과 확정’ 버튼으로 보관한다. 새 라운드를 시작해도 이전 결과는 `gameRounds/{라운드 ID}`에 남는다.

운영은 Spark 기준으로 진행한다. Realtime Database 동시 연결 한도는 브라우저 탭을 포함해 100개이며, 사용자가 실제 동시 접속은 이 범위 안으로 예상한다고 확인했다. [Firebase 공식 제한](https://firebase.google.com/docs/database/usage/limits)을 참고한다. Firestore는 플레이어 문서 변경마다 접속 중인 클라이언트에 읽기가 발생하므로 사용량도 확인한다.

## 현재 구현 범위

닉네임·비밀번호 인증과 캐릭터 설정에 더해 접속·위치·채팅·뿅망치, 호박 진행, 노크 기록·사탕·랭킹·장식·방명록·지붕 그림이 연결되어 있다. 닉네임은 로그인 ID라 변경하지 않으며 비밀번호 초기화·복구 도구는 아직 없다.

점수는 서버 API만 변경한다. Firestore 트랜잭션에서 양쪽 사탕과 노크 기록을 함께 저장하며, 같은 요청을 재전송해도 한 번만 반영한다. 서버가 발급한 난이도·움직임 시드로 입력 기록을 재생해 성공 여부를 검증한다. 미니게임에는 별도 제한 시간이 없고 게이지가 0 또는 가득 찰 때 끝난다. 이 검증이 자동 입력이나 한 사람이 여러 계정을 만드는 행동까지 막는 것은 아니다. 상품 지급 때 참가자 확인은 운영 절차로 필요하다.

실시간 위치는 최대 초당 4회 전송하며 채팅·뿅망치 이벤트는 계정별 최신 1개만 유지한다. 연결마다 별도 세션을 두고 `onDisconnect`로 정리하므로 한 탭이 닫혀도 같은 계정의 다른 접속은 유지된다. 지속 기록은 Firestore, 일시적인 접속과 메시지는 RTDB를 쓴다.

## 관리자 도구

`GAME_ADMIN_UIDS`에 등록된 운영자는 순위 창에서 관리자 도구를 연다. 닉네임 또는 UID로 검색해 최근 30개 활동, 현재 채팅과 작성한 방명록을 확인하고 밴·해제, 순위 제외·포함, 집 숨김·복원, 글 삭제를 할 수 있다. 밴 해제 후에도 순위 제외는 유지하므로 검토 후 따로 포함한다. 새 활동 기록은 서버에서 정상 처리한 행동만 남기며 기존 도전·연금술·방명록 기록도 함께 표시한다.

배포 시 Firestore 규칙·복합 색인과 Realtime Database 규칙을 모두 갱신해야 한다. 관리자 서버는 기존 `FIREBASE_DATABASE_URL` 환경변수로 RTDB에 접근한다. Firebase 설정 배포는 Vercel 자동 배포에 포함되지 않는다. Firebase CLI에서는 `firebase deploy --only firestore:rules,firestore:indexes,database --project trick-or-treat-89de3`로 반영할 수 있다.

대전 구독이 규칙 또는 색인 오류로 중단되면 화면은 인증된 `GET /api/game/duels`를 2초마다 호출한다. 이 API는 본인 대전 잠금과 마지막으로 확인한 대전만 읽고, 참가자 여부를 서버에서 다시 검사한다. 전체 대전 목록을 읽거나 다른 사람의 대전을 반환하지 않는다. Firebase 설정 반영 후 화면을 새로고침하면 실시간 구독을 다시 사용한다.

순위 제외는 `game/moderation` 구독으로 화면에 반영된다. 순위에 다시 포함한 사용자의 점수가 서버/CDN 순위 저장본에 없으면 기존 3분 갱신 주기 뒤 나타난다. 계정 비활성화와 두 DB 변경은 순서대로 적용되므로 오류가 표시되면 사용자 상태를 조회하고 동일한 조치를 다시 적용한다. 운영자 조치는 비공개 `gameAdminActivity`에 기록한다.
