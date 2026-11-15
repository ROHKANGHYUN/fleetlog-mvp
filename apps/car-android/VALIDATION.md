# Android 개발 기준선 점검

> 이 문서는 1단계의 과거 환경·실패 기록입니다. 6단계에서 SDK 설치·JUnit·APK/선택적 SDK 코드 컴파일까지 통과했으며 최신 결과는 [STEP6_ANDROID_PLEOS.md](../../docs/STEP6_ANDROID_PLEOS.md)를 확인하세요. 에뮬레이터·실제 서비스 실행은 여전히 미검증입니다.

검증일: 2026-11-15 KST. 범위: 기존 Kotlin·Compose mock 앱의 파일 완전성, 로컬 도구와 빌드 진입 여부. 실제 Pleos SDK를 추가하거나 API·단위·권한을 추정하지 않았습니다.

## 확인한 도구

| 항목 | 확인 결과 |
|---|---|
| OS / Python | macOS arm64 / Python 3.12.5 |
| 기본 Java | Zulu 21.0.8, `JAVA_HOME` 미설정 |
| 사용 가능한 JDK 17 | Homebrew OpenJDK 17.0.15. `/usr/libexec/java_home -v 17`로 선택 가능 |
| Gradle | 시작 시 8.10.2 없음. 공식 배포본과 SHA-256을 검증해 `.bootstrap/gradle-8.10.2`에 설치 |
| SDK | 기본 SDK 디렉터리에 설치 흔적만 있음. `platforms/android-35/android.jar`, `build-tools/35.0.0` 없음 |
| 실행/설치 도구 | `adb`, `sdkmanager`, `avdmanager`, `emulator` 실행파일 없음. 등록된 AVD 없음 |
| Android Studio | 기본 `/Applications/Android Studio.app` 경로에 없음 |
| 디스크 | 온라인 Gradle 의존성 다운로드 중 `No space left on device`. 직후 `df -h`에서 사용률 100%, 가용 약 126 MiB 확인 |

프로젝트 설정은 **compileSdk/targetSdk 35, build-tools 35.0.0, minSdk 28**입니다. SDK/AVD 설치나 라이선스 동의는 수행하지 않았습니다. Gradle 바이너리는 ignore 대상이며 소스 배포물에 포함하지 않습니다.

## 수정 내용

현재 사본에는 ViewModel이 참조하는 다음 두 파일이 실제로 누락되어 있었습니다.

- `app/src/main/java/io/fleetlog/demo/data/TripRepository.kt`
- `app/src/main/java/io/fleetlog/demo/data/DevSyncClient.kt`

이전 로컬 스타터(`2026-11-13/new-chat/fleetlog-starter`)에서 원본을 찾았습니다. 해당 원본의 `Models.kt`와 `FleetLogViewModel.kt`가 현재 사본과 바이트 단위로 같은지 확인한 후, 누락된 두 파일만 내용 변경 없이 복구했습니다. 로컬 저장 형식 2, 기존 파일명 `fleetlog-demo-v1.json`, revision 1 전송 계약과 ACK 검증을 유지했습니다. 기존 데이터를 삭제하거나 마이그레이션하지 않았습니다.

복구 파일 SHA-256:

```text
693672fd53579c6a41522f21e5c39d393af278a259585302104b9478431341f7  TripRepository.kt
ecf7fb76a8c6bc3973a2ce23d2b32942dd1d73539cd603ad842962d842476bbf  DevSyncClient.kt
```

## 실행 결과

1. `python3 scripts/check-environment.py`: 기본 Java 21 선택, SDK 환경변수 미설정, Gradle 누락으로 실패했습니다.
2. JDK 17과 기존 SDK 경로를 지정한 점검: JDK는 통과했고 SDK 35, build-tools 35.0.0, Gradle 누락을 확인했습니다.
3. `python3 scripts/bootstrap-gradle.py`: 이 PC의 Python 인증서 설정 때문에 `CERTIFICATE_VERIFY_FAILED`로 실패했습니다. macOS 시스템 CA 파일을 지정해 아래 명령으로 다시 실행한 결과 공식 배포본/체크섬 검증과 설치에 성공했습니다. TLS 검증을 해제하지 않았습니다.

   ```sh
   SSL_CERT_FILE=/etc/ssl/cert.pem python3 scripts/bootstrap-gradle.py
   ```

