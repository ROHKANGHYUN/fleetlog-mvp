# Fleetlog · Android 실행 환경 후속 검증

서비스 표시명은 현재 **Fleetlog**로 통일했습니다. 아래 APK 크기·해시·서명 검증은 당시 산출물의 이력이며, 기존 APK 파일명과 내용은 보존했습니다. 현재 이름 변경의 빌드 검증은 [브랜드 변경 기록](BRAND_FLEETLOG.md)에서 구분합니다.

검증일: **2026-11-15 KST**. 직전 [Android 구현 기록](STEP6_ANDROID_PLEOS.md)의 결과를 재사용한 것과 이번에 실행한 것을 구분합니다. 이번에는 실행 환경을 다시 진단하고 선택적 SDK 진단의 오류 처리를 수정했습니다. **Android 화면 실행·Pleos 에뮬레이터 서비스 연결·실차 검증은 모두 미실행**입니다. APK/JVM 성공으로 이 항목을 대체하지 않습니다.

## 이번 결과

| 항목 | 판정 | 이번 실행 근거 |
|---|---|---|
| 환경·장치·AVD·공간 진단 | **실행 통과** | 읽기 전용 스크립트·`adb devices -l`·패키지 XML·공식 ZIP 메타데이터 조회 |
| 기본 Android 단위 테스트 | **실행 통과** | 최종 Gradle 실행 JUnit **44/44**, 실패/오류/skip 0 |
| SDK 옵션 단위 테스트 | **실행 통과** | JUnit **49/49** = 기존 44 + 실제 probe 상태 머신의 fault test 5 |
| 기본/SDK 옵션 APK 빌드·서명 | **실행 통과** | 각각 `assembleDebug` 성공, apksigner v2 검증 성공 |
| 기본 APK 설치·실제 화면 조작 | **미실행** | 연결 장치 0·등록 AVD 0·emulator 실행파일 없음·설치 공간 부족 |
| Android 프로세스→서버→Fleetlog 비즈 | **미실행** | 장치가 없어 설치·장치 네트워크·화면 조작 미검증 |
| Kotlin→HTTP→SQLite→관리자 API | **실행 통과** | 기존 AndroidHttpContractTest 2개를 이번 Android JVM 테스트에서 재실행 |
| 웹 자동 테스트·타입 검사·빌드 | **실행 통과** | `npm run check` **156/156**, TypeScript/Vite 성공. 최종 fixture 수정 후 `npm test`도 156/156 |
| 실제 Chrome 웹 E2E | **실행 통과** | `npm run test:e2e` **16/16** = 기존 13 + 새 격리 데모 3 |
| 별도 웹 데모 실행 | **실행 통과** | `npm run demo` 빌드·HTTP200·빈 수신 목록·종료 정리, 실제 Chrome 3개 시나리오 |
| SDK 초기화·서비스·실제 값·실제 음성 | **미실행** | 아래 개별 단계 표 참고 |
| 실차 | **미실행** | 실차·자격·차량 원본 대조 환경 없음 |
| 기존 개발 데이터 보존 | **실행 통과** | 운행 4건·영수증 6건 전체 행의 읽기 전용 전후 비교 일치 |

이번 최종 테스트·빌드에서 **실행 실패는 없습니다**. 과거 `No space left on device`와 중간 컴파일 실패 이력은 과거 기록에 보존했습니다. 이번에는 충족되지 않는 공간에 이미지 설치를 시도하거나 설치 실패를 반복하지 않았습니다.

## 기준선과 보존

