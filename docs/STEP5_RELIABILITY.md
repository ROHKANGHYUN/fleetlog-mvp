# Fleetlog · 5단계 예외 상황·동기화 검증

검증일: **2026-11-15 KST**. 웹 차량·음성·Outbox·HTTP/SQLite·관리자 간 실패 경계를 수정하고 재현 가능한 E2E 경로를 구성했습니다. 실제 Pleos SDK와 Android 실기기 연동은 여전히 **미실행/미검증**입니다.

## 기준선과 데이터 보호

- 작업 전 `npm run check`는 **117/117 실행 통과**, TypeScript·웹 빌드도 통과했습니다.
- Git 메타데이터가 없는 폴더로 기존 소스 manifest 94개를 기준으로 보존했습니다. 이번 Playwright 설치로 바뀐 package/lock을 별도 식별했고 그 외 시작 시 변경 파일은 없었습니다. 기존 코드를 되돌리거나 초기화하지 않았습니다.
- 기존 API PID 49059 / 웹 PID 49060, 포트 4000/5173을 확인했고 종료·재시작하지 않았습니다. 실제 열린 DB 경로는 `services/api/data/fleetlog.sqlite`입니다.
- `mode=ro`와 `query_only`로 현재 **운행 4건·영수증 6건**의 전체 행을 읽었습니다. 기존 보고 수에 맞춰 데이터를 변경하지 않았습니다. ID·버전·payload·ACK 기준은 ignore 대상 `test-results/step5/before/database.json`에 보관했습니다.
- Node/HTTP 테스트와 E2E는 새 임시 DB만 사용합니다. E2E는 테스트마다 독립 브라우저 컨텍스트와 OS가 선택한 새 로컬 포트, API 인스턴스를 만들고 finally에서 해당 인스턴스와 임시 디렉터리만 정리합니다. 운영/개발 API 접근 제한을 완화하지 않았습니다.

## 발견한 문제와 수정

| 발견 | 실제 수정 |
|---|---|
| 유효 JSON이라는 이유만으로 중첩된 record/Outbox/current 손상을 복원 | `persistence.mjs`에서 schema v1의 내부 타입·버전·참조·원본·준비 본문·최신 리비전 payload를 검증. 손상되면 쓰기 없이 시작 차단·원문 보존 |
| HTTP 400·403·413·415도 일반 queued로 남아 매번 재요청 | 확인이 필요한 4xx를 blocked로 보류하고 후행 변경도 선행 ACK 없이는 진행하지 않음. 409와 별도 안내 |
| 성공 응답의 잘못된 JSON과 HTTP 오류의 비JSON 본문을 구분하지 못함 | 성공 응답의 비JSON은 blocked. HTTP 503 등의 비JSON은 원래 HTTP 상태에 따라 수동 재시도 유지 |
| ACK 영속 반영 실패가 transport catch에 들어가 다시 실패 상태를 저장하려고 함 | ACK commit을 transport catch 밖으로 분리. 실패 시 미ACK·기존 준비 본문 유지, 메모리 `syncError`·예외로 안내 |
| 전체 sync 상태만 있어 개별 운행의 실제 전송 중 표시 근거가 없음 | 메모리 `inFlightEventId` 도입. 실제 해당 요청만 전송 중 표시, 미요청 운행은 대기 유지 |
| 실제 Chrome 음성 입력에서 `Illegal invocation` 발생 | `VoiceFlow`가 private 필드로 보관한 브라우저 타이머를 잘못된 this로 호출하던 문제를 wrapper로 수정 |
| 음성을 시작하지 않은 화면에도 취소 안내 표시 | 실제 진행 중인 음성의 사용자 취소일 때만 해당 안내 사유를 남김 |
| 병렬 SSR 테스트가 불필요한 Vite WebSocket 포트 충돌 경고 발생 | SSR fixture의 HMR와 WebSocket을 끄고 실제 웹 서버/소켓 없이 렌더 검사 |

