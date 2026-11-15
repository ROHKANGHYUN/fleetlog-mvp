# 6단계 · Pleos SDK 접근과 공식 근거

조사일: **2026-11-15 KST**. 공개 공식 문서와 공식 Maven 배포 파일을 읽어 확인한 기록입니다. 팀 계정에 로그인하거나 프로젝트 생성·권한 신청·자격 정보 입력을 하지 않았습니다. 배포 파일을 받을 수 있다는 사실과 실제 서비스 연결·기능 지원·유효 데이터 수신은 별개입니다. 실제 빌드/실행 결과는 [STEP6_ANDROID_PLEOS.md](STEP6_ANDROID_PLEOS.md)에 기록합니다.

## 확인 범위와 상태

| 대상 | 공개 자료·배포에서 확인 | 이번 환경에서 확인하지 못한 항목 |
|---|---|---|
| Vehicle State | 프로젝트 안내상 요청 없이 사용할 수 있는 분류. 공식 Vehicle 2.3.2의 POM/AAR/sources를 익명 HTTP 200으로 조회 | 팀 프로젝트 설정, 대상 Vehicle Service의 설치·연결·capability·실제 값 |
| 누적거리 | 공식 sources의 `Odometer` 선언·권한·문서 단위 확인 | 전용 AVD/실차의 실제 응답 단위·정밀도·갱신 주기·값 |
| STT/TTS | 공식 3.3.1 안내와 Maven AAR HTTP 200 확인 | 프로젝트 안내의 사용 가능 상태와 팀 계정 상태 대조, Speech Service·엔진·서비스 권한·서버 등록 |
| AAOS 차량 상태 | 표준 CarPropertyManager 경로와 지원/값 상태 검증 규칙 확인 | 이 환경의 speed/gear 지원·권한·신선한 실제 값 |
| CarUxRestrictions | 표준 manager의 현재 제한 조회·리스너 등록/해제 경로 확인 | 플랫폼 서비스 연결·실제 제한 상태 통지 |
| Pleos Emulator | 공개 설치 안내와 전용 이미지 배포 경로 확인 | 전용 AVD 실행 및 해당 Service 버전 |

