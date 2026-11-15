package io.fleetlog.demo.platform

import ai.pleos.playground.vehicle.api.model.capability.AccessType
import ai.pleos.playground.vehicle.listener.DistanceDrivenListener
import java.time.Instant
import org.junit.Assert.*
import org.junit.Test

/** Exercises the actual diagnostic state machine with SDK/runtime faults, not a real service. */
class PleosProbeLifecycleTest {
    private class Operations : OdometerProbeOperations {
        var failAt: String? = null
        var allocated = false
        var releases = 0
        var unregisters = 0
        var registrations = 0
        var listener: DistanceDrivenListener? = null
        var capabilityCallback: ((AccessType) -> Unit)? = null
        var readCallback: ((Float?) -> Unit)? = null
        val cleanupOrder = mutableListOf<String>()
        override fun initialize() {
            allocated = true
            if (failAt == "initialize") throw NoClassDefFoundError("missing runtime")
        }
        override fun checkCapabilities(onComplete: (AccessType) -> Unit, onFailed: (Exception) -> Unit) {
            capabilityCallback = onComplete
            if (failAt == "capability") throw NoSuchMethodError("incompatible service")
        }
        override fun register(listener: DistanceDrivenListener) {
            this.listener = listener; registrations++
            if (failAt == "register") throw NoClassDefFoundError("missing registration class")
        }
        override fun read(onComplete: (Float?) -> Unit, onFailed: (Exception) -> Unit) {
            readCallback = onComplete
            if (failAt == "read") throw NoSuchMethodError("incompatible read")
        }
        override fun unregister(listener: DistanceDrivenListener) {
            assertSame(this.listener, listener)
            unregisters++; cleanupOrder += "unregister"
            // Deliberately violate cleanup behavior to exercise stale callbacks.
            listener.onDistanceDrivenUpdated(100f)
        }
        override fun release() {
            if (allocated) { releases++; allocated = false; cleanupOrder += "release" }
        }
    }
    private class Timers {
        val jobs = linkedSetOf<Runnable>()
        fun schedule(task: Runnable, delay: Long) { assertTrue(delay > 0); jobs += task }
        fun cancel(task: Runnable) { jobs -= task }
    }
    private fun probe(ops: Operations, timers: Timers, states: MutableList<PleosProbeState>) =
        PleosOdometerProbe(PleosEnvironment.PLEOS_EMULATOR, states::add, ops,
            timers::schedule, timers::cancel, now = { Instant.parse("2026-11-15T00:00:00Z") })

    @Test fun runtimeLinkageDuringPartialInitializationReleasesOwnedResourcesAndNeverClaimsConnection() {
        for (failure in listOf("initialize", "capability")) {
            val ops = Operations().apply { failAt = failure }
            val timers = Timers(); val states = mutableListOf<PleosProbeState>(); val probe = probe(ops, timers, states)
            probe.start()
            assertEquals(failure, PleosProbeStage.ERROR, probe.getState().stage)
            assertFalse(ops.allocated); assertEquals(1, ops.releases)
            assertNull(probe.getState().observation)
            assertFalse(probe.getState().featureResponseReceived)
            assertFalse(probe.getState().readCapabilityConfirmed)
            assertTrue(timers.jobs.isEmpty())
            ops.capabilityCallback?.invoke(AccessType.READ)
            assertEquals(PleosProbeStage.ERROR, probe.getState().stage)
            assertEquals(0, ops.registrations)
            probe.close()
            assertEquals(1, ops.releases)
        }
    }