주요 변경은 `packages/domain/index.mjs`, `index.d.mts`, 새 `persistence.mjs`, `voice-flow.mjs`, 웹 `delivery.mjs`·`App.tsx`입니다. Playwright 설정과 `e2e/` fixture, 도메인/HTTP/표시 회귀 테스트도 추가했습니다. 디자인 전면 개편과 관리자 데이터 모델 변경은 없습니다.

## 저장·전송·수신 상태

| 상태 | 의미와 표시 |
|---|---|
| 입력 초안 | controller의 purpose/note 임시 입력. 최종 운행·Outbox 생성 전, 요약 후 명시적 저장 필요 |
| 로컬 저장 완료 | record와 Outbox를 같은 직렬화 저장으로 함께 commit한 후에만 saved 화면 |
| 전송 대기 | 미ACK 리비전. preparedEvent가 없으면 선행 ACK를 기다리거나 최초 준비 전 |
| 전송 중 | `inFlightEventId`가 가리키는 실제 요청의 전송·수신 확인 중. 완료를 뜻하지 않음 |
| 서버 수신 확인 | ACK의 eventId·ackedLocalRevision·serverVersion 검증과 로컬 receipt commit까지 성공 |
| 재시도 가능 실패 | 연결/시간 초과/408/429/5xx. queued와 같은 preparedEvent를 유지하고 사용자 수동 재시도 |
| ACK 확인 오류 | 이벤트·리비전·버전 불일치. 미ACK 유지, 원인 확인 안내 후 동일 이벤트로 명시적 수동 재시도 허용 |
| 원인 확인 오류 | blocked. 요청 형식·권한·성공 응답 JSON 문제. 자동/일반 재시도와 해당 운행 보완을 보류 |
| 버전 충돌 | conflict. 원본·본문·ID 보존, 해당 변경과 후행 변경 전송 보류 |
| 전송 상태 로컬 저장 실패 | `syncError`는 저장소에 쓰지 못한 사실을 메모리와 화면에 표시. 영속 ACK를 만들지 않음 |

원래 record/Outbox/receipts 구조와 `fleetlog.mock.v1`, Web Lock 이름을 유지합니다. schemaVersion 1의 Outbox에 `blocked` 상태와 선택적 `failureKind`만 추가했으며 기존 v1 데이터를 변환하지 않고 읽습니다. `inFlightEventId`·`syncError`는 정상 영속 저장에 포함하지 않습니다. 서버 wire 계약과 SQLite 스키마는 변경하지 않았습니다. Android의 별도 저장 엔진·전송 상태에 이 웹 전용 진단 구분을 구현한 것은 아닙니다.

## 재시도·순서·ACK 규칙

1. 저장된 이벤트에 expectedServerVersion을 넣은 **준비 본문을 먼저 영속 저장**합니다. 그 저장이 실패하면 네트워크를 호출하지 않습니다.
2. 같은 이벤트 재전송은 eventId와 준비된 본문을 그대로 사용합니다. 실패를 새 ID로 우회하거나 서버 버전을 추정하지 않습니다.
3. 동일 운행의 후행 리비전은 선행 영수증의 실제 serverVersion을 받은 뒤에만 준비합니다. 전송 중 목적 보완이나 다른 운행 저장을 해도 현재 전송 snapshot과 새 Outbox를 분리해 보존합니다.
4. ACK의 ID·리비전·정수 서버 버전(expected+1)을 검사합니다. ACK 영수증·Outbox 제거·해당 기록의 완료 리비전 갱신은 같은 로컬 commit입니다. 옛 ACK는 최신 리비전까지 완료 처리하지 않습니다.
5. ACK 수신 후 로컬 저장에 실패하면 sync가 reject하고 기존 미ACK 상태가 남습니다. 서버에 이미 저장됐더라도 재실행/재시도는 같은 준비 본문으로 기존 영수증 ACK를 돌려받습니다.
6. sync의 단일 실행 가드와 실행별 attempted 집합으로 같은 이벤트를 동시에/같은 실행 안에서 반복 전송하지 않습니다. **자동 재시도·타이머 백오프는 추가하지 않았습니다.**
7. 충돌/blocked 운행의 후행 변경은 멈추지만 관계없는 queued 운행은 계속 전송합니다. blocked/conflict의 자동 해제·수정·병합 UI는 없습니다. 원인 조사 후 별도 복구 정책이 필요하며 로컬 DB를 임의 편집해 우회하지 않습니다.
8. 서버의 운행 변경과 이벤트 영수증은 기존 SQLite 트랜잭션으로 묶입니다. receipt 쓰기 실패 시 신규 생성과 기존 운행 갱신 모두 롤백되는 것을 실제 임시 DB에서 검증했습니다.

