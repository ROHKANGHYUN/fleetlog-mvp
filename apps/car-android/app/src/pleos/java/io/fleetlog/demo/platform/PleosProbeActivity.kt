package io.fleetlog.demo.platform

import android.app.Activity
import android.os.Bundle
import android.widget.ScrollView
import android.widget.TextView

/** Explicit opt-in diagnostic entry. No records, file writes, credentials or API upload. */
class PleosProbeActivity : Activity() {
    private lateinit var text: TextView
    private var environment: PleosEnvironment? = null
    private var odometer: PleosOdometerProbe? = null
    private var ux: CarUxRestrictionProbe? = null
    private var distanceState: PleosProbeState? = null
    private var uxState: CarUxProbeState? = null
    private var distanceError: String? = null
    private var uxError: String? = null
    private var epoch = 0L
    private var running = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        environment = intent.getStringExtra("environment")?.let { value ->
            PleosEnvironment.entries.firstOrNull { it.name == value }
        }
        text = TextView(this).apply {
            textSize = 18f
            setPadding(24, 24, 24, 24)
            setTextIsSelectable(false)
        }
        setContentView(ScrollView(this).apply { addView(text) })
        render()
    }

    override fun onStart() {
        super.onStart()
        val target = environment ?: return
        val token = ++epoch
        running = true
        distanceState = null; uxState = null; distanceError = null; uxError = null
        render()
        try {
            val distanceProbe = PleosOdometerProbe(applicationContext, target, onState = { value ->
                update(token) { distanceState = value }
            })
            odometer = distanceProbe // Own it before start, including partial initialization failures.
            distanceProbe.start()
        } catch (error: Exception) {
            distanceError = "진단 시작 실패: ${error.javaClass.simpleName}"
        } catch (_: LinkageError) {
            distanceError = "Vehicle SDK 라이브러리 사용 불가"
        }
        try {
            val restrictionProbe = CarUxRestrictionProbe(applicationContext, onState = { value ->
                update(token) { uxState = value }
            })
            ux = restrictionProbe
            restrictionProbe.start()
        } catch (error: Exception) {
            uxError = "진단 시작 실패: ${error.javaClass.simpleName}"
        } catch (_: LinkageError) {
            uxError = "AAOS 라이브러리 사용 불가"
        }
        render()
    }

    private fun update(token: Long, change: () -> Unit) {
        runOnUiThread {
            if (token == epoch && running) { change(); render() }
        }
    }

    override fun onStop() {
        ++epoch
        running = false
        runCatching { odometer?.close() }
        runCatching { ux?.close() }
        odometer = null; ux = null
        distanceState = distanceState?.copy(stage = PleosProbeStage.CLOSED, observation = null, message = "SDK 진단 종료")
        uxState = CarUxProbeState(stage = CarUxProbeStage.CLOSED, message = "AAOS 진단 종료 · 입력 차단")
        render()
        super.onStop()
    }

    private fun render() {
        if (!::text.isInitialized) return
        text.text = buildString {
            appendLine("Fleetlog · 선택적 Pleos SDK 읽기 진단")
            appendLine("기본 MOCK 앱과 분리 · 기록 저장/서버 전송 없음")
            appendLine("대상 지정: ${environment?.name ?: "없음"} · 실제 대상 환경 대조는 별도 확인")
            if (environment == null) {
                appendLine("environment를 PLEOS_EMULATOR 또는 REAL_VEHICLE로 명시해야 진단을 시작합니다.")
                appendLine("SDK 호출 미실행 · 입력 차단")
                return@buildString
            }
            appendLine("상태: ${if (running) "진단 실행 중" else "진단 중지 · 자원 해제 요청"}")
            appendLine()
            appendLine("누적거리 · Vehicle SDK 2.3.2 선언 기준")
            appendLine(distanceError ?: distanceState?.message ?: "초기 응답 미수신")
            distanceState?.let { state ->
                appendLine("단계: ${state.stage}")
                appendLine("초기화 호출 반환: ${state.initializationReturned}")
                appendLine("기능 응답 수신: ${state.featureResponseReceived}")
                appendLine("읽기 capability 확인: ${state.readCapabilityConfirmed}")
                val observation = state.observation
                if (observation == null) appendLine("현재 유효 값 없음 · 0으로 대체하지 않음")
                else {
                    appendLine("원본: ${observation.rawKilometers} km")
                    appendLine("변환 참고값: ${observation.roundedMeters} m · 1m HALF_UP")
                    appendLine("앱 관측 시각: ${observation.observedAt}")
                    appendLine("공식 SDK 선언 단위 km · 실제 계기판 대조 미검증")
                }
            }
            appendLine()
            appendLine("플랫폼 CarUxRestrictions")
            appendLine(uxError ?: uxState?.message ?: "초기 제한 상태 미수신")
            uxState?.let { state ->
                appendLine("단계: ${state.stage} / 서비스 ready: ${state.serviceReady}")
                appendLine("DO 필요: ${state.requiresDistractionOptimization ?: "미확인"}")
                appendLine("제한 flags: ${state.activeRestrictions ?: "미확인"}")
                appendLine("주차: ${state.gate.parking} · 이 진단만으로 입력 허용하지 않음")
            }
            appendLine()
            appendLine("초기화 반환/리스너 등록 반환은 서비스 연결·최초 유효 데이터 수신과 다릅니다.")
            appendLine("실제 음성 안내·인식·운전자/차량 인증은 이 화면에서 수행하지 않습니다.")
        }
    }
}
