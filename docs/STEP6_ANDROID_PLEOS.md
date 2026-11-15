# Fleetlog · 6단계 Android 실행 검증과 Pleos SDK 경계

서비스 표시명은 현재 **Fleetlog**로 통일했습니다. 아래 APK 크기·해시·서명 검증은 당시 산출물의 이력이며, 기존 APK 파일명과 내용은 보존했습니다. 현재 이름 변경의 빌드 검증은 [브랜드 변경 기록](BRAND_FLEETLOG.md)에서 구분합니다.

검증일: **2026-11-15 KST**. Android 구현·Kotlin 단위 테스트·APK 빌드와 공식 Vehicle SDK 진단 코드 컴파일을 완료했습니다. **Android mock 화면 실행과 Pleos 실제 서비스 연결은 완료하지 못했습니다.** 아래에서 컴파일/JVM 실행/Android 런타임을 구분합니다.

## 결과 판정

| 항목 | 판정 | 이번에 확인한 범위 |
|---|---|---|
| Android 단위 테스트 | **실행 통과** | Gradle `testDebugUnitTest` JUnit **44/44**, 실패·오류·skip 0 |
| 기본 debug APK | **실행 통과** | `assembleDebug`, applicationId `io.fleetlog.demo`, min28/target35, APK 서명 검증 |
| 공식 SDK 포함 APK/타입 검사 | **실행 통과** | `-PpleosSdk=true`로 Vehicle2.3.2와 AAOS 주행 제한 진단 Activity 컴파일·JUnit44개·APK 생성 |
| mock 에뮬레이터 설치·실행 | **미실행** | 연결 장치/AVD/에뮬레이터 실행 파일 없음. 공식 emulator+API35 이미지 압축 크기만 현재 여유 공간 초과 |
| Kotlin→테스트 HTTP→SQLite→관리자 API | **실행 통과** | 실제 Android 프로젝트의 Kotlin transport와 reducer/codec를 JVM JUnit에서 실행. 임시 Node API·SQLite의 수신/보완/gap 조회 검증 2개 |
| Android 프로세스→테스트 서버→관리자 화면 | **미실행** | 에뮬레이터/테스트 장치가 없어 Android 네트워크 정책·화면 조작은 미검증 |
| Pleos SDK 초기화·서비스 연결 | **미실행** | 공식 typed 호출 코드는 컴파일했으나 전용 환경/Vehicle Service에서 실행하지 못함 |
| 실제 SDK capability·누적거리 수신 | **미실행** | 공개 artifact와 sources 확인만으로 지원·실제 값을 확인했다고 간주하지 않음 |
| 실제 음성 인식·안내 | **미실행** | mock adapter/세션 테스트 통과, 실제 STT/TTS 서비스·엔진·팀 권한은 미확인 |
| 실차 검증 | **미실행** | 실차·차량 인증·원본 실제 값·단위 대조 없음 |
| 기존 웹·서버 회귀 | **실행 통과** | `npm run check` **148/148** + 타입/빌드, `npm run test:e2e` 실제 Chrome **13/13** |
| 기존 데이터 보존 | **실행 통과** | 마지막 절의 읽기 전용 전후 전체 행 비교 |

## 시작 기준선과 도구 확보

- 시작 시 소스 manifest 101개 대비 변경은 없었습니다. 기존 수정본을 되돌리지 않았습니다. Git 메타데이터가 없는 작업 폴더입니다.
- 기존 API PID49059/4000, 웹 PID49060/5173과 실제 열린 `services/api/data/fleetlog.sqlite`를 확인했습니다. 기존 서버는 종료·재시작하지 않았습니다.
- DB를 `mode=ro`와 `query_only`로 열어 현재 운행 **4건·영수증 6건**의 ID·버전·원본/보완 payload·ACK를 기준으로 저장했습니다. 이전 보고 수에 맞춰 데이터를 바꾸지 않았습니다. 기준 JSON은 ignore 대상 `test-results/step6/before/database.json`입니다.
- JDK17.0.15와 기존 검증된 Gradle8.10.2를 사용했습니다. 기본 Java21 대신 명령별 JAVA_HOME을 JDK17로 지정했습니다.
- 기존 SDK 경로에 라이선스 파일만 있었습니다. **기존에 수락된 라이선스**를 이용한 Gradle의 공식 설치로 SDK Platform35 revision2, build-tools35.0.0, platform-tools37.0.1을 준비했습니다. 새 약관을 임의로 수락하거나 검증 안 된 wrapper JAR를 추가하지 않았습니다.
- `gradlew`는 Python 실행기입니다. JDK17과 Gradle8.10.2를 검사하고 `.bootstrap/gradle-8.10.2/bin/gradle`을 실행합니다. 공식 wrapper인 것처럼 기록하지 않습니다. `check-environment.py`도 현재 기본 전제 조건을 통과했습니다.