## 실패 시나리오별 결과

| 시나리오 | 방법 | 결과 |
|---|---|---|
| 로컬 저장 직전 실패 | storage port·실제 브라우저 Storage.setItem의 QuotaExceeded 주입 | **실행 통과**. review·초안·기존 바이트 유지, 성공 화면 없음, 복구 후 1건 저장 |
| 요청 준비 저장 실패 | preparedEvent 포함 commit에서 예외 | **실행 통과**. 요청 0회·기존 미준비 이벤트 유지 |
| 로컬 저장 후 전송 전 중단 | 오프라인 저장→실제 새로고침 | **실행 통과**. record/Outbox 보존·수집 중지·실제 전송 전 관리자 0건 |
| 서버 저장 후 ACK 유실 | 실제 HTTP가 commit한 후 client transport에 유실 주입 | **실행 통과**. 재실행·동일 본문 재전송·원래 ACK·운행/영수증 단일 유지 |
| ACK 후 로컬 반영 실패 | 한 번/지속 저장 실패 주입 후 재실행·재시도 | **실행 통과**. receipt/완료 리비전 미반영·준비 본문 보존·복구 후 중복 없음 |
| 잘못된/중복/옛 ACK | ID·리비전·버전 변조, 동시 동일 HTTP 요청 | **실행 통과**. 잘못된 응답 미수용·중복 영수증 없음·최신 변경 미완료 유지 |
| 전송 중 보완·새 운행 | ACK를 제어 가능한 Promise로 지연 | **실행 통과**. 원래 요청 불변·새 변경 보존·선행 ACK 후 후행 준비 |
| 세션 종료 후 늦은 ACK | 전송 시작→stop→응답 해제 | **실행 통과**. 전송 완료만 갱신, 수집 재개 없음 |
| 409와 다른 운행 | 한 운행 충돌·종속 리비전·관계없는 운행 구성 | **실행 통과**. 후행 보류·다른 운행 수신 |
| 400/401/403/413/415 | HTTP 상태 주입 | **실행 통과**. blocked·원문 보존·반복 sync에서도 요청 증가 없음 |
| 연결/시간 초과/408/429/500/503 | 제어 가능한 오류 주입 | **실행 통과**. 수동 실행당 한 번·동일 준비 본문 재시도 |
| 서버 트랜잭션 중 실패 | 임시 SQLite receipt INSERT trigger RAISE(ABORT) | **실행 통과**. 운행·영수증 함께 롤백 |
| 유효 JSON 내부 손상 | payload/참조/품질/버전/중복 리비전 변조 | **실행 통과**. 복원 전에 거부·쓰기 0회·원문 보존 |
| 다중 writer | stale controller 비교 + 실제 Chrome 두 탭 | **실행 통과**. 오래된 인스턴스 덮어쓰기 거부·두 번째 탭 Web Lock 차단 |
| 원본 변조·gap 보완 | 실제 HTTP 원본 5필드 변경/정상 purpose 보완 | **실행 통과**. 변조 409·원본 유지·용도 보완 후에도 gap 제외 |

## 검증 실행 결과

