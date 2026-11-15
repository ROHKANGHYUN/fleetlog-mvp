# Fleetlog · 다음 작업 인수인계 진입점

현재 완성 범위·전체 시연·실행 검증·데이터 보존·제한·GitHub 공유 준비는 **[MVP_FINAL_HANDOFF.md](MVP_FINAL_HANDOFF.md)** 한 곳을 기준으로 합니다. 먼저 [AGENTS.md](../AGENTS.md)와 [README.md](../README.md)를 읽으세요.

공개 저장소는 **[ROHKANGHYUN/fleetlog-mvp](https://github.com/ROHKANGHYUN/fleetlog-mvp)**이며 기본 브랜치는 `main`입니다. 2026-11-15에 사용자 공개 승인 후 공유 대상 162개 파일을 게시했습니다. 서비스 표시명은 **Fleetlog**, 관리자 화면은 **Fleetlog 비즈**입니다. 새 라이선스는 추가하지 않았습니다. 게시 시 원본 로컬 프로젝트의 Git 초기화·remote 설정은 수행하지 않았으므로, 후속 작업은 이 저장소를 clone하거나 현재 작업 트리와 원격을 먼저 확인하세요. 상위 디렉터리 저장소를 프로젝트로 오인하지 마세요.

MVP 실행은 `npm run demo:mvp`이며 기존 `npm run dev`·`npm run demo`와 별도 임시 DB/포트를 사용합니다. 기존 개발 DB·브라우저/Android 저장소를 초기화하거나 사용자 서버를 종료하지 않습니다. 원본 운행·준비 이벤트·최초 ACK와 목적 보완·월별 자료·모의 접수는 별도 상태입니다.

단계 문서는 과거 구현/검증 이력입니다. 과거 232개/36개, APK 빌드 결과를 최신 전체 검증이나 Android/Pleos 실행 성공으로 재사용하지 않습니다. 실제 인증·STT·카드/회계·Pleos/실차·신고/납부·운영 배포는 구현하지 않았습니다. 후속 실차 작업은 권한·서비스·단위·수명주기 확인부터 시작해야 합니다.
