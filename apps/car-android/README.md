# Fleetlog Android · MOCK 앱과 선택적 Pleos 진단

Kotlin·Compose 차량 프로토타입입니다. 웹 시뮬레이터와 별도 클라이언트이며 applicationId는 기존 **`io.fleetlog.demo`**를 유지합니다. 기본 실행은 **APP_MOCK**입니다. 실제 차량·운전자 인증, 실차 수집, 실제 음성은 연결하지 않았습니다.

2026-11-15 6단계에서 **Android JUnit 44개·debug APK 빌드·Kotlin→실제 임시 HTTP/SQLite→관리자 조회 계약 테스트**를 통과했습니다. **에뮬레이터 설치/화면 실행은 미실행**입니다. 연결 장치/AVD가 없고 여유 디스크가 공식 이미지의 압축 크기보다 작습니다. 실제 Pleos 서비스 초기화·유효 값 수신도 미실행이며, SDK를 포함한 선택적 진단 APK의 컴파일만 통과했습니다. 자세한 판정은 [6단계 기록](../../docs/STEP6_ANDROID_PLEOS.md)에 있습니다.

후속 점검에서는 SDK 호환 오류 발생 시 정리 누락을 수정하고 선택적 probe의 JVM 회귀 테스트 5개를 추가했습니다. 기본 44개와 SDK 옵션 49개를 구분하며, 새 환경 진단·실행 차단 원인과 최신 결과는 [STEP6_RUNTIME.md](../../docs/STEP6_RUNTIME.md)에 있습니다. 실제 장치 실행·서비스 수신은 여전히 미실행입니다.

## 실행 환경 점검

```sh
# 이 디렉터리에서: 설치·삭제·adb 호출 없이 읽기 전용 점검
JAVA_HOME="$(/usr/libexec/java_home -v 17)" \
ANDROID_HOME="$HOME/Library/Android/sdk" python3 scripts/check-runtime.py
# 선택적 목록/공식 다운로드 메타데이터 조회. adb daemon이 시작될 수 있습니다.
JAVA_HOME="$(/usr/libexec/java_home -v 17)" \
ANDROID_HOME="$HOME/Library/Android/sdk" python3 scripts/check-runtime.py --probe-adb --metadata
```

실제 테스트 serial을 알고 있을 때만 `--probe-adb --serial SERIAL`을 지정합니다. 개인용 장치를 자동 선택하지 않습니다. 빌드 사전조건, AVD 등록, 명시적 장치 선택, 실제 Pleos 서비스 확인은 별도 상태입니다. ZIP 크기는 공식 메타데이터의 논리 크기이며 AVD userdata/cache/snapshot과 물리 할당량까지 보증하지 않습니다.

## 빌드