| 검증 종류 | 판정 | 내용 |
|---|---|---|
| 자동 전체 테스트 | **실행 통과** | `npm run check`: 148/148, 실패·skip 0. 기존 117개 유지, 회귀 31개 추가 |
| 타입 검사·웹 빌드 | **실행 통과** | TypeScript + Vite 7.3.8, 번들 생성 |
| 실제 HTTP/SQLite 회귀 | **실행 통과** | `node --test tests/reliability-http.test.mjs`: 8/8. 전체 148개에도 포함 |
| 실제 Chrome E2E | **실행 통과** | `npm run test:e2e`: 13/13, 실패·skip·flaky 0 |
| 신규 의존성 audit | **실행 통과** | `npm audit`: 취약점 0. Playwright 1.65.1 exact devDependency |
| 기존 CUA 연결 | **실행 실패** | 인벤토리 `The browser access host is unavailable`. 같은 native 연결을 다시 반복하지 않고 대체 경로 사용 |
| 최초 실제 음성 E2E | **실행 실패 → 수정 후 통과** | 브라우저 타이머 `Illegal invocation` 재현·수정, 최종 정상 음성 통과 |
| Android/실차/실제 SDK | **미실행** | 이번 웹 안정화 범위 밖, 아래 6단계 조건 필요 |

실패 시나리오 테스트는 실패 후 record·Outbox·receipts의 결과를 검사합니다. 실제 음성 서비스·유료 API·긴 대기에 의존하지 않습니다. HTTP 8개와 E2E를 단순히 더해 전체 테스트 수로 표기하지 않습니다.

### 브라우저 경로와 실제 확인 범위

사용자 요청에 따라 **Playwright 1.65.1 + 설치된 Chrome 157.0.8103.52 headless**를 사용했습니다. CUA 호스트 문제와 실제 앱 오류를 구분했고, 보안 설정을 바꾸거나 기존 사용자 Chrome 프로필에 접속하지 않았습니다. 새 Chrome 프로세스와 테스트별 컨텍스트만 사용했습니다.

13개 E2E는 정상 음성→수정→명시 저장→전송→관리자 상세, 미확정→보완→같은 ID 버전 2, 오프라인 새로고침 복구, 취소/재출발, 최종 처리 대기 중 취소, 인식 실패/빈 결과/사용 불가 후 수동·미확정, 실제 QuotaExceeded 복구, HTTP503 동일 요청 재시도, 관리자 조회 실패와 기간·용도 집계, 크기 3개, 실제 두 탭 Web Lock을 확인합니다.

1280×720·960×540·640×720 각각에서 시작·용도 입력·저장 완료·관리자 목록/상세를 측정했습니다. 페이지 가로 넘침 0, 영역 경계 넘침 0, 높이 56px 미만 조작 영역 0입니다. 크기별 전체 페이지 스크린샷 12장을 저장했고 넓은 관리자 상세·좁은 용도 입력·960px 관리자 상세 등의 가독성과 문구를 시각 확인했습니다. 540px 높이에 모든 내용을 넣는 방식은 아니며 세로 스크롤로 조작합니다. 이는 웹 프로토타입 목표이며 공식 차량 UX 인증 결과가 아닙니다.

취소를 무시하는 hostile adapter의 늦은 콜백 자체는 제어 가능한 도메인 테스트에서 검증했습니다. 실제 브라우저에서는 취소/재출발 뒤 결과 조작 차단과 이미 도착해 처리 대기 중인 final의 취소를 검증했으며, 실제 외부 SDK의 늦은 콜백을 받은 것으로 표현하지 않습니다.

일반 Chrome의 손 조작, 다른 브라우저 엔진·모바일 OS, 실제 장치 저장소 고장·차량 전원 종료·진짜 네트워크 timeout 대기, 실차 UX 인증은 **미실행**입니다. 이번 실패 주입과 headless 브라우저 범위를 넘는 보장을 하지 않습니다.

## 재현 명령과 결과 위치

```sh
npm ci
npm run check
npm run test:e2e
```

