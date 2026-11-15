package io.fleetlog.demo.platform

import ai.pleos.playground.vehicle.Vehicle
import ai.pleos.playground.vehicle.api.Odometer
import ai.pleos.playground.vehicle.api.model.capability.AccessType
import ai.pleos.playground.vehicle.listener.DistanceDrivenListener
import android.content.Context
import android.os.Handler
import android.os.Looper
import java.time.Instant

enum class PleosProbeStage {
    IDLE, INITIALIZING, INITIALIZED, CAPABILITY_PENDING, CAPABILITY_CONFIRMED,
    READ_PENDING, RECEIVING, UNAVAILABLE, UNSUPPORTED, ERROR, CLOSED,
}

data class PleosProbeState(
    val environment: PleosEnvironment,
    val stage: PleosProbeStage = PleosProbeStage.IDLE,
    val initializationReturned: Boolean = false,
    /** A feature callback is evidence of communication, not a general connection callback. */
    val featureResponseReceived: Boolean = false,
    val readCapabilityConfirmed: Boolean = false,
    val observation: PleosDistanceObservation? = null,
    val message: String = "SDK 진단 대기 · 수집/전송과 분리",
)

/** Actual SDK calls are a small injectable port so the real lifecycle can be fault-tested on the JVM. */
internal interface OdometerProbeOperations {
    fun initialize()
    fun checkCapabilities(onComplete: (AccessType) -> Unit, onFailed: (Exception) -> Unit)
    fun register(listener: DistanceDrivenListener)
    fun read(onComplete: (Float?) -> Unit, onFailed: (Exception) -> Unit)
    fun unregister(listener: DistanceDrivenListener)
    fun release()
}

private class SdkOdometerOperations(private val context: Context) : OdometerProbeOperations {
    private var vehicle: Vehicle? = null
    private var odometer: Odometer? = null
    override fun initialize() {
        // Retain ownership before initialize: a failed call may already allocate SDK resources.
        val instance = Vehicle(context)
        vehicle = instance
        instance.initialize()
    }
    override fun checkCapabilities(onComplete: (AccessType) -> Unit, onFailed: (Exception) -> Unit) {
        val domain = requireNotNull(vehicle).getOdometer()
        odometer = domain
        domain.checkCurrentDistanceDrivenCapabilities({ onComplete(it.accessType) }, onFailed)
    }
    override fun register(listener: DistanceDrivenListener) = requireNotNull(odometer).registerDistanceDriven(listener)
    override fun read(onComplete: (Float?) -> Unit, onFailed: (Exception) -> Unit) =
        requireNotNull(odometer).getCurrentDistanceDriven(onComplete, onFailed)
    override fun unregister(listener: DistanceDrivenListener) { odometer?.unregisterDistanceDriven(listener) }
    override fun release() {
        val old = vehicle
        odometer = null; vehicle = null
        old?.release()
    }
}

/**
 * Optional, read-only Vehicle 2.3.2 diagnostic. Not a recording adapter, and never
 * sends SDK values through the mock wire contract. Build only with pleosSdk=true.
 * Vehicle.initialize() has no public service-ready callback in this version.
 */