- Git 메타데이터가 없는 작업 폴더입니다. 시작 시 `MANIFEST.sha256`의 **117개** 소스를 비교했고 변경은 없었습니다. 기존 사용자 수정본이 담긴 현재 기준선을 유지했습니다.
- 기존 API PID49059/4000, Vite PID49060/5173 및 실제 열린 DB `services/api/data/fleetlog.sqlite`를 확인했습니다. 종료·재시작하지 않았습니다.
- SQLite를 `file:…?mode=ro`, `PRAGMA query_only=ON`으로 열어 trip/receipt 전체 행을 정렬해 비교했습니다. 건수를 보고에 맞추지 않았고 전체 ID·버전·원본/보완 JSON·ACK·반영 시각이 일치했습니다.
- 기준 ID와 server/local revision: `8ee46d41-6382-4b99-933f-340500330ce4` 2/2, `b405563b-c852-4fd0-9caa-62e890dd196e` 1/1, `c73f61c3-8d12-45a5-8a64-d5856b618131` 2/2, `d820c66d-47d3-4b47-a55a-d5b8ffd331b4` 1/1.
- 비교 자료는 ignore 대상 `test-results/runtime/before/database.json`, `after/database.json`입니다. 실제 DB·로그·APK를 소스 manifest나 공유 ZIP에 넣지 않습니다.
- API/SQLite 스키마·브라우저 저장소 키·Android applicationId/내부 파일명·wire 계약을 변경하지 않았습니다. 서버/웹/Android 기본 기록 흐름을 다시 구현하지 않았습니다.

## 환경과 공간 원인

| 대상 | 이번 관측 |
|---|---|
| 호스트 | macOS arm64 |
| 기본 Java / 빌드 Java | 기본 Java21.0.8, 명령별 JAVA_HOME으로 JDK17.0.15 사용 |
| JDK17 경로 | `/opt/homebrew/Cellar/openjdk@17/17.0.15/libexec/openjdk.jdk/Contents/Home` |
| SDK 경로 | `사용자 홈/Library/Android/sdk` (당시 로컬 경로, 실행 시 `ANDROID_HOME` 확인) |
| Gradle | 프로젝트 Python `gradlew` → 검증된 `.bootstrap/gradle-8.10.2/bin/gradle`. 공식 wrapper가 아님 |
| 프로젝트 | AGP8.8.2·Kotlin2.0.0·compile/target35·min28 |
| 설치 패키지 | Platform35 revision2·build-tools35.0.0·platform-tools37.0.1 |
| emulator / SDK Manager | emulator 디렉터리는 **0B**, 실행파일 없음. sdkmanager/avdmanager 없음 |
| 시스템 이미지·AVD·장치 | 이미지 없음, `~/.android/avd` 등록 0, adb 장치 0 |
| 선택한 실행 대상 | **없음**. 개인용 장치 자동 선택·새 AVD 생성·앱 설치 없음 |
| SDK artifact | APK에 Vehicle2.3.2/code73 포함, 최소 Vehicle Service2.3.13/code65 metadata 확인 |
| 실제 서비스·AVD 버전 | **미확인**. APK 요구 metadata는 설치된 서비스 버전의 증거가 아님 |

시작 여유 공간은 **1,766,612,992B**, 메타데이터 보고 당시 **691,568,640B**, 최종 DB 비교 당시 **624,484,352B**였습니다. SDK·AVD·프로젝트가 같은 데이터 볼륨입니다. 검사 시점 간 가용 공간은 변하며 감소분 전체의 원인을 프로젝트로 단정하지 않습니다. 관련 경로만 점검했으며 사용자 파일 전체를 스캔하거나 삭제하지 않았습니다.

공식 Google 저장소의 macOS arm64 stable emulator와 API35 AOSP arm64 이미지(더 큰 Google APIs 이미지 대신)를 조회했습니다.

| 다운로드 후보 | 압축 bytes | ZIP 중앙 디렉터리의 압축 해제 논리 bytes |
|---|---:|---:|
| emulator37.2.13 `emulator-darwin_aarch64-16740729.zip` | 416,113,219 | 1,309,741,043 |
| `system-images;android-35;default;arm64-v8a` revision2 | 769,099,654 | 1,769,864,261 |
| 합계 | **1,185,212,873** | **3,079,605,304** |

