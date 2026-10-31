# PostHog 사용자 행동 분석

목적은 방문자가 얼마나 머무르고, 어떤 놀이를 하고, 어디에서 그만두는지 알아보는 것이다. 자동 클릭 수집에 더해 캔버스 안 게임 행동은 명시적 이벤트로 기록한다. 분석은 클라이언트에서 수집하므로 광고 차단·네트워크 종료·변조로 누락될 수 있다. 상품 지급이나 정확한 사탕 정산은 기존 서버 기록을 쓴다.

2026-10-31에 **똑똑 할로윈** 조직과 **똑똑 할로윈 (trick-or-treat)** 프로젝트를 생성했다. [프로젝트](https://us.posthog.com/project/700423/home)의 리전은 US, 보고 시간대는 Asia/Seoul이다. 세션 녹화를 활성화하고 IP 저장·콘솔·네트워크 성능 수집은 껐다. 공개 수집 키와 호스트는 Git에서 제외된 `.env.local`에 저장했다. 기존 자리하나 조직은 프로젝트 1개 한도라 게임 전용 조직으로 분리했다.

[플레이 분석 대시보드](https://us.posthog.com/project/700423/dashboard/2284435)에 일별 플레이어 수, 화면 체류·활성 플레이 시간, 놀이별 이용자 수, 가입부터 첫 노크까지의 24시간 퍼널을 저장했다. 최근 7일의 Production 데이터만 표시하며 관리자 플레이는 제외한다. 로컬에서 실제 SDK로 보낸 `auth_viewed` 이벤트가 도착하여 설치 완료로 표시되는 것을 확인했다. 로컬 테스트는 `environment=development`라 운영 차트에는 표시되지 않는다. 운영 수집은 Vercel 환경변수 등록과 이번 코드 배포 뒤 시작된다.

## 처음 연결하기

1. [PostHog 가입](https://us.posthog.com/signup) 후 프로젝트를 만든다. US로 만들면 아래 기본 호스트를 그대로 쓴다. EU 프로젝트라면 호스트도 EU로 바꾼다.
2. Project settings에서 **Project API key** (`phc_…`)를 복사한다. 개인 API 키 (`phx_…`)는 필요 없다.
3. 배포 담당자가 Vercel → 해당 프로젝트 → Settings → Environment Variables의 **Production** 범위에 다음 두 값을 등록한다.

| 이름 | 값 |
| --- | --- |
| `POSTHOG_PROJECT_KEY` | 위 공개 수집 키 |
| `POSTHOG_HOST` | US: `https://us.i.posthog.com`, EU: `https://eu.i.posthog.com` |

4. 이 코드가 들어간 버전을 배포한다. 설정은 **빌드할 때** 읽으므로 환경변수 변경 후 재배포해야 한다. 키가 없으면 분석 코드도 페이지에 포함하지 않는다.
5. PostHog → Activity의 실시간 이벤트에서 운영 주소에 접속한 뒤 `$pageview`, `auth_viewed`, `game_entered`가 오는지 확인한다. 이벤트 속성의 `environment`가 `production`인지도 확인한다.
6. Session Replay를 쓸 경우 PostHog의 프로젝트 설정에서 **Record user sessions**를 켠다. SDK 설정만으로 서버의 녹화 설정이 켜지지는 않는다.

로컬·Preview는 기본 수집하지 않는다. 검증할 때만 **별도 테스트 프로젝트** 키와 `POSTHOG_ENABLED=true`를 지정한다. 로컬은 `.env.local`에 넣고 `npm run dev`를 다시 실행한다. Preview는 Preview 범위에 넣고 재배포한다. `POSTHOG_ENABLED=false`로 설정하고 재배포하면 수집을 중단한다. 파일로 직접 여는 원본 HTML과 기존 Claude 아티팩트에는 빌드로 주입한 분석 번들이 없어서 수집하지 않는다.

## 무엇을 수집하나

게임 이벤트에는 `game_mode`, `round_id`, `round_state`, `village`, `is_admin`이 가능한 경우 붙는다. SDK 공통 속성에는 `app=trick-or-treat`, `analytics_schema=1`, `environment`가 있다. PostHog의 기본 세션 ID, 브라우저·기기·유입 정보도 사용한다. URL 속성의 쿼리 문자열과 해시는 전송 전에 제거한다.

| 흐름 | 이벤트 | 추가 속성 |
| --- | --- | --- |
| 방문·이탈·일반 클릭 | `$pageview`, `$pageleave`, `$autocapture` | SDK 기본 속성; 자동 클릭은 버튼·폼에 한정 |
| 인증 화면·요청·완료·실패 | `auth_viewed`, `auth_started`, `auth_completed`, `auth_failed` | `auth_mode`: `signup` / `login` / 완료 시 `restore`, 실패는 고정 `failure_reason`과 HTTP `status` |
| 게임 진입·로그아웃 | `game_entered`, `logout_completed` | 진입 시 `returning_player` = 튜토리얼 완료 이력 |
| 이야기·튜토리얼 | `intro_started`, `intro_skipped`, `tutorial_started`, `tutorial_completed` | 없음 |
| 분장·지붕 색 | `costume_selected`, `roof_changed` | `costume`, `first_selection` / `roof`; 선택 사실이며 저장 성공 보장은 아님 |
| 첫 이동 | `movement_started` | 로그인 후 첫 실제 이동 1회 |
| 호박·바구니 | `pumpkin_collected`, `basket_completed` | 호박은 `pumpkins`; Firebase에서는 서버 성공 확인 후 |
| 노크·미니게임 | `knock_started`, `candy_game_started`, `knock_completed`, `knock_choice` | 미니게임 `level`·`game`(fish·rhythm·whack·spell·catch), 완료 시 `outcome`, `candy_moved`, `duration_seconds`; 이후 `choice`: `again` / `note` / `bye` |
| 연금술·구매 | `brew_completed`, `decor_purchased` | `candy_gain` / `item`, `price` |
| 지붕 그림 저장 | `mural_saved` | `painted_cells` 개수만 |
| 채팅·방명록 | `chat_opened`, `chat_sent`, `note_sent` | 전송 성공 시 `message_length`만 |
| 뿅망치 | `bonk_sent` | 전송 성공 시 `target_is_bot`; 상대가 실제 맞았다는 보장은 아님 |
| 이동·집 방문 | `village_changed`, `house_visited` | 마을 이동 시 `destination_village` |
| 창·패널 | `modal_opened`, `modal_closed`, `panel_toggled` | `modal`, 닫을 때 `duration_seconds` / `panel`, `collapsed` |
| 운영 이벤트 관리 | `round_started`, `round_scheduled`, `round_cancelled`, `round_stopped` | 예약은 시작까지 남은 초와 진행 시간(초) |
| 게임 오류 | `action_failed` | 오류는 `action`, HTTP `status` (`0`은 상태 불명); 게임 API 재시도 최종 실패만 |
| 체류 시간 | `engagement_sample` | 아래 설명 참고 |

각 프레임의 좌표, 이동 경로, 키 입력 내역은 분석 이벤트로 보내지 않는다. 주요 행동 완료 이벤트는 성공 확인 뒤 한 번 기록하고, 노크 실패도 `outcome=lose`로 남긴다. `knock_started`는 문을 두드리는 연출 시작, `candy_game_started`는 도전이 준비되어 실제 미니게임에 들어간 시점이다.

## 체류 시간 해석

`engagement_sample`은 30초마다 보내는 **구간별 증가량**이다. 숨김 전환·페이지 종료·분석 식별자 변경 때 남은 구간을 보낸다. 누적값이 아니므로 `SUM`을 쓴다.

- `visible_seconds`: 탭이 보이는 시간. 다른 탭으로 이동하거나 브라우저를 최소화한 동안은 제외한다.
- `active_seconds`: 탭이 보이면서 마지막 클릭·터치·키보드·스크롤·포인터 이동·실제 게임 이동 후 60초 이내인 시간. 계속 조작하면 계속 합산한다. 화면을 보기만 하는 시간은 60초 뒤 유휴로 본다. 로그인 화면 조작도 포함하므로 플레이 시간은 `game_mode=firebase`로 필터한다.
- `engagement_id`: 탭의 페이지 로드·계정 변경별 구분값. `sample_sequence`와 함께 각 구간을 확인할 수 있다. PostHog의 `$session_id`와는 다르다.

탭으로 돌아온 뒤에는 새 입력 전까지 활성 시간을 더하지 않는다. 브라우저 뒤로 가기 캐시 복원 시 숨겨져 있던 시간도 더하지 않는다. 모바일 강제 종료·오프라인 등으로 마지막 구간이 사라질 수 있다. 60초 유휴 기준은 실제 집중도를 추정하는 기준이지 사람의 주의를 정확히 측정하지는 않는다. 여러 탭을 동시에 보이면 탭별 시간의 합에는 중복이 생길 수 있다.

창의 `duration_seconds`는 창을 열고 닫은 시각 차이로 숨김 시간도 포함한다. 활성 시간과 별개로 본다. 창을 닫지 않고 페이지를 종료하면 `modal_closed`는 없다.

## 처음 만들 대시보드

우선 공통 필터를 `environment=production`, `is_admin=false`로 둔다. 플레이 지표는 `game_mode=firebase`를 추가한다. 자동 방문 이벤트에는 `is_admin`이 없을 수 있으므로 전체 방문 통계는 `environment=production` 필터만 쓴다.

| 질문 | PostHog 구성 |
| --- | --- |
| 얼마나 들어오는가? | Trends: `game_entered`의 Unique users를 날짜별로 보기 |
| 실제로 얼마나 플레이하는가? | Trends: `engagement_sample`의 `active_seconds`와 `visible_seconds`를 각각 Sum. 일별 총 시간을 비교 |
| 한 번 들어오면 몇 분 하는가? | 아래 SQL로 세션별 증가량을 합산하고 평균·중앙값 보기 |
| 어떤 놀이를 주로 하는가? | Trends: `pumpkin_collected`, `knock_completed`, `brew_completed`, `chat_sent`, `note_sent`, `decor_purchased`, `mural_saved`, `bonk_sent`의 Unique users 비교. Total count도 따로 보면 반복 사용량을 알 수 있음 |
| 처음 온 사람이 어디서 그만두는가? | Funnels: `auth_completed` (`auth_mode=signup`) → `costume_selected` (`first_selection=true`) → `tutorial_completed` → `basket_completed` → `knock_completed`. 처음부터 Firebase 모드로 필터하면 인증 이벤트가 빠지므로 `environment=production`만 공통 적용 |
| 노크가 너무 어려운가? | `knock_completed`를 `level`·`outcome`으로 분해. `candy_game_started` → `knock_completed` 퍼널로 중도 이탈도 확인 |
| 다시 오는가? | Retention: 첫 행동·재방문 행동 모두 `game_entered`로 일별 확인 |
| 어디서 불편해하는가? | `action_failed`, `auth_failed` 추이와 마스킹된 Session Replay 확인 |

세션별 활성 시간 SQL 예시 (PostHog SQL insight):

```sql
SELECT
    avg(active_seconds) / 60 AS average_active_minutes,
    quantile(0.5)(active_seconds) / 60 AS median_active_minutes,
    avg(visible_seconds) / 60 AS average_visible_minutes
FROM (
    SELECT
        distinct_id,
        properties.$session_id AS session_id,
        sum(toFloat(properties.active_seconds)) AS active_seconds,
        sum(toFloat(properties.visible_seconds)) AS visible_seconds
    FROM events
    WHERE event = 'engagement_sample'
      AND timestamp >= now() - INTERVAL 7 DAY
      AND properties.environment = 'production'
      AND properties.game_mode = 'firebase'
      AND properties.is_admin = false
    GROUP BY distinct_id, session_id
)
```

날짜 범위에 걸친 세션은 범위 안에서 받은 구간만 합산한다. 이 SQL은 예시이며 저장한 네 개의 차트에는 포함하지 않았다. 실제 운영 데이터가 들어온 뒤 세션별 평균·중앙값이 필요하면 SQL insight로 추가한다.

## 식별·녹화 범위

계정 확인 후 Firebase UID만 `identify`에 전달해 기기 간 행동을 연결한다. 닉네임·비밀번호·Firebase 토큰·채팅/방명록 원문·그림 내용·상대 UID는 사용자 지정 이벤트에 보내지 않는다. 로그아웃 때 PostHog 식별자와 기기 ID를 초기화해 다음 계정과 구분한다.

녹화에서는 모든 입력·텍스트·속성을 마스킹하고 인증·관리자 창을 차단한다. 콘솔 로그와 네트워크 헤더·본문 수집도 끈다. **게임 캔버스에는 이름과 채팅이 그려지므로 캔버스 녹화는 끈다.** 따라서 Replay로 픽셀 게임 장면 전체를 재생할 수는 없고, UI 흐름과 명시적 행동 이벤트를 함께 본다. PostHog에서 캔버스 녹화를 켜도 클라이언트의 비활성 설정이 우선한다.

설정 근거: [JavaScript SDK](https://posthog.com/docs/libraries/js), [SDK configuration](https://posthog.com/docs/libraries/js/config), [Replay privacy controls](https://posthog.com/docs/session-replay/privacy).

## 검증

`npm test`는 시간 합산, 유휴·숨김·페이지 복원, 계정 변경, 이벤트 허용 속성, URL 정리, SDK 오류 격리, Production/Preview 빌드 설정과 게임 회귀를 확인한다. `npm run build`로 운영 번들을 만든다. 키 등록 후에는 실제 배포에서 실시간 이벤트, 로그인 전후 동일 사용자 연결, 로그아웃 후 다른 식별자, 채팅 원문 미수집을 확인해야 한다.
