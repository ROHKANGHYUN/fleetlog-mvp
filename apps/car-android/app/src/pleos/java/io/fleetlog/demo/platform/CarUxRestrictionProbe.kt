package io.fleetlog.demo.platform

import android.car.Car
import android.car.drivingstate.CarUxRestrictions
import android.car.drivingstate.CarUxRestrictionsManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import io.fleetlog.demo.domain.ParkingState

enum class CarUxProbeStage { IDLE, CONNECTING, CONNECTED, RECEIVED, UNKNOWN, ERROR, CLOSED }

data class CarUxProbeState(
    val stage: CarUxProbeStage = CarUxProbeStage.IDLE,
    val serviceReady: Boolean = false,
    val requiresDistractionOptimization: Boolean? = null,
    val activeRestrictions: Int? = null,
    val gate: InputGate = InputGate(),
    val message: String = "AAOS 주행 제한 미확인 · 입력 차단",
)

/**
 * Optional AAOS platform diagnostic. This probe never infers parking from speed
 * or an unrestricted UX state: its gate keeps parking UNKNOWN. A separate,
 * supported and fresh vehicle-state path is required before allowing input.
 */
class CarUxRestrictionProbe(
    context: Context,
    private val onState: (CarUxProbeState) -> Unit,
    private val handler: Handler = Handler(Looper.getMainLooper()),
    private val nowMillis: () -> Long = { System.currentTimeMillis() },
    private val connectionTimeoutMs: Long = 10_000,
    private val freshnessTimeoutMs: Long = 30_000,
) : AutoCloseable {
    private val appContext = context.applicationContext
    private var generation = 0L
    private var subscriptionGeneration = 0L
    private var car: Car? = null
    private var manager: CarUxRestrictionsManager? = null
    private var listener: CarUxRestrictionsManager.OnUxRestrictionsChangedListener? = null
    private var deadline: Runnable? = null
    private var state = CarUxProbeState()

    init { require(connectionTimeoutMs > 0 && freshnessTimeoutMs > 0) }

    @Synchronized fun getState(): CarUxProbeState = state

    @Synchronized fun start() {
        releaseOperations()
        if (!appContext.packageManager.hasSystemFeature(PackageManager.FEATURE_AUTOMOTIVE)) {
            state = CarUxProbeState(stage = CarUxProbeStage.UNKNOWN,
                message = "Automotive 플랫폼 아님 · 실제 제한/주차 미확인 · 입력 차단")
            publish()
            return
        }
        val token = generation
        state = CarUxProbeState(stage = CarUxProbeStage.CONNECTING, message = "AAOS Car 서비스 연결 요청 중 · 입력 차단")
        publish()
        if (!current(token)) return
        arm(token, connectionTimeoutMs, "AAOS 서비스 연결 응답 미수신")
        try {
            val created = Car.createCar(appContext, handler, Car.CAR_WAIT_TIMEOUT_DO_NOT_WAIT,
                Car.CarServiceLifecycleListener { connection, ready -> serviceChanged(token, connection, ready) })
            if (current(token)) car = created else runCatching { created?.disconnect() }
            if (current(token) && created == null) unknown("AAOS Car 객체를 얻지 못함")
        } catch (error: Exception) {
            if (current(token)) failure("AAOS 연결 실패: ${error.javaClass.simpleName}")
        } catch (_: LinkageError) {
            if (current(token)) failure("AAOS 라이브러리/서비스 사용 불가")
        }
    }

    @Synchronized private fun serviceChanged(token: Long, connection: Car, ready: Boolean) {
        if (!current(token)) return
        cancelDeadline()
        clearManager()
        car = connection
        if (!ready) {
            state = CarUxProbeState(stage = CarUxProbeStage.UNKNOWN, message = "AAOS 서비스 연결 해제 · 입력 차단")
            publish()
            return
        }
        state = CarUxProbeState(stage = CarUxProbeStage.CONNECTED, serviceReady = true,
            message = "AAOS 서비스 연결 확인 · 제한 값은 미수신 · 입력 차단")
        publish()
        if (!current(token)) return
        try {
            val currentManager = connection.getCarManager(Car.CAR_UX_RESTRICTION_SERVICE) as? CarUxRestrictionsManager
            if (currentManager == null) { unknown("주행 제한 manager 사용 불가"); return }
            manager = currentManager
            val subscription = subscriptionGeneration
            val updates = CarUxRestrictionsManager.OnUxRestrictionsChangedListener { restrictions ->
                restrictionsChanged(token, subscription, restrictions)
            }
            listener = updates
            currentManager.registerListener(updates)
            if (!current(token) || subscription != subscriptionGeneration) return
            restrictionsChanged(token, subscription, currentManager.currentCarUxRestrictions)
        } catch (error: Exception) {
            if (current(token)) failure("주행 제한 조회/구독 실패: ${error.javaClass.simpleName}")
        } catch (error: LinkageError) {
            if (current(token)) failure("주행 제한 SDK/플랫폼 호환 확인 필요: ${error.javaClass.simpleName}")
        }
    }

    /** Explicit refresh; an unchanged restriction need not produce periodic events. */
    @Synchronized fun refresh() {
        val token = generation
        val currentManager = manager
        if (!state.serviceReady || currentManager == null) { unknown("주행 제한 연결 미확인"); return }
        try {
            restrictionsChanged(token, subscriptionGeneration, currentManager.currentCarUxRestrictions)
        } catch (error: Exception) {
            if (current(token)) failure("주행 제한 재조회 실패: ${error.javaClass.simpleName}")
        } catch (error: LinkageError) {
            if (current(token)) failure("주행 제한 재조회 SDK/플랫폼 호환 확인 필요: ${error.javaClass.simpleName}")
        }
    }

    @Synchronized private fun restrictionsChanged(token: Long, subscription: Long, restrictions: CarUxRestrictions?) {
        if (!current(token) || subscription != subscriptionGeneration || !state.serviceReady) return
        if (restrictions == null) { unknown("주행 제한 값 미수신"); return }
        val needsDo = restrictions.isRequiresDistractionOptimization
        val flags = restrictions.activeRestrictions
        val restriction = if (needsDo || flags != CarUxRestrictions.UX_RESTRICTIONS_BASELINE)
            UxRestriction.RESTRICTED else UxRestriction.UNRESTRICTED
        state = CarUxProbeState(stage = CarUxProbeStage.RECEIVED, serviceReady = true,
            requiresDistractionOptimization = needsDo, activeRestrictions = flags,
            gate = InputGate(ParkingState.UNKNOWN, restriction, true, nowMillis()),
            message = "플랫폼 제한 수신 · 주차는 별도 미확인 · 입력 차단")
        publish()
        if (current(token)) arm(token, freshnessTimeoutMs, "주행 제한 관측이 오래됨 · 재조회 필요")
    }

    private fun unknown(message: String) {
        cancelDeadline()
        state = state.copy(stage = CarUxProbeStage.UNKNOWN, requiresDistractionOptimization = null,
            activeRestrictions = null, gate = InputGate(), message = "$message · 입력 차단")
        publish()
    }

    private fun failure(message: String) {
        releaseOperations()
        state = CarUxProbeState(stage = CarUxProbeStage.ERROR, message = "$message · 연결/제한 미확인 · 입력 차단")
        publish()
    }

    private fun arm(token: Long, timeout: Long, message: String) {
        cancelDeadline()
        deadline = Runnable { synchronized(this) { if (current(token)) unknown(message) } }
        handler.postDelayed(deadline!!, timeout)
    }

    private fun cancelDeadline() { deadline?.let(handler::removeCallbacks); deadline = null }
    private fun current(token: Long) = token == generation
    private fun publish() { onState(state) }

    private fun clearManager() {
        subscriptionGeneration++ // Invalidates old notifications even within one Car session.
        val oldManager = manager
        manager = null; listener = null
        runCatching { oldManager?.unregisterListener() }
    }

    private fun releaseOperations() {
        generation++
        cancelDeadline()
        clearManager()
        val oldCar = car
        car = null
        runCatching { oldCar?.disconnect() }
    }

    @Synchronized override fun close() {
        releaseOperations()
        state = CarUxProbeState(stage = CarUxProbeStage.CLOSED, message = "AAOS 진단 종료 · 입력 차단")
        publish()
    }
}