전체 압축 파일과 추출본을 함께 두는 일반 경로는 합계 **4,264,818,177B**에 AVD·도구 등의 공간이 추가됩니다. 위 3.08GB도 전체 설치 예산이 아닙니다. userdata/cache/snapshot·실제 파일시스템의 sparse/compression 물리 할당·실행 중 사용량은 **미측정**입니다. 따라서 현재 공간에서 안전한 일반 설치를 충족한다고 판단할 수 없어 다운로드/압축 해제/AVD 생성을 시작하지 않았습니다. 작은 API28 후보도 조사했지만 논리 추출 크기가 더 커 대안으로 선택하지 않았습니다.

근거: [공식 repository catalog](https://dl.google.com/android/repository/repository2-3.xml), [AOSP system image catalog](https://dl.google.com/android/repository/sys-img/android/sys-img2-3.xml). 카탈로그와 HTTP206/Content-Range를 확인한 bounded ZIP directory Range만 읽었습니다(archive 메타데이터 44,297B). 전체 패키지 다운로드·설치·라이선스 변경은 없습니다. Pleos 전용 이미지의 크기나 접근 권한을 일반 AOSP 이미지와 같다고 가정하지 않습니다.

마지막 관련 경로 관측은 SDK 약353MiB, 프로젝트 Gradle bootstrap 약145MiB, app/build 약80MiB, 공유 Gradle caches 약1.45GiB였습니다. 공유 캐시는 다른 프로젝트에도 영향을 줄 수 있어 삭제하지 않았습니다. `/Volumes`에서 이 작업에 제공된 별도 저장 위치는 확인되지 않았고 다른 볼륨을 임의로 설치 대상으로 쓰지 않았습니다.

과거 오류는 `apps/car-android/VALIDATION.md`의 Kotlin 의존성 다운로드 중 `java.io.IOException: No space left on device`이며, 이전 Step6의 중간 Kotlin 컴파일 오류는 당시 수정 후 해결됐습니다. 이번 빌드에는 재현되지 않았습니다. 현재 주된 실행 차단은 **실행 도구/이미지/대상 부재와 부족한 여유 공간**이며 SDK 권한 거부로 관측한 것이 아닙니다.

## 실제 수정

| 파일 | 변경 |
|---|---|
| `scripts/check-runtime.py` (Android 폴더) | 기본 읽기 전용 inventory. 빌드 사전조건·Android 실행·Pleos 확인 분리, 선택적 adb/명시적 serial, 공식 다운로드 크기 측정 |
| `PleosOdometerProbe.kt` | 실제 SDK 호출만 Operations port로 분리. initialize/capability/register/read의 LinkageError에도 토큰 무효화→타이머 취소→같은 listener 해제→Vehicle release→ERROR/관측 비움 |
| `PleosProbeActivity.kt` | start 전에 probe 소유권 확보. 부분 초기화 오류 후에도 lifecycle 정리 가능 |
| `CarUxRestrictionProbe.kt` | manager 조회/refresh 호환 오류에서 disconnect·serviceReady=false·입력 차단 |
| `src/pleosTest/…/PleosProbeLifecycleTest.kt`, `app/build.gradle.kts` | SDK 옵션에서만 실제 probe 상태 머신의 JVM fault test 5개 포함 |
| 루트 `scripts/demo.mjs`, `package.json` | 새 임시 DB·빈 포트·loopback 웹 데모. 포트 충돌 시 기존 서버 재사용 안 함, 종료 시 자기 임시 자원만 정리 |
| `tests/runtime-check.test.mjs`, `tests/demo.test.mjs` | 환경 진단 5개, 실제 임시 HTTP/SQLite·포트/종료 정리 3개 |
| `e2e/demo.spec.mjs` | 실제 데모 서버+독립 Chrome 컨텍스트에서 3개 시연 |
| README 2개·본 문서·STEP7 | 환경 점검·한계·격리 데모 재현 절차 |

probe 테스트는 부분 초기화/등록/읽기 LinkageError, 정리 중 악성 늦은 콜백, 초기화/지원/최초값 분리, null/시간초과의 0 대체 금지, close·재연결 후 이전 콜백 및 중복 capability를 검증합니다. 제어 가능한 fake SDK Operations와 타이머를 사용하며 **실제 Android 서비스 실행은 아닙니다**. CarUx의 실제 서비스 경로는 컴파일 검증이며 런타임 fault test를 수행한 것으로 기록하지 않습니다.

환경 검사도 실행 준비 완료라고 과장하지 않습니다. `build_prerequisites_found`는 파일/JDK 발견이며 Gradle 버전 실행 검증은 실제 빌드가 담당합니다. adb 조회 실패는 빈 목록과 구분하고, serial 없는 장치 inventory는 장치 선택이 아닙니다.

## SDK·출처·음성 개별 판정

| 단계 | 판정 | 확인/남은 조건 |
|---|---|---|
| 의존성 resolve·typed Kotlin 컴파일·APK 패키징 | **실행 통과** | 공식 Vehicle2.3.2 artifact 사용 |
| Android 런타임 SDK 클래스 로딩 | **미실행** | 장치 설치/실행 필요 |
| `Vehicle.initialize()` 실제 호출 반환 | **미실행** | 전용 환경 필요. JVM fake 호출과 구분 |
| Vehicle Service 연결 | **미실행** | 서비스 설치/ready/실제 응답 미관측 |
| 권한·팀 프로젝트 자격·서명 조건 | **미실행** | manifest 포함만 확인, 실제 서비스 승인·팀 Workspace 미확인 |
| 누적거리 capability·최초 값·업데이트 | **미실행** | 지원/원본 타입·값·단위·범위를 실제 서비스와 대조해야 함 |
| AAOS UX 연결·제한·disconnect | **미실행** | typed 코드 빌드만 확인, 실제 주차 근거 별도 필요 |
| 구독 해제·재연결 | **미실행** | JVM fault test 통과와 실제 서비스 결과를 구분 |
| 음성 안내 완료·인식·최종 결과 | **미실행** | STT/TTS 서비스·엔진·권한·팀 자격·오디오 수명주기 미확인 |
| 음성 취소/늦은 결과 | **실행 통과** (mock) | 기존 Kotlin/웹 mock 회귀. 실제 음성 SDK는 미실행 |
| 실차 원본 대조 | **미실행** | 실차·권한·서비스·계기판 대조 필요 |

[공식 샘플 가이드](https://document.pleos.ai/en/docs/pleos-only/tutorial/vehicle-sdk-sample-app)를 이번에 다시 확인했습니다. 가이드의 Pleos_Connect_v2.1(Android14)·Vehicle Service2.3.22는 참고 환경이며 **이 PC에 설치된 버전이 아닙니다**. 초기화 반환은 서비스/기능 지원 증거가 아니고 일반 Android 이미지는 전용 Vehicle Service 환경을 대신하지 않습니다.

기본 앱 APP_MOCK, Pleos 진단의 PLEOS_EMULATOR/REAL_VEHICLE 지정은 분리돼 있습니다. SDK 진단은 reducer·파일·Outbox·서버와 연결되지 않으므로 실측 값을 `source:mock`으로 송신하지 않습니다. 실제 SDK 연결이 실패해도 mock으로 자동 전환하지 않습니다. 웹/Android mock 전송과 관리자 상세의 `source:mock` 표시는 기존 계약대로 유지됩니다.

누적거리 nullable Float km는 이전 공식 sources 확인에 따른 **선언 기준**이며 이번에도 실제 SDK 원본은 미수신입니다. 진단은 원본 Float km/앱 관측 시각과 1m HALF_UP 변환을 구분합니다. null/오류/역전/지원 불가/만료는 0으로 바꾸지 않습니다. 속도0이나 UX 제한 해제만으로 PARKED로 판단하지 않고 parking UNKNOWN·입력 차단을 유지합니다. 실제 지원 기어/차량 상태 경로 확인이 남았습니다. 외부 음성·AI 서비스와 원음 저장은 추가하지 않았습니다.

## 재현 명령과 다음 실행 순서

프로젝트 루트에서 환경만 조회합니다. 기본 명령은 adb를 호출하지 않습니다. `--probe-adb`는 adb daemon을 시작할 수 있으며 `--serial` 없는 상태에서는 대상을 고르지 않습니다.

```sh
JAVA_HOME="$(/usr/libexec/java_home -v 17)" \
ANDROID_HOME="$HOME/Library/Android/sdk" \
python3 apps/car-android/scripts/check-runtime.py --probe-adb --metadata
```

이번 JSON은 `test-results/runtime/environment.json`에 보관했습니다. 디스크 값은 해당 관측 시점의 값입니다. 현재 실행에만 환경변수를 지정했으며 전역 Java/SDK 설정은 바꾸지 않았습니다.

Android 폴더에서 두 구성을 각각 실행합니다.

```sh
JAVA_HOME="$(/usr/libexec/java_home -v 17)" \
ANDROID_HOME="$HOME/Library/Android/sdk" \
./gradlew :app:testDebugUnitTest :app:assembleDebug -PpleosSdk=true \
  --no-daemon --max-workers=2 -Dorg.gradle.jvmargs=-Xmx1g --console=plain

# 같은 명령에서 -PpleosSdk=true를 빼면 기본 MOCK (44개) 구성
```

마지막 기본 빌드 출력은 `app/build/outputs/apk/debug/app-debug.apk`입니다. 두 구성이 같은 applicationId이므로 구분된 APK/새 테스트 환경에서 다룹니다. 이번 ignore 대상 복사본은 `test-results/runtime/apk/차곡-mock-debug.apk`(27,270,293B, SHA256 `eacb31aea5be81cd6714d69e1f7a73b94c62db79090760f0a308ea51093b8920`), `차곡-sdk-probe-debug.apk`(31,380,583B, SHA256 `f94f4ae0ed6169b6286afac1f2a73764cccbcc9c885f5fc69c3ffb339d50094b`)입니다.

**장치가 준비된 뒤의 미실행 절차**:

1. 사용자 지정 테스트 장치/새 AVD serial을 명시해 검사합니다. 일반 Android는 mock 검증용, 전용 Pleos AVD는 실제 서비스 검증용입니다. 기존 앱이 설치돼 있으면 삭제/데이터 초기화/편의상 교체하지 않고 별도 환경을 마련합니다.
2. 루트에서 `npm run demo -- --port=4307`로 임시 DB·loopback 서버를 실행합니다. 새 테스트 에뮬레이터에 기본 APK를 `adb -s SERIAL install …`로 설치하고 MainActivity에 `--es mockApiEndpoint http://10.0.2.2:4307/api/trip-events`를 전달합니다. 기존 [Android README](../apps/car-android/README.md)의 조작 순서를 따릅니다.
3. 정상 기록·미확정 보완·미전송 상태 재실행·입력 제한/늦은 음성·일시 실패 동일 이벤트 복구·Fleetlog 비즈 수신을 화면에서 검증합니다. UI 수명주기/AtomicFile/네트워크를 JVM 결과로 대체하지 않습니다.
4. 물리 장치에는 `10.0.2.2`를 그대로 적용하지 않습니다. 현재 cleartext 정책도 해당 emulator host만 허용합니다. 명시적 테스트 장치와 loopback 전달 경로를 확인한 뒤 필요한 프로젝트 범위 설정을 검토해야 하며, 외부 바인딩/전역 정책 완화를 하지 않습니다.
5. 별도 전용 Pleos 환경에서 SDK 진단 APK를 설치하고 `adb -s SERIAL shell am start -n io.fleetlog.demo/io.fleetlog.demo.platform.PleosProbeActivity --es environment PLEOS_EMULATOR`로 실행합니다. 실차 대상은 확인된 별도 환경에서만 REAL_VEHICLE을 명시합니다.
6. SDK 단계 표의 각 관측·오류/permission·원본 단위·변환·disconnect/stale·재구독을 따로 기록합니다. 자격 정보는 출력하지 않습니다. 음성은 팀 서비스/엔진 지원을 먼저 확인한 뒤 실제 안내→인식→확인·취소를 검증합니다.

필요한 조치는 **사용자가 지정한 테스트 기기 또는 호환 Pleos AVD**, 이미지 접근 경로/팀 자격/서비스 버전, 그리고 실제 설치/AVD 예산을 만족하는 승인된 저장 공간입니다. 사용자 문서·SDK·AVD·공유 캐시의 삭제/이동은 수행하지 않았습니다. 별도 저장소나 기기 정보가 없으므로 실행 대상을 추정해 구성하지 않았습니다.

## 웹 시연과 남은 제한

루트 `npm run check`, `npm test`, `npm run test:e2e`를 이번에 실행했습니다. 기존 148개에 환경 점검5·데모HTTP3을 더해 156개이며 기존 테스트를 삭제하거나 약화하지 않았습니다. Chrome E2E는 기존 정상 음성/취소/지연·오프라인·실패 재시도·관리자·다중 탭·1280×720/960×540/640×720 13개와 새 demo3개 모두 통과했습니다. 화면 크기 검증은 **웹의 자동 클릭/레이아웃 assertion과 스크린샷**이며 Android 화면 검증이 아닙니다.

새 demo3개는 로컬 저장 시 관리자0→ACK 후1, 미확정 보완 같은 ID/version2/단일건수/원본 유지, 오프라인 저장→새로고침 기록·Outbox 유지/수집 중단→온라인 명시 전송을 확인합니다. [STEP7_DEMO_PLAN.md](STEP7_DEMO_PLAN.md)에 시연과 실패 복구를 정리했습니다. 모든 fixture는 새 임시 DB·동적 포트·독립 브라우저 컨텍스트를 사용하고 종료 시 자기 자원만 정리합니다.

로그는 `test-results/runtime/`의 `android-baseline.log`(첫 기본 실행은 UP-TO-DATE), `android-sdk.log`, `android-default-final.log`, `check.log`, `test-final.log`, `e2e.log`입니다. SDK/default JUnit XML은 각각 `android-sdk-unit-results/`, `android-default-unit-results/`로 분리했습니다. Playwright 전체 JSON/스크린샷은 기존 설정의 `test-results/step5/`에 갱신됩니다. 이번에 시작한 adb daemon만 장치가 없는지 다시 확인한 뒤 종료했습니다. 기존 개발 서버는 계속 실행 중입니다.

보조 무결성 검사에서 첫 `shasum`은 호스트의 지원되지 않는 `C.UTF-8` locale로 **실행 실패**했습니다. 명령 범위에만 `LC_ALL=C LANG=C`를 지정해 재실행했고 **125개 소스 해시 실행 통과**했습니다. 전역 locale은 변경하지 않았습니다. 시작 기준선 중 110개 파일은 그대로이며 이번 수정 7개·신규 8개만 manifest에 반영했습니다.

Android UI·앱 수명주기 실동작·장치 저장 실패·실제 Pleos 데이터/음성·실차는 **미실행**으로 남습니다. 자동 live 기록/SDK→서버 계약 확장, 운전자 인증, 관리자 승인·기간 마감·세무신고도 구현하지 않았습니다. 다음 실행은 환경 확보 후 위 절차의 실제 화면·원본/출처·서비스 관측부터 시작해야 합니다.