class PleosOdometerProbe internal constructor(
    private val environment: PleosEnvironment,
    private val onState: (PleosProbeState) -> Unit,
    private val operations: OdometerProbeOperations,
    private val schedule: (Runnable, Long) -> Unit,
    private val cancelScheduled: (Runnable) -> Unit,
    private val now: () -> Instant = { Instant.now() },
    private val responseTimeoutMs: Long = 10_000,
    private val freshnessTimeoutMs: Long = 15_000,
) : AutoCloseable {
    constructor(context: Context, environment: PleosEnvironment, onState: (PleosProbeState) -> Unit,
                handler: Handler = Handler(Looper.getMainLooper()), now: () -> Instant = { Instant.now() },
                responseTimeoutMs: Long = 10_000, freshnessTimeoutMs: Long = 15_000) : this(
        environment, onState, SdkOdometerOperations(context.applicationContext),
        { task, delay -> handler.postDelayed(task, delay); Unit }, { task -> handler.removeCallbacks(task) },
        now, responseTimeoutMs, freshnessTimeoutMs)
    private var generation = 0L
    private var listener: DistanceDrivenListener? = null
    private var deadline: Runnable? = null
    private var state = PleosProbeState(environment)

    init { require(responseTimeoutMs > 0 && freshnessTimeoutMs > 0) }

    @Synchronized fun getState(): PleosProbeState = state

    @Synchronized fun start() {
        releaseOperations()
        val token = generation
        state = PleosProbeState(environment, stage = PleosProbeStage.INITIALIZING, message = "SDK 초기화 요청 중")
        publish()
        if (!current(token)) return
        try {
            operations.initialize()
            if (!current(token)) return
            state = state.copy(stage = PleosProbeStage.INITIALIZED, initializationReturned = true,
                message = "초기화 호출 반환 · 서비스 연결/데이터 수신은 미확인")
            publish()
            if (!current(token)) return
            state = state.copy(stage = PleosProbeStage.CAPABILITY_PENDING, message = "누적거리 읽기 지원 확인 중")
            publish()
            if (!current(token)) return
            arm(token, responseTimeoutMs, "지원 확인 응답 미수신")
            operations.checkCapabilities(
                onComplete = { access -> capability(token, access) },
                onFailed = { fail(token, PleosProbeStage.ERROR, "지원 확인 실패: ${it.javaClass.simpleName}") },
            )
        } catch (error: Exception) {
            fail(token, PleosProbeStage.ERROR, "SDK 초기화/요청 실패: ${error.javaClass.simpleName}")
        } catch (error: LinkageError) {
            fail(token, PleosProbeStage.ERROR, "SDK 필수 클래스/서비스 호환 확인 필요: ${error.javaClass.simpleName}")
        }
    }

    @Synchronized private fun capability(token: Long, access: AccessType) {
        if (!current(token) || state.readCapabilityConfirmed) return
        cancelDeadline()
        state = state.copy(featureResponseReceived = true)
        if (access != AccessType.READ && access != AccessType.READ_WRITE) {
            fail(token, PleosProbeStage.UNSUPPORTED, "누적거리 읽기 지원 없음: $access")
            return
        }
        state = state.copy(stage = PleosProbeStage.CAPABILITY_CONFIRMED, readCapabilityConfirmed = true,
            message = "읽기 지원 응답 수신 · 최초 유효 값은 미수신")
        publish()
        if (!current(token)) return
        try {
            val updates = object : DistanceDrivenListener {
                override fun onDistanceDrivenUpdated(value: Float?) { observe(token, value) }
                override fun onFailed(e: Exception) {
                    fail(token, PleosProbeStage.ERROR, "누적거리 업데이트 실패: ${e.javaClass.simpleName}")
                }
            }
            listener = updates
            operations.register(updates)
            if (!current(token)) return
            if (state.observation == null) {
                state = state.copy(stage = PleosProbeStage.READ_PENDING,
                    message = "읽기/업데이트 요청 · 등록 반환은 데이터 수신을 뜻하지 않음")
                publish()
                if (!current(token)) return
                arm(token, responseTimeoutMs, "최초 누적거리 값 미수신")
            }
            operations.read(
                onComplete = { observe(token, it) },
                onFailed = { fail(token, PleosProbeStage.ERROR, "누적거리 읽기 실패: ${it.javaClass.simpleName}") },
            )
        } catch (error: Exception) {
            fail(token, PleosProbeStage.ERROR, "누적거리 요청 실패: ${error.javaClass.simpleName}")
        } catch (error: LinkageError) {
            fail(token, PleosProbeStage.ERROR, "누적거리 SDK 클래스/서비스 호환 확인 필요: ${error.javaClass.simpleName}")
        }
    }

    @Synchronized private fun observe(token: Long, kilometers: Float?) {
        if (!current(token)) return
        val meters = PleosDistance.toMeters(kilometers)
        if (meters == null || kilometers == null) {
            fail(token, PleosProbeStage.UNAVAILABLE, "누적거리 값 미수신 또는 유효 범위 밖 · 0으로 대체하지 않음")
            return
        }
        val previous = state.observation
        if (previous != null && kilometers < previous.rawKilometers) {
            fail(token, PleosProbeStage.UNAVAILABLE, "누적거리 역전 · 진단 값 사용 중단")
            return
        }
        state = state.copy(stage = PleosProbeStage.RECEIVING, featureResponseReceived = true,
            observation = PleosDistanceObservation(environment, kilometers, meters, now().toString()),
            message = "SDK 누적거리 값 수신 · 앱 관측 시각 · mock 기록/전송에 사용하지 않음")
        publish()
        if (current(token)) arm(token, freshnessTimeoutMs, "누적거리 관측이 오래됨 · 새 진단 시작 필요")
    }

    @Synchronized private fun fail(token: Long, stage: PleosProbeStage, message: String) {
        if (!current(token)) return
        releaseOperations() // Invalidate callbacks before unregister/release.
        state = state.copy(stage = stage, observation = null, message = message)
        publish()
    }

    private fun arm(token: Long, timeout: Long, message: String) {
        cancelDeadline()
        deadline = Runnable { fail(token, PleosProbeStage.UNAVAILABLE, message) }
        schedule(deadline!!, timeout)
    }

    private fun cancelDeadline() { deadline?.let(cancelScheduled); deadline = null }
    private fun current(token: Long) = token == generation
    private fun publish() { onState(state) }

    private fun releaseOperations() {
        generation++
        cancelDeadline()
        val oldListener = listener
        listener = null
        if (oldListener != null) runCatching { operations.unregister(oldListener) }
        runCatching { operations.release() }
    }

    @Synchronized override fun close() {
        releaseOperations()
        state = state.copy(stage = PleosProbeStage.CLOSED, observation = null, message = "SDK 진단 종료")
        publish()
    }
}
