package io.fleetlog.demo.platform

import io.fleetlog.demo.domain.ParkingState

sealed interface Capability {
    data object MockSupported : Capability
    data class Unsupported(val reason: String) : Capability
}

enum class DataOrigin { APP_MOCK, PLEOS_EMULATOR, VEHICLE }
enum class ConnectionPhase { DISABLED, CONNECTING, CONNECTED, SUPPORTED, RECEIVED, ERROR }
enum class UxRestriction { UNKNOWN, UNRESTRICTED, RESTRICTED }

data class InputGate(
    val parking: ParkingState = ParkingState.UNKNOWN,
    val restriction: UxRestriction = UxRestriction.UNKNOWN,
    val connected: Boolean = false,
    val observedAtMillis: Long? = null,
) {
    fun allowsInput(nowMillis: Long, maximumAgeMillis: Long = 30_000): Boolean {
        val observed = observedAtMillis ?: return false
        return connected && parking == ParkingState.PARKED && restriction == UxRestriction.UNRESTRICTED &&
            nowMillis >= observed && nowMillis - observed <= maximumAgeMillis
    }
}

data class VehicleObservation(
    val odometerM: Long?,
    val parking: ParkingState,
    val receivedAt: String,
    val origin: DataOrigin = DataOrigin.APP_MOCK,
    val source: String = "mock",
)

interface VehicleAdapter {
    val capability: Capability
    val phase: ConnectionPhase
    fun observe(odometerM: Long, parking: ParkingState): Result<VehicleObservation>
    fun close() {}
}

class MockVehicleAdapter : VehicleAdapter {
    override val capability: Capability = Capability.MockSupported
    override val phase = ConnectionPhase.RECEIVED
    override fun observe(odometerM: Long, parking: ParkingState) = Result.success(
        VehicleObservation(odometerM, parking, java.time.Instant.now().toString()),
    )
}

/** No SDK call, guessed unit, permission or silent mock fallback. */
class DisabledPleosVehicleAdapter : VehicleAdapter {
    override val capability = Capability.Unsupported("공식 SDK 선언은 확인했으나 대상 서비스·권한·유효 수신·주차/UX 제한을 검증하지 못해 live 수집을 차단했습니다.")
    override val phase = ConnectionPhase.DISABLED
    override fun observe(odometerM: Long, parking: ParkingState): Result<VehicleObservation> =
        Result.failure(UnsupportedOperationException(capability.reason))
}
