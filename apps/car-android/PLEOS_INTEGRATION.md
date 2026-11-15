# 실제 Pleos adapter 연결 전 확인

> 6단계에서 공식 Vehicle 2.3.2 배포 파일·타입·누적거리 km 선언을 확인하고 선택적 진단 코드를 컴파일했습니다. 아래는 이전 조사/준비 체크리스트이며 현재 근거는 [SDK 접근 기록](../../docs/STEP6_SDK_ACCESS.md), 실제 실행 판정은 [6단계 결과](../../docs/STEP6_ANDROID_PLEOS.md)가 우선합니다. 실제 서비스/실차 수신은 확인하지 못했습니다.

현재 `MockVehicleAdapter`와 `MockSpeechAdapter`만 앱에서 생성합니다. `DisabledPleosVehicleAdapter` / `DisabledPleosSpeechAdapter`는 명시적으로 실패하며 mock 데이터를 대신 반환하지 않습니다. 단순히 mock 표시를 지워 실차 연결로 전환할 수 없습니다.

1. Pleos Playground 프로젝트와 공식 전용 AVD를 준비합니다. SDK import 문서와 발급된 권한을 직접 확인하고, **현재 공식 문서의 artifact 좌표·버전·레포지터리**를 프로젝트에 추가합니다. 이 스타터는 이를 추정하거나 키를 포함하지 않습니다.
2. 사용할 API의 capability, 실제 read 접근, area, `@RequiresPermission`, 리스너 수신을 각각 검증합니다. 초기화나 리스너 등록 함수의 반환만으로 데이터 수신 성공을 표시하지 않습니다.
3. Odometer의 공개 목차에서 확인한 이름은 `checkCurrentDistanceDrivenCapabilities`, `getCurrentDistanceDriven`, `registerDistanceDriven`, `unregisterDistanceDriven`입니다. **이 문서 검토만으로 개별 반환 타입·단위·정밀도·갱신 주기·원천 타임스탬프는 확정하지 않았습니다.** 실제 SDK 선언과 샘플 출력·계기판을 비교해 검증한 뒤 domain의 정수 meter로 변환하세요. 원본값/원본단위/수신시각과 원천시각(제공될 때)을 분리 보존해야 합니다.
4. 시동 ON 자동기동, 시동 OFF 직전 실행, 백그라운드 지속 수집은 구현되어 있지 않습니다. 실제 환경 검증 전에는 자동운행 시작/종료를 보장하지 않습니다. 수집 세션 종료는 운행 종료와 다른 사건입니다. 데이터 공백을 이후 누적거리로 탐지해도 그 사이의 운행 목적·사용자를 복원한 것으로 취급하지 않습니다.
5. UI는 플랫폼 `CarUxRestrictionsManager`/`CarUxRestrictions`를 반영해야 합니다. 별도로 지원이 검증된 차량 신호로 주차 여부를 판정하고, 불명확하면 입력을 막습니다. 현재 mock parking enum은 실제 차량 안전 판정이 아닙니다. 속도 0 또는 주차 브레이크 한 신호만으로 안전한 주차를 확정하지 마세요.
6. `SpeechToText`는 텍스트 인식, `TextToSpeech`는 안내 출력입니다. 목적 분류·확정은 앱에서 구현하고 사용자가 확인해야 합니다. 공모전 공지상 LLM SDK와 Gleo Interface 승인 신청을 전제로 삼을 수 없으며, 차량 마이크를 외부 STT 서비스로 직접 보내는 방식은 지원되지 않습니다. 고유명사 오류, 인식 실패, audio focus, 주차 해제 시 입력 중단을 시험하세요.
7. 운영 서버에는 HTTPS를 사용하고 회사/차량/사용자 인증과 데이터 동의·권한·접근통제를 구현합니다. 이 샘플의 `local-only` 헤더와 HTTP 예외는 개발용이며 실데이터 전송용이 아닙니다. 네트워크 단절 시 로컬 저장 후 outbox를 재시도하고 서버 ACK와 세무 신고 완료를 구분하세요.

## 연결 후 필수 시나리오

- API 미지원, 권한 없음, 빈 값, 서비스 연결 끊김에서 수집 성공·주차 안전으로 오인하지 않는지
- 주행 진입 즉시 입력 비활성화, 음성 세션 정리, 화면 크기 변경과 전후면 전환
- 프로세스 종료·시동 OFF·재기동에서 원본 기록이 보존되고 누락이 표시되는지
- 누적거리 단위 전환, 정밀도/반올림, 역전값, 중복/지연/누락 콜백
- 동일 eventId 재시도, 서버 충돌/마감잠금, 부분 전송 성공, ACK 뒤 로컬 저장 실패

## 공식 문서

- 공모전 개발 범위: https://appdevchallenge.auto-hmg.io/notice/c0a1a000-2026-4923-8000-000000000008
- 시작 가이드: https://document.pleos.ai/en/docs/pleos-only/getting-started
- Vehicle sample: https://document.pleos.ai/en/docs/pleos-only/tutorial/vehicle-sdk-sample-app
- Vehicle SDK: https://document.pleos.ai/en/docs/pleos-only/connect-sdk-pleos/Vehicle/intro
- Odometer: https://document.pleos.ai/en/docs/pleos-only/connect-sdk-pleos/Vehicle/vehicle/ai.pleos.playground.vehicle.api/odometer/entry
- 권한: https://document.pleos.ai/en/docs/pleos-only/connect-sdk-pleos/Vehicle/vehicle-permission
- 주행 UX: https://document.pleos.ai/en/docs/pleos-only/vehicle-app-developer-guide/driving-restriction-development-guide
- 생명주기: https://document.pleos.ai/en/docs/pleos-only/vehicle-app-planning-guide/app-structure-screen-model
- 네트워크: https://document.pleos.ai/en/docs/pleos-only/vehicle-app-planning-guide/platform-api-architecture

2026-11-14 문서 검토 기준. 공식 문서의 실제 제공 상태와 현재 SDK 선언이 최종 기준입니다.
