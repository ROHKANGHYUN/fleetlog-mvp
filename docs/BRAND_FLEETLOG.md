# Fleetlog 이름 통일

작업일: 2026-11-15 KST. 사용자 요청에 따라 서비스 표시명을 **Fleetlog**, 관리자 작업공간을 **Fleetlog 비즈**로 통일했습니다. 동작·디자인·저장 계약 변경 없이 기존 브랜드 문자열을 갱신했습니다.

## 적용 범위

- 기존 웹 차량·관리자·시작/잠금 안내·HTML 제목·QA 화면·접근성 이름
- MVP 차량·운전자 모바일웹·관리자·시연 패널·음성 준비 안내
- 데모 실행 메시지, API 실행 표시명, VS Code 작업 목록
- 새 격리 데모의 가상 회사 이름: `가상 Fleetlog 주식회사`
- Android 앱 표시명 `Fleetlog · MOCK`, Compose 헤더/소개, 선택적 SDK 진단 화면 소스의 제목
- README·단계별 기록·발표 대본·관련 테스트의 표시명/selector

소개 문구는 **말 한마디로, 운행 기록은 Fleetlog.**입니다. 실행 명령은 기존 `npm run dev`, `npm run demo`, `npm run demo:mvp` 그대로이며 MVP는 실제 출력된 주소를 사용합니다.

## 데이터와 호환성

API 경로/요청·응답·헤더 `X-FleetLog-Dev`, 패키지/applicationId `io.fleetlog.demo`, 클래스명, Android 저장 형식과 파일명, 운행 ID·이벤트 ID, 기존 Web Lock과 localStorage 키는 유지했습니다. `chagok.mvp.demoEmployeeId`와 `CHAGOK_BROWSER_PATH` 등 내부 식별자는 호환성을 위해 보존합니다. 이름 변경을 이유로 DB 마이그레이션·초기화·기존 기록 수정은 하지 않았습니다.

`가상 김차곡`은 서비스명이 아닌 가상 인물 이름이므로 유지했습니다. 과거 APK의 한글 파일명·로그/임시 경로·스크린샷은 당시 산출물의 실제 위치라 그대로 남깁니다. 과거 APK에 최신 표시명이 반영됐다고 주장하지 않습니다. 새 회사명은 새로운 데모 seed에 적용하며 기존 저장된 회사/운행 데이터를 소급 변경하지 않습니다.

기존 소스 manifest 152개를 변경 비교 기준으로 사용했습니다. 읽기 전용 DB 기준 캡처는 병렬 브랜드 수정 시작 후 기록했으므로 당시 소스 차이를 사용자 변경으로 단정하지 않습니다. 원래 manifest와 각 담당 파일의 수정 내역을 함께 확인합니다.

## 이번 검증

| 항목 | 판정 | 결과 |
|---|---|---|
| `npm run check` | **실행 통과** | 웹/서버 자동 테스트232개, TypeScript 검사·Vite 빌드 통과 |
| Chrome E2E | **실행 통과** | 전체 **36/36**, 실패/skip/retry0(약2.6분). 잠금 안내의 조사 보정 후 관련 **2/2** 재검증. 기존 운행·QR·음성·수신·모바일/화면 크기·Web Lock 유지 |
| Android 기본 단위 테스트 | **실행 통과** | 기존 설치 도구의 offline 실행44개, 실패/오류/skip 0 |
| Android 기본 APK | **실행 통과** | `assembleDebug` 성공. aapt2에서 `application-label:'Fleetlog · MOCK'`, applicationId 유지 확인 |
| SDK 옵션 APK 재빌드·Android 화면 실행 | **미실행** | 이번에는 기본 APK 표시명 검증만 수행. SDK 진단 제목은 소스 변경이며 실행/연결 확인은 아님 |
| 기존 DB·프로세스 | **실행 통과** | 운행4건·영수증6건의 ID·버전·payload·ACK·시각 등 전체 행 동일. 기존 API PID49059/4000·Vite PID49060/5173 유지 및 HTTP200 |

Android 재현 명령은 설치된 JDK17·Android SDK를 현재 세션에 지정한 뒤 다음과 같습니다. 새 도구/SDK를 설치하지 않습니다.

```sh
cd apps/car-android
./gradlew :app:testDebugUnitTest :app:assembleDebug \
  --offline --no-daemon --max-workers=1 -Dorg.gradle.jvmargs=-Xmx1024m
```

Android 빌드 중 Kotlin 증분 캐시 쓰기에서 **ENOSPC** 경고가 발생했습니다. 같은 실행이 Gradle fallback 뒤 **BUILD SUCCESSFUL, 53초, exit0**으로 완료됐으며 추가 다운로드·수동 캐시 삭제·APK 복사는 하지 않았습니다. 경고가 없었던 것으로 기록하지 않습니다. 새 기본 APK는 `apps/car-android/app/build/outputs/apk/debug/app-debug.apk`, SHA256 `d5c0020006872960fbe8f134d47b9c02580a3960b09016faa5b3252783b70c4a`입니다. 빌드는 Android 화면 실행이나 Pleos 연결 성공을 뜻하지 않습니다.

최종 명령은 `npm run check`(232개·타입·빌드), `npx playwright test --trace off`(36개), 잠금 안내 문구 보정 뒤 `npx playwright test e2e/mvp.spec.mjs e2e/reliability.spec.mjs --grep 'occupied legacy writer lock|a second tab cannot' --trace off`(2개)입니다. 전체 검증 뒤 빌드는 바뀐 잠금 문구까지 반영했습니다. 주요 로그는 `check-final.log`, `e2e.log`, `lock-e2e.log`, `android.log`, `android-result.json`입니다.

기존 source152개 중 표시명 관련42개를 수정하고 본 완료 문서를 추가해 manifest153개로 갱신했습니다. package/lock·도메인·API 처리/스키마·빌드 설정·실행 명령 정의는 시작 manifest와 동일합니다. 소스에 남은 예전 표기는 호환성 식별자·가상 인물·과거 산출물 경로뿐입니다.

검증 로그·데이터 비교는 ignore 대상 `test-results/brand-fleetlog/`에 있습니다. 실제 로그인·실제 STT·Pleos·실차·세무신고의 구현/검증 범위는 이전과 동일합니다.
