# 로컬 API 계약 v1

기준 주소 `http://127.0.0.1:4000`. health 외 데이터 API는 `X-FleetLog-Dev: local-only` 필요. 쓰기는 `Content-Type: application/json`, 본문 최대 16KiB. 이 헤더는 실제 인증이 아니다.

| 메서드 / 경로 | 결과 |
|---|---|
| GET /api/health | 모의 서버 상태 |
| POST /api/trip-events | 검증·저장 후 ACK |
| GET /api/trips | `{trips:[...]}` 최신 운행 수신본 |
| GET /api/exceptions | 목적 미확정 또는 quality=gap 목록 |
| GET /api/review-summary | 수신 수·미확정 수·품질 문제 수·목적 확인 가능 여부 |

`readyForPurposeReview`는 관리자 승인/마감/세무신고 완료가 아니다.

## 이벤트 예시

```json
{
  "schemaVersion": 1,
  "eventType": "TRIP_UPSERT",
  "eventId": "cf59f7f2-e173-4334-b451-9eeb7d077347",
  "tripId": "8ecb9e08-a843-4900-a508-f102540e7990",
  "localRevision": 1,
  "expectedServerVersion": 0,
  "source": "mock",
  "payload": {
    "vehicleId": "demo-car-001",
    "driverId": "demo-driver-001",
    "startedAt": "2026-11-15T01:00:00.000Z",
    "endedAt": "2026-11-15T01:30:00.000Z",
    "startOdometerM": 12480000,
    "endOdometerM": 12503400,
    "purpose": null,
    "note": "",
    "quality": "valid"
  }
}
```

시각은 `YYYY-MM-DDTHH:mm:ss.SSSZ` 형식의 UTC이다. 누적거리는 **mock 계약에서 정의한 정수 m**이며 실제 Pleos 반환 단위를 확인한 것이 아니다. 목적 값은 `business`, `commute`, `personal`, `null` 중 하나다. 메모는 최대 120자다. 미등록 차량/이용자, source=live, 알 수 없는 필드는 거부한다.

```json
{"eventId":"cf59f7f2-e173-4334-b451-9eeb7d077347","ackedLocalRevision":1,"serverVersion":1}
```

새 수신 ACK의 serverVersion은 expectedServerVersion+1이다. 같은 eventId와 같은 본문을 재전송하면 저장 당시 ACK를 재사용한다. 동일 eventId의 다른 본문은 409이다.

| 상태 | 의미 / 클라이언트 처리 |
|---|---|
| 200 | ACK 검증 후 해당 이벤트 전송 완료 |
| 400 | JSON/계약 오류, 데이터 보존 후 blocked 보류·개발 확인 |
| 403 | 개발 헤더 또는 origin 정책 실패, blocked 보류·원인 확인 |
| 409 | 서버 버전·리비전·eventId·원본 불변 충돌, 자동 덮어쓰기 금지 |
| 413 / 415 | 크기 초과 / Content-Type 오류, blocked 보류·원인 확인 |
| 500·연결 실패 | 동일 preparedEvent로 후속 재시도 |

목적 보완은 같은 tripId와 증가한 localRevision을 사용한다. 선행 ACK가 없는 상태에서 expectedServerVersion을 추정하지 않는다. 서버에 저장된 vehicleId/driverId/시각/거리/quality는 바꿀 수 없다. 현재 관리자 API는 조회만 지원한다.

5단계 웹 클라이언트는 408/429/5xx·연결/시간 초과를 동일 preparedEvent의 수동 재시도로 처리한다. 자동 재시도는 없다. 409 이외의 4xx(408/429 제외)와 HTTP 성공 응답의 잘못된 JSON은 원인 확인을 위해 보류한다. ACK 필드 불일치는 수신 완료로 반영하지 않고 경고 후 동일 이벤트의 명시적 수동 재시도만 허용한다. ACK가 유효해도 로컬 영수증 저장에 실패하면 미완료 상태를 유지한다. 이 구분은 클라이언트 처리 규칙이며 서버 요청·응답 필드나 SQLite 스키마를 변경하지 않는다.

## 격리 MVP API · 보완·월별 자료·모의 접수

위 `/api/` 계약과 별도다. `npm run demo:mvp`가 출력한 주소의 `/mvp-api/`를 사용하며 기존 개발 DB를 읽거나 가져오지 않는다. 이 서버는 `/api/trip-events`를 제공하지 않는다. 기존 MVP의 QR/코드·차량·음성·자동 업로드 경로는 유지하고 아래 경로를 추가했다. 모든 데이터는 가상이며 데모 직원 선택은 실제 인증이 아니다.