공개 [프로젝트·SDK 접근 안내](https://document.pleos.ai/en/docs/pleos-only/create-my-project)는 Vehicle State/NaviHelper를 바로 사용할 수 있는 분류로, STT/TTS 등을 아직 요청할 수 없는 분류로 설명합니다. 반면 음성 API 문서·배포 파일은 공개돼 있습니다. 이 차이를 계정 승인이 완료됐다는 근거로 해석하지 않습니다. 팀 Workspace의 실제 SDK 상세 상태는 **미확인**입니다. 서버 기반 음성은 프로젝트에서 발급된 자격 정보가 필요하다는 안내도 있습니다.

## 공식 버전과 빌드 호환 기준

[Vehicle 샘플 가이드](https://document.pleos.ai/en/docs/pleos-only/tutorial/vehicle-sdk-sample-app)의 기준은 Vehicle SDK **2.3.2**, Vehicle Service **2.3.22**, Pleos_Connect_v2.1 Android 14입니다. JDK17·Gradle8.10.2·AGP8.8.2·Kotlin2.0.0·compile/target35를 명시합니다. 현재 프로젝트의 고정 버전과 일치하며, 샘플 minSdk23과 Fleetlog minSdk28은 다릅니다. 버전 표시만으로 서비스 호환 또는 개별 기능 지원을 보증하지 않습니다.

[Vehicle SDK 추가 가이드](https://document.pleos.ai/en/docs/pleos-only/connect-sdk-pleos/Vehicle/project-setup)에서 확인한 공식 Maven은 `https://nexus-playground.pleos.ai/repository/maven-releases/`, 좌표는 `ai.pleos.playground:Vehicle:2.3.2`입니다. 임의 좌표가 아닙니다.

실제 조회한 배포 파일:

- [Vehicle POM](https://nexus-playground.pleos.ai/repository/maven-releases/ai/pleos/playground/Vehicle/2.3.2/Vehicle-2.3.2.pom): HTTP 200. Vehicle 2.3.2, vehicle-aidl 1.1.1, vehicle-data 1.1.11 등의 배포 의존성을 확인했습니다.
- [Vehicle AAR](https://nexus-playground.pleos.ai/repository/maven-releases/ai/pleos/playground/Vehicle/2.3.2/Vehicle-2.3.2.aar): HTTP 200, 983,759 bytes. 다운로드 SHA-256 `e11fdfe498cad3ecc0d5a2a6992b0c4a4d135195f1455018127bc069fd5ef937`.
- [공식 sources JAR](https://nexus-playground.pleos.ai/repository/maven-releases/ai/pleos/playground/Vehicle/2.3.2/Vehicle-2.3.2-sources.jar): HTTP 200, 145,042 bytes. 아래 타입·단위·권한을 이 버전의 선언에서 확인했습니다.

초기 로컬 점검에서 프로젝트의 제공 AAR/JAR나 Pleos Gradle 캐시 그룹은 발견하지 못했습니다. 이번에 읽은 배포 파일은 ignore 대상 `test-results/step6/sdk-audit/`에만 두며 소스 배포물에 넣지 않습니다. Python urllib의 인증서 검증 오류는 macOS curl의 정상 TLS 검증 경로로 재확인했습니다. 인증서 검증을 해제하지 않았습니다.

## 누적거리: 확인한 선언과 미확인 값

공식 sources의 `ai/pleos/playground/vehicle/api/Odometer.kt`는 다음 의미를 명시합니다. 공개 [누적거리 API 페이지](https://document.pleos.ai/en/docs/pleos-only/connect-sdk-pleos/Vehicle/vehicle/ai.pleos.playground.vehicle.api/odometer/get-current-distance-driven)는 조사 시 제목·목차만 보여 줘 세부 타입과 단위 확인 근거로 사용하지 않았습니다.

| 항목 | Vehicle 2.3.2 sources에서 확인 |
|---|---|
| capability | `checkCurrentDistanceDrivenCapabilities`의 성공 결과는 `CapabilityConfig` |
| read | `getCurrentDistanceDriven` 성공 결과는 nullable Float, 문서 단위 **km** |
| update | `registerDistanceDriven`에 `DistanceDrivenListener`를 전달. `onDistanceDrivenUpdated`는 nullable Float, 이 등록 경로의 단위는 **km** |
| unavailable/error | null은 값 미수신, 실패 콜백은 Exception. 0으로 대체하면 안 됨 |
| permission | 해당 메서드의 `@RequiresPermission`: `PleosPermission.CAR_DRIVE`, manifest 값 `pleos.car.permission.CAR_DRIVE` |
| cleanup | 등록했던 동일 listener로 `unregisterDistanceDriven`, 소유자 종료 시 Vehicle release |

이 누적거리 경로와 같은 listener 타입을 사용하는 **trip 거리 API 일부는 m**로 설명돼 있습니다. listener 타입 이름만으로 단위를 일반화할 수 없습니다. mock의 정수 m를 SDK 원본 단위로 가정하지 않습니다. 실제 수신 증거는 없으므로 실차 단위 검증이 완료됐다고 표시하지 않습니다.

선택적 진단 코드의 `PleosDistance`는 Float의 십진 문자열을 BigDecimal로 해석해 km×1000 후 1m 단위 HALF_UP 반올림을 사용합니다. null·NaN·무한·음수·Long 범위 초과를 거부합니다. 원본 Float·원본 단위 km·앱 관측 시각을 별도로 유지하며 Float 원본에서 이미 잃은 정밀도를 복원한다고 주장하지 않습니다. Kotlin 테스트 소스를 추가했고 실제 실행 판정은 메인 6단계 기록을 따릅니다. 원천 timestamp가 API에서 제공되지 않으므로 앱 관측 시각을 센서 원천 시각이라고 부르지 않습니다. 위치 기반 거리로 대체하거나 null을 0으로 바꾸지 않습니다.

## 초기화와 서비스 연결의 구분

공식 `Vehicle.kt`의 진입점은 Context를 받는 Vehicle 객체, `initialize()`, `getOdometer()`, `release()`입니다. initialize는 내부 연결을 요청하지만 공개 Vehicle API에 앱용 서비스 연결 완료 콜백은 확인되지 않았습니다. 따라서 ‘initialize가 예외 없이 반환됨’을 서비스 연결 완료나 최초 데이터 수신으로 표시하면 안 됩니다.

`CapabilityConfig.accessType`의 선언 값은 NONE/READ/WRITE/READ_WRITE입니다. read 지원 확인, 실제 read 성공, null 아닌 유효 값 수신을 각각 구분해야 합니다. 실제 기능 응답이 왔을 때만 해당 기능의 서비스 통신 근거가 됩니다. 리스너 등록 메서드가 반환됐다는 사실도 업데이트 수신과 다릅니다. 이 구분은 [공식 샘플의 상태 설명](https://document.pleos.ai/en/docs/pleos-only/tutorial/vehicle-sdk-sample-app)에 부합합니다.

`src/pleos/java/.../PleosOdometerProbe.kt`는 이 선언을 사용하는 선택적 **읽기 전용 진단** 코드입니다. 대상은 생성자에서 Pleos emulator/실차 중 명시적으로 지정하며, 기록 reducer·Outbox·서버 전송과 연결하지 않습니다. 초기화 호출 반환·capability 응답·최초 값 수신을 구분하고, null·역전·오래된 값은 진단 값 사용을 중지합니다. timeout 10초/신선도 15초는 앱의 보수적 진단 정책이며 SDK 갱신 주기 보장이 아닙니다. 종료/재시작은 토큰을 먼저 무효화한 뒤 같은 listener 해제와 Vehicle release를 요청합니다. 이 코드는 기본 mock 모드에서 자동으로 실행하지 않으며 실제 서비스 연결 성공으로 보고하지 않습니다.

선택적 SDK 빌드의 `PleosProbeActivity`는 명시적 테스트 진입점입니다. `environment` extra가 없거나 잘못되면 SDK를 호출하지 않습니다. onStart에서 진단을 시작하고 onStop에서 구독·연결·타이머를 정리하며, 이전 화면의 늦은 UI 갱신도 무시합니다. 파일 저장·인증 정보·서버 업로드 기능은 없습니다. 빌드/실행 가능 여부는 메인 6단계 결과를 따르며, 아래 명령 자체는 실제 서비스 수신 성공 증거가 아닙니다.

```sh
# -PpleosSdk=true로 빌드한 선택적 진단 APK를 별도 테스트 장치에 준비한 뒤
adb shell am start -n io.fleetlog.demo/io.fleetlog.demo.platform.PleosProbeActivity \
  --es environment PLEOS_EMULATOR
```

실차 테스트에서는 실제 대상·권한·주차를 검증한 담당자만 `REAL_VEHICLE`을 지정합니다. extra는 사람이 지정한 테스트 대상 표시이며 SDK가 실제 환경을 인증한 것으로 해석하지 않습니다. 이 진단 경로를 기존 mock 데이터에 혼합하지 않습니다.

## 차량 상태와 플랫폼 주행 제한

표준 [CarPropertyManager](https://developer.android.com/reference/android/car/hardware/property/CarPropertyManager)는 지원 목록/설정, 현재 가용 상태, 이벤트의 STATUS_AVAILABLE 등을 확인하는 경로를 제공합니다. 대상 환경의 API 수준·권한·실제 property 지원을 검증한 뒤 사용해야 합니다. 속도 0만으로 Fleetlog의 주차·입력 가능 상태를 확정하지 않습니다.

[Pleos 주행 제한 가이드](https://document.pleos.ai/en/docs/pleos-only/vehicle-app-developer-guide/driving-restriction-development-guide)는 플랫폼 CarUxRestrictions의 현재 제한과 변경 통지를 반영하도록 안내합니다. 표준 [CarUxRestrictionsManager](https://developer.android.com/reference/android/car/drivingstate/CarUxRestrictionsManager)는 `getCurrentCarUxRestrictions`, `registerListener`, `unregisterListener`를 제공합니다. 이미 등록된 listener는 재등록 전에 해제해야 합니다.

[CarUxRestrictions](https://developer.android.com/reference/android/car/drivingstate/CarUxRestrictions)의 DO 필요 여부와 active flags를 함께 반영하며, OEM/지역에 따른 제한을 고정 속도 판정으로 대체하지 않습니다. 제한 미수신·연결 해제·오래된 상태에서는 UNKNOWN으로 입력을 막아야 합니다. 현재 mock의 주차·UX 상태 시험은 실제 플랫폼 통지 검증이 아닙니다.

선택적 `CarUxRestrictionProbe.kt`는 [공식 Car 진입점](https://developer.android.com/reference/android/car/Car)과 설치된 SDK35의 `optional/android.car.jar`에서 javap로 대조한 타입을 사용합니다. 무기한 대기 대신 비동기 lifecycle 경로로 연결하고, ready=true 이후 manager를 얻어 현재 값을 읽고 listener를 등록합니다. 연결 해제·재연결 시 이전 구독 콜백은 무시하고 같은 manager의 등록을 정리합니다. 실제 제한이 수신돼도 **주차 상태는 UNKNOWN으로 유지**하므로 이 진단만으로 입력을 허용하지 않습니다. 30초 신선도 제한은 앱 정책이며, 변경 없는 UX 상태는 주기 통지가 보장되지 않아 명시적 재조회 경로도 제공합니다. 이 코드의 타입 확인/빌드와 실제 플랫폼 통지 검증을 구분합니다.

## 음성 SDK

공식 [STT import](https://document.pleos.ai/en/docs/pleos-only/connect-sdk-pleos/SpeechToText/importing-sdk), [TTS import](https://document.pleos.ai/en/docs/pleos-only/connect-sdk-pleos/TextToSpeech/importing-sdk)의 좌표는 각각 `ai.pleos.playground:SpeechToText:3.3.1`, `ai.pleos.playground:TextToSpeech:3.3.1`입니다. AAR HEAD 조회는 각각 HTTP200(188,560 / 139,133 bytes)이었습니다. 파일 배포가 실제 서비스 사용 가능성을 뜻하지 않습니다.

[STT 안내](https://document.pleos.ai/en/docs/pleos-only/connect-sdk-pleos/SpeechToText/intro)와 [앱 등록](https://document.pleos.ai/en/docs/pleos-only/connect-sdk-pleos/SpeechToText/app-registration)은 서버 사용 모드와 ON_DEVICE 모드를 구분합니다. SERVER/HYBRID의 서버 경로는 SDK 초기화 후 프로젝트 Client ID/Secret 등록과 연결 콜백 확인이 필요합니다. ON_DEVICE 전용은 등록이 불필요하다고 안내하지만 Pleos Speech Service·대상 엔진 가용성은 여전히 필요합니다. 자격 정보는 확인하거나 출력하지 않았습니다.

[STT 권한](https://document.pleos.ai/en/docs/pleos-only/connect-sdk-pleos/SpeechToText/declaring-permissions), [TTS 권한](https://document.pleos.ai/en/docs/pleos-only/connect-sdk-pleos/TextToSpeech/declaring-permissions)의 서비스 권한을 해당 SDK 선언·런타임에서 대조해야 합니다. 실제 음성 연결 전에는 안내 완료·인식 시작·중간/최종 결과·오디오 포커스·취소·자원 해제를 공식 가이드대로 검증합니다. 이 조사는 실제 안내 재생이나 음성 인식 성공을 포함하지 않습니다. 현재 팀의 권한/서비스/대상 환경이 확인되지 않은 실제 음성 경로는 disabled로 유지하는 것이 정확합니다.

## 다음 연결의 선행 조건

1. 팀 Workspace에서 실제 프로젝트·SDK별 상태·필요한 서버 음성 등록 권한을 확인합니다. 공개 안내와 다른 상태면 근거를 별도로 남깁니다. 비밀값은 저장소·로그·문서에 넣지 않습니다.
2. [공식 Pleos Emulator 설치 안내](https://document.pleos.ai/en/docs/connect/guide/getting-started/application-development/setup-connect-sdk-emulator)의 Mac arm64 전용 API34 이미지와 대상 Service 버전을 준비합니다. 일반 Android phone 이미지의 mock 실행을 Pleos 서비스 검증으로 바꾸어 표현하지 않습니다.
3. SDK 초기화 호출·기능 통신·capability/read access·최초 유효 값·업데이트를 단계별로 기록합니다. 지원 불가/권한 오류/미수신/연결 끊김은 구별합니다.
4. 실제 SDK 데이터 출처는 mock과 혼합하지 않고, Pleos emulator와 실차도 구분합니다. 기존 서버는 source=mock만 수용하므로 진단용 SDK 값을 mock payload로 전송하면 안 됩니다. 실제 수신 경로가 준비되기 전에는 계약 확장 없이 전송을 차단합니다.
5. APK의 실제 typed probe 구현·빌드 여부와 에뮬레이터·실차 실행 결과는 메인 6단계 문서에 별도 판정합니다. 이 문서는 공개 근거·배포 가용성 감사이며 런타임 연결 성공 증거가 아닙니다.

## 구현과 컴파일 확인

- **실행 통과:** 기본 Android JUnit에서 `PleosDistanceTest` 2개, 실패/skip 0을 XML 결과로 확인했습니다. 단위 변환의 정상·반올림·미수신·비유한·음수·범위 초과를 검사합니다.
- **실행 통과:** 선택적 `-PpleosSdk=true` 빌드의 testDebugUnitTest/assembleDebug가 성공했고, 실제 Vehicle 2.3.2·SDK35 android.car 클래스에 대해 Odometer/CarUx probe와 진단 Activity의 Kotlin 클래스가 생성됐습니다. 근거는 ignore 대상 `test-results/step6/pleos-build.log`입니다.
- **미실행:** 이 진단 Activity를 전용 Pleos AVD/실차에서 실행해 서비스 연결·capability·유효 누적거리·플랫폼 제한을 받은 검증. 컴파일 통과를 이 결과로 대체하지 않습니다.
