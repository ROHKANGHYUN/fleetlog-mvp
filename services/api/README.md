# Fleetlog local mock API

Node.js 24 이상에서 동작하는 개발용 HTTP 서버입니다. 외부 패키지를 사용하지 않으며 `node:sqlite`에 운행 스냅샷과 이벤트 ACK를 함께 저장합니다.

```sh
node services/api/src/server.mjs
node --test services/api/test/*.test.mjs
```

기본 주소는 `http://127.0.0.1:4000`입니다. `PORT`와 `FLEETLOG_DB_PATH`를 설정할 수 있습니다. `HOST`는 `127.0.0.1`만 허용하고 `NODE_ENV=production`은 시작을 거부합니다. 기본 DB는 `services/api/data/fleetlog.sqlite`입니다. 데모 데이터만 입력하세요.

| 경로 | 메서드 | 응답 |
|---|---|---|
| `/api/health` | GET | mock 개발 서버 상태 |
| `/api/trips` | GET | `{ trips: StoredTrip[] }` |
| `/api/exceptions` | GET | 목적 미확정 또는 `quality: gap` 기록 |
| `/api/trip-events` | POST | `{ eventId, ackedLocalRevision, serverVersion }` |
| `/api/review-summary` | GET | 수신·미확정·거리 문제 건수와 검토 안내 |

health 이외 API에는 `X-FleetLog-Dev: local-only`가 필요합니다. 이 값은 **사용자 인증 수단이 아닙니다**. POST는 `Content-Type: application/json`을 사용하며 UTF-8 본문은 16 KiB 이하여야 합니다. CORS 교차 출처 허용 대상은 `http://localhost:5173`, `http://127.0.0.1:5173`뿐입니다. 서버가 직접 제공하는 웹 번들의 동일 출처 요청은 별도로 허용됩니다.

이벤트 계약은 `packages/contracts/index.mjs`를 사용합니다. 미확정 목적도 수신·저장합니다. 같은 `eventId`와 같은 정규화 본문을 재전송하면 처음의 ACK를 그대로 반환합니다. 같은 ID의 다른 본문, 오래된 `expectedServerVersion`, 증가하지 않은 새 `localRevision`은 409입니다. 실패한 쓰기는 트랜잭션 전체를 되돌립니다. 이미 ACK한 옛 이벤트를 재전송해도 최신 운행 스냅샷을 과거 값으로 돌리지 않습니다.

기존 `tripId`의 새 리비전은 `purpose`와 `note`만 보완할 수 있습니다. 차량·이용자 ID, 시작·종료 시각, 전후 누적거리, 수집 품질은 원본 필드로 보존합니다. 계약에 유효한 원본 변경 요청은 `409 RAW_FIELDS_IMMUTABLE`로 거절하며, 등록되지 않은 ID처럼 계약 자체를 위반한 요청은 400입니다. `quality: gap`을 `valid`로 바꾸어 거리 문제를 없앨 수 없습니다. 원본 오류 정정이나 다른 실제 이용자 지정의 승인 절차는 이 starter에 구현되어 있지 않습니다.

`invalidDistanceCount`는 저장된 `quality: gap` 기록 수입니다. 음수·역행 거리처럼 계약에 어긋난 요청은 400으로 거절되어 저장되지 않습니다. `readyForPurposeReview`는 수신 기록이 있고 미확정 목적과 거리 문제가 모두 0일 때만 true입니다. 이는 관리자 승인, 기간 전체 거리 대조, 마감 가능 여부나 세무 검증 완료를 뜻하지 않습니다.

`apps/web/dist`가 있으면 정적 번들을 제공합니다. 없는 자산은 404이며 확장자가 없는 화면 경로는 SPA 진입점으로 연결합니다. 상위 경로 접근과 번들 바깥으로 이어지는 심볼릭 링크는 거부합니다.

이 서버에는 프로덕션 인증·다법인 권한·개인정보 운영 정책·실차 데이터 연동·기간 마감·세무신고 기능이 없습니다. 인터넷에 공개하거나 실제 법인차 데이터에 사용하면 안 됩니다. 개발 헤더와 CORS는 프로덕션 보안 설계를 대신하지 않습니다.