고정 AGP8.8.2·Kotlin2.0.0·compile/target35는 [공식 Vehicle 샘플](https://document.pleos.ai/en/docs/pleos-only/tutorial/vehicle-sdk-sample-app)과 대조했습니다. 이전 SDK 미설치·디스크 부족 실패 이력은 `apps/car-android/VALIDATION.md`에 남기되 현재 결과와 구분했습니다.

빌드 진행 중 Android `org.json`에 없는 `keySet()` 사용을 실제 Kotlin 컴파일 오류로 확인해 `keys()` iterator로 교체했습니다. JVM용 org.json과 Android API 차이였으며 최종 빌드는 통과했습니다. core/UI 인터페이스 교체 중 발생한 중간 `sampleTranscript` 미해결 오류도 최종 새 음성 흐름으로 교체한 뒤 해소됐습니다.

## Android 변경 내용

| 파일 | 변경 |
|---|---|
| `domain/Models.kt` | 목적 보완, local/acked/server 리비전, Outbox·영수증, UNKNOWN/UX 제한과 입력 취소, 원본 보존 |
| `data/TripRepository.kt` | 기존 AtomicFile·파일명 유지, 엄격한 v2→v3 codec·읽기 전용 마이그레이션 |
| `data/DevSyncClient.kt` | 준비 본문 문자열 유지, strict ACK 타입/리비전/버전, 일시 오류·blocked·409 구분, 로컬 테스트 endpoint |
| `data/OutboxSynchronizer.kt` | 실제 ViewModel/테스트 공유 sync engine, HTTP 중 mutex 해제, 최신 snapshot ACK 영속 처리 |
| `ui/FleetLogViewModel.kt` | 저장 후 공개, 저장 복구, 후행 ACK 순서, 음성 세션/초안 버전 재검사, freshness·foreground 입력 gate |
| `ui/FleetLogScreen.kt`, `MainActivity.kt` | Fleetlog 시작→수집→용도→요약→저장→보완, 개발 제어, 수집 종료 확인·수명주기 취소 |
| `platform/Adapters.kt`, `SpeechFlow.kt` | 출처·단계·주차/제한/freshness gate, 교체 가능한 모의 음성 port와 parser |
| `platform/PleosDistance.kt` | 공식 누적거리 km 선언 기반 변환 정책. 원본 Float·환경·앱 관측 시각 별도 보존 |
| `src/pleos/` | 선택적 읽기 전용 Odometer/CarUxRestrictions probe와 별도 진단 Activity·manifest |
| Android Gradle 설정 | 테스트용 org.json, 선택 property로만 공식 Vehicle repository/dependency·android.car 포함 |
| `src/test/`, `tests/fixtures/android-api-server.mjs` | Kotlin 회귀와 독립 HTTP·SQLite fixture. 기존 DB 사용 없음 |

패키지명·applicationId·기존 파일명은 변경하지 않았습니다. 표시 이름만 Fleetlog·MOCK으로 정리했습니다. SDK binary·APK·Gradle/SDK 설치본·키·로그·DB는 소스 manifest/Git에 포함하지 않습니다.

## 로컬 v2→v3 마이그레이션

파일은 계속 앱 내부 **`fleetlog-demo-v1.json`**입니다. wire schemaVersion1과 별개인 로컬 형식을 v3로 확장했습니다.

- 기존 tripId/eventId·시작/종료 시각·누적거리·quality·purpose/note를 유지합니다.
- v2의 synced=false 기록은 같은 eventId, localRevision1/baseServerVersion0으로 Outbox를 구성합니다. v2에는 준비 본문이 저장되지 않았으므로 기존 고정 mock wire 필드를 같은 값으로 준비합니다. 서버는 canonical payload 기반으로 동일 이벤트를 확인합니다.
- v2의 synced=true는 이전 클라이언트가 strict ACK1/1 확인 후에만 저장한 상태입니다. 이를 ackedRevision1/serverVersion1·해당 영수증으로 옮깁니다. 수신하지 않은 기록을 임의로 완료 처리하지 않습니다.
- load는 메모리에서만 마이그레이션합니다. 복구한 전체 snapshot의 AtomicFile 저장이 성공해야 v3 파일로 바뀝니다. write 실패 시 이전 내용은 유지합니다.
- 지원하지 않는 형식·잘못된 숫자/문자열/Boolean·missing/잘못된 nullable 객체·준비 본문 불일치·원본 변조는 거부하고 자동 초기화하지 않습니다. Android/JVM JSON의 숫자 박싱 차이는 논리적인 정수 비교로 처리합니다.

실제 사용자 Android 앱 데이터 파일은 이번 환경에서 읽거나 설치·삭제·재설치하지 않았습니다. 마이그레이션은 정상 v2 fixture와 손상 fixture로 Kotlin 테스트했습니다. 실제 장치의 AtomicFile crash·전원 종료·물리 저장 고장을 실행한 것은 아닙니다.

## 기록·Outbox·ACK 규칙

명시적 수집 시작과 한 운행 마치기/수집 종료를 구분합니다. 최초 finish의 종료 후보 시각·거리를 유지하고, 수정·음성 지연이 원본 경계를 늘리지 않습니다. 주행/UNKNOWN/UX 제한 전환은 입력·음성·종료 후보를 취소합니다.

record와 Outbox를 한 AtomicFile snapshot으로 저장한 후에만 UI를 공개합니다. 저장 실패는 직전 snapshot·초안을 유지하고 storage unhealthy와 오류 안내를 표시합니다. 초기 load 실패에는 빈 snapshot을 덮어쓰는 복구 버튼 동작을 막았고, 저장 중 실패는 기존 snapshot 저장 재확인 후 필요한 행동을 다시 시도할 수 있습니다.

`OutboxSynchronizer`는 단일 실행 가드와 공유 mutex를 사용합니다. 준비 본문을 먼저 저장하고 HTTP 동안 mutex를 해제합니다. 그동안 생성한 새 운행·보완을 최신 snapshot에서 유지합니다. 후행 expectedServerVersion은 실제 선행 영수증 뒤에 준비합니다. 같은 이벤트는 준비한 **문자열 본문까지 그대로** 재전송합니다.

ACK의 eventId와 실제 정수 타입·리비전·expectedVersion+1을 검사하고, 영수증/Outbox 제거/ackedRevision 갱신을 같은 저장으로 반영합니다. 옛 ACK는 최신 리비전 전체를 완료하지 않습니다. ACK 로컬 저장 실패는 transport 실패 처리 밖에서 중단해 미ACK 준비 본문을 보존합니다. 재시도는 서버의 동일 이벤트 영수증 ACK를 재사용합니다.

연결/timeout/408/429/5xx는 수동 재시도, 그 밖의 4xx는 blocked, 409는 conflict입니다. 해당 운행의 후행 변경은 보류하되 다른 운행은 전송할 수 있습니다. 자동 재시도·충돌 우회 ID·버전 추정·강제 원본 수정은 없습니다. 수집 종료 뒤 늦은 ACK는 수신 상태만 갱신하고 수집을 재개하지 않습니다.

## 음성·주행 제한

기본 mock 음성은 안내 완료 이벤트 후 인식을 시작합니다. 중간 결과는 미리보기, 최종 결과는 보수적으로 분리한 purpose/note 초안이며 요약→사용자 저장이 필요합니다. 복수/누락/불확실 용도는 사용자 선택을 요구합니다. 원음 파일이나 외부 AI/음성 서비스를 추가하지 않았습니다.

SpeechContext(sessionId/tripId), 초안 버전과 voiceEpoch를 검사합니다. 직접 수정·재출발·UNKNOWN/UX 제한·앱 이탈·취소·새 세션은 기존 결과를 무효화합니다. 최종 결과가 ViewModel mutex를 기다리는 동안 취소/편집돼도 **mutex 획득 후** 다시 대상·버전·foreground를 확인해 오래된 초안을 적용하지 않습니다.

InputGate는 연결 관측·명확한 PARKED·UX UNRESTRICTED·freshness를 모두 요구합니다. mock 상태는 30초 만료, 음성은 15초 제한이며 실제 서비스 주기나 UX 인증값이 아닙니다. 앱 재실행/이탈 후 주차/제한은 UNKNOWN이며 새 mock 확인과 명시적 수집 시작이 필요합니다. 속도0으로 주차를 판단하지 않습니다.

## 공식 SDK: 확인한 것과 못 한 것

공식 문서·POM/AAR/sources·권한/타입·팀 계정 미확인 상태는 [STEP6_SDK_ACCESS.md](STEP6_SDK_ACCESS.md)에 링크와 함께 기록했습니다. 공개 배포 파일이 없어서 막혔다고 보고하지 않습니다. Vehicle2.3.2와 STT/TTS3.3.1 배포 경로는 실제 HTTP200으로 확인했습니다. 공개 프로젝트 안내와 음성 배포 상태가 다르며 팀 Workspace의 승인·실제 서비스/엔진은 확인하지 못했습니다.

`-PpleosSdk=true`일 때만 공식 repository의 `ai.pleos.playground:Vehicle:2.3.2`, Android SDK35 `android.car`와 별도 `src/pleos/` 진단을 포함합니다. 실제 artifact에 대해 Kotlin 컴파일·APK를 만들었고 배포 바이너리를 임의로 생성하지 않았습니다.

- Odometer: `Vehicle.initialize()` 반환, capability 응답, read 지원 확인, 최초 유효 값, timeout/stale/error를 구분합니다. 해당 SDK의 public Vehicle에는 별도 service-ready callback이 없으므로 초기화 반환을 서비스 연결 완료로 표시하지 않습니다.
- 공식 sources의 누적거리 read/update는 nullable Float **km**입니다. 동일 listener를 쓰는 다른 trip API의 m와 혼동하지 않습니다. null/비유한/음수/역전/범위 초과/오래된 값은 사용 중지하며 0 또는 GPS 추정값으로 대체하지 않습니다.
- 변환은 Float의 십진 문자열×1000을 1m HALF_UP으로 반올림합니다. 원본 Float km와 앱 수신 시각을 별도로 보유합니다. Float가 잃은 정밀도를 복원하지 못하며 **실제 수신값·계기판과 단위를 대조한 것은 아닙니다.**
- AAOS CarUxRestrictions: 실제 lifecycle ready와 제한 callback/조회 경로를 typed 코드로 컴파일했습니다. disconnect·미수신·만료·제한은 fail closed입니다. 별도 검증된 기어/주차 관측이 아직 없어 parking은 UNKNOWN이고 실제 UX 제한이 풀려도 입력은 허용하지 않습니다.
- 진단은 명시적 `PLEOS_EMULATOR` 또는 `REAL_VEHICLE` 대상 extra가 있어야 시작합니다. 이 설정이 실차 인증/실차 검증을 뜻하지 않습니다. 종료/재시작은 토큰 무효화 후 같은 listener 해제·Vehicle release/Car disconnect를 수행합니다.

기본 MainActivity는 APP_MOCK만 사용합니다. 선택적 SDK 진단은 파일·기록 reducer·Outbox·서버 송신과 연결하지 않았습니다. 따라서 SDK 관측을 source=mock으로 위장하지 않았고, 미검증 live 데이터 전송을 위해 기존 mock API/SQLite를 확장하지도 않았습니다. 실제 수집 연결 전에는 인증·출처·동의와 서버의 하위 호환 계약을 별도로 준비해야 합니다.

STT/TTS 실서비스는 disabled입니다. 음성의 on-device/server/hybrid 권한·서비스·엔진·자격 정보와 오디오 포커스는 대상 환경에서 확인해야 합니다. SDK 초기화나 실제 음성을 실행했다고 표시하지 않습니다.

## 테스트 근거와 실패/미실행

| Kotlin suite | 실행 통과 수 | 핵심 경계 |
|---|---|---|
| TripReducerTest | 11 | 주차/명시 마치기/재실행 gap/재출발/중복 ACK |
| RevisionOutboxTest | 7 | 목적 보완·원본 불변·선행 ACK·옛 ACK·충돌 격리 |
| LocalSnapshotCodecTest | 8 | v2 migration·v3 roundtrip·준비 본문·손상/타입 거부 |
| OutboxSynchronizerTest | 5 | 실제 VM 공유 엔진의 준비 저장 실패·ACK 저장 실패·동시 실행·전송 중 보완·동일 본문 재시도 |
| SpeechFlowTest | 9 | 안내/중간/최종·모호성·실패/취소/늦은 결과·UNKNOWN/제한/freshness |
| PleosDistanceTest | 2 | 공식 선언 기반 km 반올림·null/오버플로 등 거부 |
| AndroidHttpContractTest | 2 | 실제 Kotlin wire→임시 HTTP/SQLite→최신 보완/단일 건수/gap 확인 필요 |

Kotlin HTTP 테스트는 Node의 실제 기존 계약 validator와 SQLite·관리자 API를 호출합니다. 웹의 공통 schemaVersion1, purpose=null→보완 리비전2, expectedVersion0→1, 원본 불변 기대를 실제 Kotlin wire로 검증합니다. 이것은 JavaScript 테스트를 Kotlin 테스트로 보고한 것이 아닙니다. 다만 **Android 앱 프로세스나 장치 네트워크에서 수행한 테스트도 아닙니다.**

초기 중간 컴파일은 API/인터페이스 교체 오류로 **실행 실패**했고 수정 후 재실행을 통과했습니다. 최종 기본/SDK 옵션 빌드는 각각 `BUILD SUCCESSFUL`, JUnit44개 오류0입니다. 실제 Android UI·AtomicFile 장치 고장·전원 종료·진짜 SDK callback·오디오 포커스·실차는 **미실행**입니다.

에뮬레이터는 `adb devices -l`에 장치가 없고 emulator/AVD도 없었습니다. 공식 저장소 카탈로그의 macOS arm64 emulator 압축 파일 약416~421MB, API35 Google APIs arm64 이미지 **1,778,933,980 bytes**이며 설치/AVD 공간은 별도입니다. 빌드 후 남은 공간은 약0.7~0.8GiB로 압축 파일 합계에도 못 미칩니다. 사용자 파일·다른 프로젝트 캐시를 삭제하지 않았고 디스크를 채우는 다운로드나 기존 앱 삭제/재설치를 시도하지 않았습니다. 디스크 부족은 실제 SDK 권한 거부와 다른 제한입니다.

## 재현 명령과 APK

Android 폴더에서 본인의 JDK/SDK 경로를 지정합니다.

```sh
JAVA_HOME="$(/usr/libexec/java_home -v 17)" \
ANDROID_HOME="$HOME/Library/Android/sdk" \
./gradlew :app:testDebugUnitTest :app:assembleDebug --no-daemon --max-workers=2
```

공식 SDK 진단 코드까지 포함하려면 같은 명령에 `-PpleosSdk=true`를 추가합니다. 기본 APK는 `apps/car-android/app/build/outputs/apk/debug/app-debug.apk`입니다. applicationId는 기존 `io.fleetlog.demo`, 표시명은 `Fleetlog · MOCK`, debug 서명 검증도 통과했습니다.

- 이번 기본 APK 복사본: `test-results/step6/apk/차곡-mock-debug.apk`
- 이번 SDK 진단 포함 APK: `test-results/step6/apk/차곡-sdk-probe-debug.apk`
- 기본 APK SHA-256: `eacb31aea5be81cd6714d69e1f7a73b94c62db79090760f0a308ea51093b8920`
- JUnit XML: `app/build/test-results/testDebugUnitTest/`; SDK 옵션 결과 복사본은 `test-results/step6/pleos-unit-results/`
- 최종 로그: `test-results/step6/android-build-final.log`, `pleos-build-final.log`, `web-check.log`, `web-e2e.log`

APK·검증 데이터는 ignore 대상이며 소스 배포/manifest에 넣지 않습니다. 기본과 SDK 옵션 빌드는 같은 applicationId이므로 기존 기기에 편의상 교체 설치하지 마세요. 각각 새 테스트 장치/AVD·앱 데이터에서 검증합니다. [Android README](../apps/car-android/README.md)에 새 임시 서버 DB와 `mockApiEndpoint`/명시적 SDK 진단 Activity 실행 절차를 정리했습니다.

루트에서 `npm run check`, `npm run test:e2e`도 이번 작업에서 다시 실행해 148개·13개를 통과했습니다. 이 브라우저 결과는 웹/서버 회귀이며 Android 화면 검증으로 간주하지 않습니다.

## 웹과 남은 차이·다음 조건

1. Android는 목적 보완·리비전·동기화 규칙을 구현했지만 네이티브 화면·실제 lifecycle·AtomicFile crash·장치별 레이아웃은 테스트 AVD에서 확인해야 합니다. 웹은 실제 Chrome UI 검증까지 통과한 별도 클라이언트입니다.
2. 저장 공간을 확보한 뒤 공식 command-line tools(`sdkmanager`/`avdmanager`) 또는 Android Studio, emulator·새 시스템 이미지와 테스트 AVD를 준비합니다. JUnit/APK 성공 이후에도 실제 설치→화면→재실행→독립 API→Fleetlog 비즈 최신 수신본까지 별도로 실행해야 합니다.
3. Pleos_Connect_v2.1/Vehicle Service2.3.22 등 공식 샘플 기준의 실제 제공 AVD/서비스 버전과 팀 Workspace 상태를 확인합니다. 공개 artifact 가용성과 팀 승인·기능 지원은 별개입니다.
4. 기어/차량 상태의 AAOS property·capability·권한·timestamp/freshness와 실제 데이터 단위를 확인한 뒤에만 parking UNKNOWN을 해제합니다. 진단 callback으로 바로 수집을 시작하지 않습니다.
5. 실제 거리·실제 음성을 기록에 연결하기 전에는 non-mock 출처·인증·동의·서버 검증/관리자 표시·기존 데이터 호환 확장을 함께 검증해야 합니다. 이번에는 실제 SDK 값을 보내지 않았습니다.
6. STT/TTS의 팀 사용 상태·Speech Service·on-device 엔진 또는 서버 등록·오디오 포커스·권한 거부/철회·중단을 실제 환경에서 검증합니다. 현재 mock 성공은 실제 인식 성공이 아닙니다.
7. 충돌/blocked 복구 도구·실사용 인증·회사 권한·관리자 승인·기간 마감·세무신고는 계속 미구현입니다. 보완 요청이나 SDK 서비스 연결을 성공한 것처럼 꾸미지 않습니다.

## 최종 보존 비교

작업 후 같은 DB를 읽기 전용으로 재비교해 **운행 4→4건·영수증 6→6건 전체 행이 동일**함을 확인했습니다. 운행 ID·리비전·원본/보완 payload·시각과 이벤트 본문·ACK가 유지됐습니다. 테스트 장치가 없었으므로 기존 Android 설치 데이터에 접근·삭제하지 않았고 기존 브라우저 저장소도 초기화하지 않았습니다.

기존 소스 101개 중 16개(Android와 실행 문서)를 변경했고 **나머지 85개는 기준 해시와 동일**합니다. 기존 웹·도메인·계약·API·SQLite 코드·의존성은 유지했습니다. 기존 서버 PID49059/49060과 웹/health HTTP200도 확인했습니다. JUnit fixture가 만든 서버·DB만 정리했고, 이번 장치 목록 확인으로 새로 시작했던 adb daemon도 빈 장치 목록 확인 후 종료했습니다. 기존 사용자 서버·Gradle 프로세스를 일괄 종료하지 않았습니다. 상세 비교는 `test-results/step6/preservation.json`에 있습니다.
