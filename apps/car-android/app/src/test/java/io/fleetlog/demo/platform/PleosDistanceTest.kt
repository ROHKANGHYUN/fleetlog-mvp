package io.fleetlog.demo.platform

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PleosDistanceTest {
    @Test fun kilometersUseDeclaredUnitAndExplicitHalfUpMeterRounding() {
        assertEquals(23_400L, PleosDistance.toMeters(23.4f))
        assertEquals(1_234L, PleosDistance.toMeters(1.2344f))
        assertEquals(1_235L, PleosDistance.toMeters(1.2345f))
        assertEquals(0L, PleosDistance.toMeters(0f))
        assertEquals(1L, PleosDistance.toMeters(0.0005f))
    }

    @Test fun unavailableNonfiniteNegativeAndOverflowNeverBecomeZero() {
        listOf(null, Float.NaN, Float.POSITIVE_INFINITY, Float.NEGATIVE_INFINITY, -1f, Float.MAX_VALUE)
            .forEach { assertNull(PleosDistance.toMeters(it)) }
    }
}