MVP 쓰기는 `Content-Type: application/json`, 최대 **4KiB**이고 정해진 필드만 허용한다. 기존 MVP의 Host/Origin 제한과 `Cache-Control: no-store`를 유지한다. 일반 API의 `X-FleetLog-Dev` 헤더를 MVP 인증으로 재사용하지 않는다.

| 메서드 / 경로 | 입력과 결과 |
|---|---|
| GET `/mvp-api/state` | 기존 상태 유지. `receivedTrips`는 최초 수신 원본에 최신 용도 보완을 겹친 표시본이며 보완 버전·이력을 추가한다 |
| POST `/mvp-api/trips/:tripId/amendments` | `{requestId,employeeId,expectedAmendmentVersion,purpose,destination,detailedPurpose}` → `{trip,amendment}` |
| GET `/mvp-api/monthly?month=YYYY-MM` | `{data,reports,submissions,simulationOutcome}`. 회사 전체·선택 월·전체 차량의 현재 자료와 저장된 자료 버전·모의 접수 결과 |
| POST `/mvp-api/reports` | `{requestId,month}` → `{report}`. 새 자료 버전 생성. 시연 패널의 월말 처리 재현도 같은 경로 사용 |
| GET `/mvp-api/reports/:reportId` | `{report}`. 고정 자료 내용과 현재 갱신/모의 제출 가능 상태 |
| GET `/mvp-api/reports/:reportId/trips.csv` | 같은 스냅샷의 운행 내역 CSV attachment |
| GET `/mvp-api/reports/:reportId/costs.csv` | 같은 스냅샷의 가상 비용 CSV attachment |
| POST `/mvp-api/submissions` | `{requestId,reportId}` → `{submission}`. 서버 준비 조건 재검사 후 로컬 모의 접수 |
| POST `/mvp-api/simulation/submission-outcome` | `{outcome:"success"\|"failure"}` → `{outcome}`. 다음 접수 시도의 결과를 정하는 개발용 모의 제어 |

### 원본과 용도 보완 버전

`purpose`는 `business`, `commute`, `personal` 중 하나다. `destination`·`detailedPurpose`는 각각 200자 이하 문자열이며 빈 문자열은 null로 보관한다. `expectedAmendmentVersion`은 0 이상의 정수다. `requestId`는 8~100자의 영문·숫자·`_`·`-`로 구성한다.

최초 서버 수신 시 `amendmentVersion:0`, `amendmentHistory:[]`다. 보완 후 표시본에는 목적지·용도·상세 목적·`purposeConfirmed` 네 필드만 최신 값으로 겹친다. `originalPurpose`는 최초 네 필드이고, 각 이력은 다음 구조다.

```text
Amendment { requestId, tripId, version, employeeId, changedAt, before, after }
before/after { purpose, destination, detailedPurpose, purposeConfirmed }
```

서버는 최초 수신 운행의 직원·회사와 요청 직원을 대조한다. 연결 해제 후에도 원래 직원은 보완할 수 있다. 현재 해당 직원의 연결 차량이 있다면 주차 확인이 필요하다. 다른 직원은 403, 미수신 운행은 404, 예상 보완 버전 충돌·확정 기록 편집·주차 미확인은 409다. 이번 MVP는 미확정 기록을 한 번 보완하는 범위이며 관리자 강제 수정이나 일반 편집을 제공하지 않는다.

운행/회사/직원/차량/연결 ID, 원본 시각·거리·품질, 준비된 업로드 본문, 최초 수신 payload와 ACK는 변경하지 않는다. 최초 MVP 업로드 ACK `{eventId,tripId,serverVersion:1}`의 의미도 유지한다. **보완 버전은 운행 업로드의 serverVersion과 별도**다. 최초 이벤트 재전송은 기존 ACK를 반환하며 최신 보완 표시값을 되돌리지 않는다. 동일 requestId·동일 본문 재시도는 이력을 추가하지 않고, 동일 ID의 다른 본문은 409다. 원본과 보완 기록 저장 실패 시 트랜잭션을 rollback하며 클라이언트는 입력을 유지한다.

### 월별 범위와 스냅샷 DTO

운행 시작 시각을 **Asia/Seoul의 날짜**로 변환해 `YYYY-MM`에 분류한다. 자정을 넘는 운행을 나누거나 거리를 다시 계산하지 않는다. 관리자 목록 필터는 월별 API나 자료 생성 범위를 바꾸지 않는다. 수신되지 않은 업로드 큐는 `pending`으로 분리하고 수신 건수·거리 합계에 포함하지 않는다.