4. Gradle 설치 후 환경 점검: SDK 35와 build-tools 35.0.0 누락으로 실패했습니다.
5. `:app:testDebugUnitTest :app:assembleDebug` 진입을 시도했습니다. SDK 자동 다운로드를 차단한 `--offline` 시도는 루트 `:classpath` 의존성 캐시 미완성으로 실패했습니다.
6. 이어서 아래와 같이 온라인으로 시도했으나 `kotlin-compiler-embeddable-2.0.0.jar` 다운로드 중 **`java.io.IOException: No space left on device`**로 루트 프로젝트 구성 단계에서 실패했습니다. 테스트나 Kotlin 컴파일 태스크는 실행되지 않았고 APK도 생성되지 않았습니다. 디스크 공간 부족을 해결한 후 다시 실행해야 합니다.

   ```sh
   JAVA_HOME="$(/usr/libexec/java_home -v 17)" \
   ANDROID_HOME="$HOME/Library/Android/sdk" \
   ./gradlew :app:testDebugUnitTest :app:assembleDebug -Pandroid.builder.sdkDownload=false --console=plain
   ```

추가 다운로드는 중단했습니다. 이번 작업에서 시작한 Gradle 8.10.2 데몬을 종료하고, 생성 시각과 해당 빌드 실행 구간이 일치하는 미완료 다운로드 4개(약 12 MiB)만 정리했습니다. 검증된 Gradle 설치본은 유지했고, 기존 캐시·사용자 데이터는 삭제하지 않았습니다.

Python 3개 파일의 AST 파싱, Android XML 3개 파싱, `sh -n gradlew`, 복구 후 내부 명시 import 7개가 실제 선언을 가리키는 것은 확인했습니다. 정적 검사는 Kotlin 컴파일, JUnit, APK 생성이나 Android 런타임 검증이 아닙니다.

## 다음 실행의 선행 조건

1. 먼저 로컬 디스크 공간을 확보합니다. 이번 작업은 기존 사용자 데이터나 다른 프로젝트의 캐시를 삭제하지 않았습니다. SDK, 빌드 의존성 및 시스템 이미지 설치에 필요한 여유를 확보한 뒤 SDK Manager에서 `platforms;android-35`, `build-tools;35.0.0`, `platform-tools`를 설치하고 필요한 SDK 라이선스를 확인합니다.
2. JDK 17과 SDK 경로를 지정합니다. macOS의 예시는 다음과 같으며 다른 OS에서는 해당 설치 경로를 사용합니다.

   ```sh
   export JAVA_HOME="$(/usr/libexec/java_home -v 17)"
   export ANDROID_HOME="$HOME/Library/Android/sdk"
   python3 scripts/check-environment.py
   ./gradlew :app:testDebugUnitTest :app:assembleDebug -Pandroid.builder.sdkDownload=false
   ```

3. 첫 빌드에는 Google Maven, Maven Central, Gradle Plugin Portal 접근과 의존성 다운로드가 필요합니다. 빌드 성공 후 `app/build/outputs/apk/debug/app-debug.apk` 존재 및 JUnit 결과를 확인합니다.
4. mock 화면 검증에는 API 28 이상 Android 시스템 이미지와 실행 가능한 AVD가 필요합니다. `./gradlew :app:installDebug` 후 README의 주차 확인→수집→모의 운행→저장→전송을 실제 조작합니다.
5. 루트의 로컬 API를 4000번 포트에서 실행하고, 에뮬레이터의 `10.0.2.2:4000` HTTP 요청/ACK와 관리자 조회를 함께 확인합니다. Android는 미확정 기록의 생성·전송까지만 구현되어 있으며 목적 보완 리비전은 별도 후속 기능입니다.
6. 실제 Pleos 검증은 위 mock 검증과 별개입니다. [PLEOS_INTEGRATION.md](PLEOS_INTEGRATION.md)의 공식 문서·권한·단위·수명주기·실패 정책 확인 후 진행합니다.