고정 버전: JDK17, Gradle8.10.2, AGP8.8.2, Kotlin/Compose compiler2.0.0, compile/target35, min28, Compose BOM2024.12.01. [공식 SDK 샘플](https://document.pleos.ai/en/docs/pleos-only/tutorial/vehicle-sdk-sample-app)의 기준과 대조했습니다.

```sh
# 이 디렉터리에서 실행. JAVA_HOME/ANDROID_HOME은 본인 설치 경로를 사용합니다.
JAVA_HOME="$(/usr/libexec/java_home -v 17)" \
ANDROID_HOME="$HOME/Library/Android/sdk" \
./gradlew :app:testDebugUnitTest :app:assembleDebug --no-daemon --max-workers=2
```

현재 PC에서는 JDK17, Android SDK35·build-tools35.0.0·platform-tools37.0.1과 기존 라이선스를 확인했습니다. 누락 SDK는 이번 Gradle 실행에서 공식 배포 경로로 설치했습니다. 다른 환경에서는 공식 SDK Manager로 준비하고 라이선스 상태를 확인하세요.

`gradlew`는 공식 wrapper가 아닌 **Python 실행기**입니다. 설치된 JDK17과 정확히 Gradle8.10.2인지 확인한 뒤 실행합니다. Gradle이 없으면 `python3 scripts/bootstrap-gradle.py`로 공식 배포본과 SHA-256을 검증해 `.bootstrap/`에 준비합니다. 이번에는 기존 검증 설치본을 사용했으며 wrapper 바이너리를 임의로 만들지 않았습니다.

- 기본 APK: `app/build/outputs/apk/debug/app-debug.apk`
- JUnit 결과: `app/build/test-results/testDebugUnitTest/`
- APK·SDK·Gradle·SQLite·서명 키·실행 로그는 Git/소스 manifest에 포함하지 않습니다.

## 격리된 mock 실행 순서

기존 기기 앱을 삭제하거나 재설치하지 않습니다. 새 테스트 AVD와 사용자 데이터에서만 설치·실행하세요. 일반 Android AVD의 mock 성공은 Pleos 성공이 아닙니다.

1. 루트에서 `npm run build` 후 **새 임시 DB와 테스트 포트**의 서버를 시작합니다.

   ```sh
   FLEETLOG_DB_PATH="$(mktemp -d)/android-test.sqlite" PORT=4306 npm start
   ```

2. 이 Android 폴더에서 테스트 에뮬레이터만 대상으로 APK를 설치합니다. 실제 장치/기존 사용자 프로필에 적용하지 않습니다.

   ```sh
   adb -s emulator-TEST install app/build/outputs/apk/debug/app-debug.apk
   adb -s emulator-TEST shell am start -n io.fleetlog.demo/.MainActivity \
     --es mockApiEndpoint http://10.0.2.2:4306/api/trip-events
   ```

   `emulator-TEST`는 새 테스트 AVD의 실제 serial로 바꾸세요. 이 명령은 이번 환경에서 실행한 것으로 보고하지 않습니다. 서버는 127.0.0.1 바인딩을 유지합니다. 에뮬레이터의 10.0.2.2는 호스트 loopback 경로이며, 실기기의 동일 주소 사용을 보장하지 않습니다.

3. 개발용 제어에서 MOCK 주차·UX 상태 확인 → 운행 기록 시작 → MOCK 운행 시작 → 23.4km 이동 → MOCK 주차 → 운행 마치기 → 용도 또는 모의 음성 → 요약 → 저장합니다.
4. 음성은 MOCK 안내 완료 이벤트를 누른 뒤 인식을 시작합니다. 중간 결과는 미리보기이며 최종 결과도 수정 가능한 초안입니다. 실제 마이크·TTS 소리·STT·원음 파일은 사용하지 않습니다.
5. 개발 서버로 전송 후 `http://127.0.0.1:4306`의 Fleetlog 비즈에서 조회합니다. 미확정 전송→차량에서 용도 보완→재전송 시 같은 tripId의 최신 리비전이며 거리·시각·quality는 유지됩니다.
6. UNKNOWN/UX 제한/30초 이상 오래된 상태에서는 입력을 막습니다. 앱 이탈/재실행은 수집을 중지하고 관측된 미완료 구간을 미확정/gap으로 보존합니다. 재시작·주차/제한 확인은 직접 해야 합니다.

수집 세션 종료와 한 운행 마치기는 별도입니다. 초안·종료 후보는 재출발/제한 전환에 취소됩니다. 상태 만료 30초·음성 제한 15초는 **mock 실험 정책**이며 SDK 갱신 주기·공식 UX 인증 기준이 아닙니다.

## 저장과 동기화

기존 앱 내부 파일명 **`fleetlog-demo-v1.json`**과 Android AtomicFile을 유지합니다. 로컬 형식 **v2→v3** 마이그레이션은 기존 tripId/eventId·원본 시각/거리/품질·synced 상태를 보존하며, 최초 load에서 파일을 바꾸지 않습니다. 전체 복구 상태의 AtomicFile 저장에 성공한 뒤 v3가 됩니다. 손상/지원하지 않는 데이터는 자동 삭제·초기화하지 않습니다.

v3는 리비전·Outbox·영수증·입력 상태를 한 스냅샷으로 저장합니다. 준비된 요청 본문 문자열을 전송 전에 저장하고 재시도 시 그대로 사용합니다. 후행 변경은 선행 ACK 이후 expectedServerVersion을 준비합니다. ACK 로컬 반영에 실패하면 미완료로 남고 같은 이벤트로 복구합니다. 409/conflict와 확인이 필요한 4xx/blocked는 해당 운행의 후행 변경을 보류하며 다른 운행은 진행할 수 있습니다. 자동 재시도·강제 덮어쓰기·충돌 자동 해결은 없습니다.

`OutboxSynchronizer`는 실제 ViewModel과 Kotlin 실패 주입 테스트가 공유합니다. 저장 mutex는 HTTP 중 해제하며, 완료는 최신 스냅샷에 다시 적용합니다. 로컬 저장 성공·ACK·관리자 승인·마감·세무신고는 별개입니다.

## 선택적 공식 Vehicle SDK 진단

```sh
./gradlew :app:testDebugUnitTest :app:assembleDebug -PpleosSdk=true
```

JDK17·ANDROID_HOME 설정은 기본 빌드와 같습니다. 명시적으로 선택했을 때만 공식 저장소의 `ai.pleos.playground:Vehicle:2.3.2`와 `src/pleos/` 코드를 포함합니다. 기본 MainActivity는 계속 MOCK이며 SDK 값으로 수집을 시작하지 않습니다.

전용 Pleos 테스트 환경에서 진단 대상 extra를 명시해 실행합니다.

```sh
adb -s emulator-TEST shell am start \
  -n io.fleetlog.demo/io.fleetlog.demo.platform.PleosProbeActivity \
  --es environment PLEOS_EMULATOR
```

실차 대상은 검증된 별도 환경에서만 `REAL_VEHICLE`을 명시합니다. 이 값은 사용자 설정일 뿐 장치·차량 인증이 아닙니다. 대상이 없으면 probe를 호출하지 않습니다. 초기화 반환·capability 응답·최초 값 수신을 구분하고 실패·null·오래된 값에 mock을 대입하지 않습니다. 실제 parking은 UNKNOWN으로 유지하므로 UX 제한 해제만으로 입력을 허용하지 않습니다.

공식 sources에서 누적거리 nullable Float **km**를 확인했으나 실제 SDK 응답은 미수신입니다. 원본 Float km와 앱 수신 시각을 별도로 보유하며 1m HALF_UP 변환 정책만 단위 테스트했습니다. 이 진단 값은 파일·Outbox·기존 mock 서버로 전송하지 않습니다. STT/TTS는 배포 파일과 서비스 사용 가능 상태가 다를 수 있어 팀 권한·서비스 확인 전 disabled입니다.

[공식 SDK 접근·타입·권한 근거](../../docs/STEP6_SDK_ACCESS.md), [6단계 전체 결과](../../docs/STEP6_ANDROID_PLEOS.md), [이전 1단계 이력](VALIDATION.md)을 확인하세요.