macOS 설치 Chrome 경로를 자동 선택합니다. 다른 실행 파일은 `CHAGOK_BROWSER_PATH=/절대/경로 npm run test:e2e`로 지정하고, 브라우저가 없다면 `npx playwright install chromium`을 먼저 실행합니다. 이번에는 설치 Chrome을 사용해 추가 브라우저 다운로드를 피했습니다. Node 24와 다운로드/실행 여유 공간이 필요합니다.

- `playwright.config.mjs`: worker 1, retry 0, 실제 headless 브라우저. 기존 서버 재사용 없음.
- `e2e/fixtures.mjs`: 테스트마다 임시 SQLite·빈 동적 포트·실제 API/정적 웹. fixture가 자기 서버와 임시 디렉터리만 정리.
- `test-results/step5/check.log`, `http.log`, `e2e-run.log`, `e2e-results.json`: 판정 근거. 크기별 스크린샷은 `test-results/step5/e2e/` 아래에 있습니다.
- `test-results/step5/before/`, `preservation.json`: 기존 데이터·소스 비교 근거. 모두 ignore 대상이며 DB·로그·스크린샷·node_modules·dist를 소스 manifest에 포함하지 않음.

기존 본 앱은 `npm run dev`의 127.0.0.1:5173이며 이미 실행 중인 서버를 추가로 종료/재시작할 필요가 없습니다. E2E는 `npm run check`에 묶지 않았으므로 브라우저 검증을 하려면 별도 명령을 실행합니다.

## 기존 데이터 보존 결과

작업 종료 후 같은 개발 DB를 읽기 전용으로 다시 비교해 **운행 4→4건·영수증 6→6건의 전체 행이 동일**함을 확인했습니다. ID·서버 버전·로컬 리비전·payload·반영 시각·준비 이벤트·ACK가 보존됐습니다. 기존 브라우저 저장소는 초기화하지 않았으며 실제 테스트는 독립 컨텍스트만 사용했습니다.

기존 94개 소스 중 이번 변경 14개를 제외한 **80개는 시작 시점 해시와 동일**합니다. API/SQLite·계약·Android·관리자 모델/스타일·차량 기본 스타일은 보존했습니다. 기존 PID 49059/49060의 listen과 본 웹·health HTTP 200을 확인했고, E2E가 만든 Playwright Chrome 프로필 프로세스가 남지 않은 것도 확인했습니다. 소스 manifest는 코드·테스트·설정·문서만 갱신합니다.

## 6단계 Android·에뮬레이터·실제 SDK 조건

1. `apps/car-android/VALIDATION.md`의 기존 실패 기록을 출발점으로 현재 디스크·JDK17·Gradle·SDK35/build-tools/platform-tools 설치 상태를 다시 확인합니다. 과거의 SDK/디스크 부족 진단을 현재 통과 결과로 간주하지 않습니다.
2. 환경 준비 후 `testDebugUnitTest assembleDebug`를 실제 실행하고 JUnit 결과·APK 존재를 확인합니다. AVD에서 명시 시작→주행→주차→미확정/확정 저장→전송→관리자 최신 수신본을 검증합니다. Android 목적 보완·영속 Outbox·오류 분류가 웹과 동일하게 구현됐다고 가정하지 않습니다.
3. 실제 Pleos SDK의 제공 계정/접근 권한·공식 artifact와 버전·타입·누적거리 원본 단위·권한·수명주기를 확인한 뒤 adapter를 연결합니다. 이 작업은 API/단위/권한을 추정하지 않았습니다.
4. 전원/프로세스 종료, 리스너 중단·재등록, 운전 상태 불명확, 백그라운드·음성 취소·권한 거부·철회·재연결을 전용 환경에서 검증합니다. mock 실패를 live 성공으로 대체하지 않습니다.
5. 충돌/blocked 조사와 안전한 복구 도구, 저장소 백업·복구 절차, 인증·회사 권한은 후속 설계입니다. 승인·기간 마감·세무신고 기능은 여전히 미구현이며 ACK와 별개입니다.