    @Test fun registerOrReadLinkageUnregistersBeforeReleaseAndIgnoresCleanupCallbacks() {
        for (failure in listOf("register", "read")) {
            val ops = Operations().apply { failAt = failure }
            val timers = Timers(); val states = mutableListOf<PleosProbeState>(); val probe = probe(ops, timers, states)
            probe.start(); ops.capabilityCallback!!.invoke(AccessType.READ)
            assertEquals(failure, PleosProbeStage.ERROR, probe.getState().stage)
            assertEquals(listOf("unregister", "release"), ops.cleanupOrder)
            assertEquals(1, ops.unregisters); assertEquals(1, ops.releases)
            assertNull(probe.getState().observation)
            assertTrue(states.none { it.stage == PleosProbeStage.RECEIVING })
            assertTrue(timers.jobs.isEmpty())
            ops.listener!!.onDistanceDrivenUpdated(200f)
            ops.readCallback?.invoke(200f)
            assertEquals(PleosProbeStage.ERROR, probe.getState().stage)
        }
    }

    @Test fun initializationSupportAndFirstValueRemainSeparateAndClosedCallbacksCannotReviveTheProbe() {
        val ops = Operations(); val timers = Timers(); val states = mutableListOf<PleosProbeState>(); val probe = probe(ops, timers, states)
        probe.start()
        assertEquals(PleosProbeStage.CAPABILITY_PENDING, probe.getState().stage)
        assertTrue(probe.getState().initializationReturned)
        assertFalse(probe.getState().featureResponseReceived)
        ops.capabilityCallback!!.invoke(AccessType.READ)
        assertEquals(PleosProbeStage.READ_PENDING, probe.getState().stage)
        assertNull(probe.getState().observation)
        val oldListener = ops.listener!!; val oldRead = ops.readCallback!!
        oldRead(23.4f)
        assertEquals(23400L, probe.getState().observation!!.roundedMeters)
        assertEquals(PleosProbeStage.RECEIVING, probe.getState().stage)
        probe.close()
        assertEquals(PleosProbeStage.CLOSED, probe.getState().stage)
        oldListener.onDistanceDrivenUpdated(100f); oldRead(100f)
        assertEquals(PleosProbeStage.CLOSED, probe.getState().stage)
        assertNull(probe.getState().observation)
        assertTrue(timers.jobs.isEmpty())
    }

    @Test fun missingFirstValueAndNullNeverBecomeAZeroObservation() {
        for (noValue in listOf(true, false)) {
            val ops = Operations(); val timers = Timers(); val states = mutableListOf<PleosProbeState>(); val probe = probe(ops, timers, states)
            probe.start();ops.capabilityCallback!!.invoke(AccessType.READ)
            if (noValue) timers.jobs.single().run() else ops.readCallback!!(null)
            assertEquals(PleosProbeStage.UNAVAILABLE, probe.getState().stage)
            assertNull(probe.getState().observation)
            assertFalse(ops.allocated)
            assertTrue(timers.jobs.isEmpty())
        }
    }

    @Test fun reconnectOwnsOneNewListenerAndRejectsOldSessionResponses() {
        val ops = Operations(); val timers = Timers(); val states = mutableListOf<PleosProbeState>(); val probe = probe(ops, timers, states)
        probe.start(); val oldCapability = ops.capabilityCallback!!
        oldCapability(AccessType.READ)
        val oldRead = ops.readCallback!!; val oldListener = ops.listener!!
        oldRead(23f)
        probe.start()
        assertEquals(1, ops.unregisters); assertEquals(1, ops.releases)
        assertEquals(PleosProbeStage.CAPABILITY_PENDING, probe.getState().stage)
        oldCapability(AccessType.READ); oldRead(99f); oldListener.onDistanceDrivenUpdated(99f)
        assertEquals(PleosProbeStage.CAPABILITY_PENDING, probe.getState().stage)
        assertNull(probe.getState().observation)
        val newCapability = ops.capabilityCallback!!
        newCapability(AccessType.READ); newCapability(AccessType.READ)
        assertEquals(2, ops.registrations)
        ops.readCallback!!(24f)
        assertEquals(24000L, probe.getState().observation!!.roundedMeters)
        probe.close()
        assertEquals(2, ops.unregisters); assertEquals(2, ops.releases)
        assertTrue(timers.jobs.isEmpty())
    }
}
