# 배포 및 운영 인계

2026-10-30 동료가 공유한 운영 정보와 현재 코드 기준이다.

## 운영 정보

- 저장소: https://github.com/yejinkimis/trick-or-treat
- Vercel: `trick-or-treat-gpln`, `glowyejin-8900’s projects` 개인 Hobby 계정. 대시보드·환경변수·설정 변경은 배포 담당 동료에게 요청한다.
- 현재 배포: https://trick-or-treat-gpln.vercel.app/prototype/trick-or-treat.html
- 이 변경 배포 후 기본 주소: https://trick-or-treat-gpln.vercel.app/
- 기존 `/prototype/trick-or-treat.html` 링크는 `/`로 임시 리다이렉트한다.
- 동료가 설정한 흐름: PR에 Preview 주소 생성 → 확인 → `main` 머지 시 Production 자동 배포.
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

빌드·출력 경로는 `vercel.json`에도 지정되어 있다. 빌드는 원본 HTML을 `dist/index.html`로 복사하고, API는 저장소 루트의 `api/`에서 실행된다.

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
| FIREBASE_SERVICE_ACCOUNT_JSON | 프로젝트 설정 → 서비스 계정 → Firebase Admin SDK의 서비스 계정 JSON 전체 |

Web 설정은 공개 설정이고 `FIREBASE_SERVICE_ACCOUNT_JSON`은 서버 전용 비밀값이다. JSON 키는 Vercel 환경변수에서만 관리하며 Git이나 PR 본문에 올리지 않는다. `/api/firebase-config`는 이 비밀값을 반환하지 않는다.

`FIREBASE_AUTH_EMULATOR_HOST`와 `FIRESTORE_EMULATOR_HOST`는 Vercel에 등록하지 않는다. RTDB URL과 Analytics measurementId는 현재 계정 기능에서 사용하지 않아 환경변수로 필요하지 않다.

## Firebase 설정과 배포 확인

1. 대상 프로젝트가 `trick-or-treat-89de3`인지 확인하고 저장소의 `firestore.rules`를 Firestore Rules 화면에서 게시한다.
2. 서비스 계정 JSON을 Vercel 환경변수에 등록한다. JSON의 `project_id`와 `FIREBASE_PROJECT_ID`가 일치해야 한다.
3. PR Preview에서 가입 → 분장 선택 → 로그아웃 → 같은 계정 로그인 → 다른 브라우저 로그인 순으로 확인한다. 중복 닉네임과 잘못된 비밀번호도 거부되어야 한다.
4. `/`에서 게임이 열리고 기존 HTML 링크가 `/`로 연결되는지 확인한다. `/api/firebase-config`는 200이어야 하며 비밀 키가 없어야 한다.

## 현재 구현 범위

닉네임·비밀번호 인증, 중복 닉네임 방지, 기기 간 동일 UID, 분장·지붕 색·인트로 및 튜토리얼 완료 저장까지 구현했다. 닉네임은 로그인 ID라 변경하지 않는다. 비밀번호 초기화·복구 도구는 아직 없다.

Firebase 계정으로 들어간 게임은 연습 마을이다. 사탕·노크·방명록·채팅·접속 위치·실제 선물 순위의 Firebase 연결은 다음 작업이다. RTDB는 생성되어 있지만 코드에서 아직 사용하지 않는다.