```text
MonthlyData {
  month, company, scope:{timeZone:"Asia/Seoul",basis:"startedAt",allVehicles:true},
  employees, vehicles, trips, costs, pending,
  summary:{receivedCount,validDistanceM,excludedDistanceCount,
           unconfirmedCount,incompleteCount,pendingCount,costTotalKRW},
  byEmployee, byVehicle, byPurpose, issues
}
Group { key, count, validDistanceM, excludedDistanceCount }
Issue { code, message }
Report { id, companyId, month, version, createdAt, fingerprint,
         data:MonthlyData, stale, readiness:{canSubmit,reasons:Issue[]} }
```

`validDistanceM:null`은 합산 가능한 기록이 없음을 뜻하며 유효한 실제 합계 0과 구분한다. `quality:incomplete`·gap/유효하지 않은 거리는 합계에서 제외한다. 용도 미확정은 `byPurpose`의 `unconfirmed`이며 업무용으로 간주하지 않는다.

가상 비용은 고정 날짜의 `dummy-fixture`다. 2026-11에 차량1 유류비 68,000원·주차비 8,000원, 차량2 통행료 4,200원(합계 80,200원), 2026-10에 차량2 유류비 55,000원이 있다. 날짜·차량·항목·금액·가상 출처를 함께 보관하며 다른 월로 복제하지 않는다. 운행 ACK는 비용 영수증이 아니며 세율·공제·납부세액을 계산하지 않는다.

자료는 회사·월별 증가하는 `version`과 생성 시각을 가진다. 생성 당시 직원/차량 이름, 운행 ID·보완 버전·비용·집계·확인 필요 사유를 `data`에 고정한다. 현재 원본/수신·보완·마스터·비용·알려진 미전송 상태의 fingerprint가 달라지면 `stale:true`다. 현재 시각이나 단순 재조회만으로 갱신 필요가 되지는 않는다. 기존 내용을 덮어쓰지 않고 새 자료 버전을 생성한다. 같은 생성 요청의 재시도는 동일 자료를 반환한다.

CSV는 화면과 같은 `report.data`만 사용한다. 이름과 차량 번호도 생성 당시 값이다. UTF-8 BOM, CRLF, 모든 셀의 큰따옴표 및 내부 따옴표 이중 처리로 한글·쉼표·따옴표·줄바꿈을 보존한다. 선행 공백/제어문자 뒤 `=`, `+`, `-`, `@`로 시작하는 셀은 작은따옴표를 접두해 스프레드시트 수식 실행을 방지한다. 파일명은 `Fleetlog-DEMO-YYYY-MM-vN-trips.csv` 또는 `…-costs.csv`이고 각 행에도 가상 데이터·실제 신고 아님을 표시한다.

### 서버에 보관하는 모의 접수

```text
Submission { id, reportId, month, reportVersion,
             status:"processing"|"completed"|"failed", attempts:Attempt[] }
Attempt { id, number, requestId, requestedAt, readyAt, completedAt,
          outcome:"success"|"failure", receiptNumber, error, status }
```

모의 제출 시 서버 트랜잭션에서 현재 준비 조건을 다시 검사한다. `NO_RECEIVED_TRIPS`, `UNCONFIRMED_PURPOSE`, `INCOMPLETE_DISTANCE`, `PENDING_UPLOADS`, `STALE_SNAPSHOT` 중 하나라도 있으면 409로 차단한다. 초안 생성·다운로드는 이 조건과 별개로 가능하다. 이 검사는 MVP 내부 준비 조건이지 법적 세무 적격성 판정이 아니다.

`processing` 시도를 SQLite에 먼저 보관하고 서버 시각 기준 약 1초 후 `monthly`·`report` 등 결과 조회에서 처리 가능 여부를 확인하여 `completed`/`failed`와 모의 접수번호를 DB에 commit한다. 프런트엔드 타이머가 성공을 만드는 방식이나 실제 스케줄러가 아니다. 성공 번호는 `DEMO-…`이며 운행 수신 ACK와 별도다. 시도 생성 시 결과 모드를 고정하므로 패널의 이후 모드 전환은 진행 중 시도의 결과를 바꾸지 않는다.

한 자료에는 접수 기록 하나만 있다. 처리 중/완료된 자료의 중복 제출은 시도를 추가하지 않는다. 실패 후 새로운 requestId로 재시도하면 같은 접수 기록 안에 새 시도·시각·결과를 남긴다. 정확히 같은 requestId 재전송은 원래 요청 결과를 재사용하며 최신 처리 상태는 월별 조회에서 확인한다. 이후 운행이 추가·보완되면 자료는 갱신 필요가 되지만 과거 접수 시도·결과·번호는 바꾸지 않는다. 외부 세무 API·홈택스·인증서·신고·납부는 호출하지 않는다.
