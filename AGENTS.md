# Codex 작업 규칙

이 저장소는 현대·기아 차량용 앱 공모전 아이디어의 로컬 mock 스타터다. README와 docs/ARCHITECTURE.md를 읽고 작업한다. 사용자에게 한국어 존댓말로 설명한다.

## 반드시 유지할 동작

- 실제 SDK 좌표·API 이름·누적거리 단위를 추정해서 구현하지 않는다. `source:mock`과 live adapter를 분리한다.
- 사용자가 명시적으로 수집을 시작한다. 주행 중 용도/메모/음성 편집을 허용하지 않는다. 실제 상태가 불명확하면 parked로 간주하지 않는다.
- 한 운행 마치기와 수집 세션 종료를 구분한다. 재실행이 조용히 수집을 재개하지 않는다.
- purpose=null인 미확정 기록도 보존하고 전송한다. gap은 목적 보완으로 valid가 되지 않는다.
- 원본 시각·거리·품질과 purpose/note 보완을 구분한다. 기존 tripId에서 원본을 덮어쓰지 않는다.
- 로컬 저장 성공, 서버 ACK, 관리자 승인, 기간 마감, 세무신고는 다른 상태다.
- 같은 eventId 재전송은 준비된 본문 전체를 그대로 사용한다. 충돌을 새 eventId로 자동 우회하지 않는다.
- 미전송 선행 리비전 ACK 이후에만 후행 expectedServerVersion을 준비한다. ACK가 예전 리비전을 가리키면 최신 리비전을 전송 완료로 표시하지 않는다.
- 브라우저 단일 writer Web Lock을 유지한다. localStorage read-compare-write는 독자적인 원자적 잠금이 아니다.
- 서드파티 키·실차 데이터·개인정보·node_modules·빌드 산출물·SQLite 데이터를 ZIP 또는 Git에 넣지 않는다.

## 구조 및 검증

웹 apps/web, 공유 JS 도메인 packages/domain, 계약 packages/contracts, API services/api, 네이티브 apps/car-android.
웹과 Android reducer는 별도 언어 구현이다. 프로토콜을 바꾸면 양쪽을 함께 검토한다.
실제 SDK를 도입하기 전 공식 문서·권한·단위·수명주기와 mock/live 전환 실패 정책을 기록한다.

변경 범위에 맞는 의미 있는 테스트를 실행한다. 공통 흐름을 수정했으면 `npm run check`를 실행한다. Android는 환경을 갖춘 뒤 `testDebugUnitTest assembleDebug`와 에뮬레이터 검증을 수행한다. 실행하지 않은 검증을 통과했다고 쓰지 않는다.

상세 설계/미구현 항목은 docs/ROADMAP.md, API 계약은 docs/API.md에 있다. 운영 배포·실제 세무신고·외부 전송은 현재 범위에 포함되지 않는다.
