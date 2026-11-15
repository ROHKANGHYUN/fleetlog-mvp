package io.fleetlog.demo.platform

import java.math.BigDecimal
import java.math.RoundingMode

/** Explicit test target; an SDK response alone cannot identify a real vehicle. */
enum class PleosEnvironment { PLEOS_EMULATOR, REAL_VEHICLE }

data class PleosDistanceObservation(
    val environment: PleosEnvironment,
    val rawKilometers: Float,
    val roundedMeters: Long,
    /** App receipt time, not a sensor-provided timestamp. */
    val observedAt: String,
)

/**
 * Vehicle 2.3.2 getCurrentDistanceDriven/registerDistanceDriven declare Float km.
 * Preserve that raw value separately; round its decimal representation to 1m,
 * HALF_UP. This policy cannot restore precision already lost by a Float source.
 */
object PleosDistance {
    fun toMeters(kilometers: Float?): Long? {
        if (kilometers == null || !kilometers.isFinite() || kilometers < 0f) return null
        return try {
            BigDecimal(kilometers.toString()).movePointRight(3)
                .setScale(0, RoundingMode.HALF_UP).longValueExact()
        } catch (_: ArithmeticException) {
            null
        }
    }
}
