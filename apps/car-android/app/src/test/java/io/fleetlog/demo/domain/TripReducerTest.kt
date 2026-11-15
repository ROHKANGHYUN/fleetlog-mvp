package io.fleetlog.demo.domain

import org.junit.Assert.*
import org.junit.Test

class TripReducerTest {
    private val start = "2026-11-14T00:00:00.000Z"
    private val movement = "2026-11-14T00:20:00.000Z"
    private val parked = "2026-11-14T00:30:00.000Z"
    private val finished = "2026-11-14T00:31:00.000Z"

    private fun driving(): LocalSnapshot = TripReducer.reduce(
        TripReducer.reduce(LocalSnapshot(), Action.StartCollection),
        Action.StartTrip("trip-id", "event-id", start),
    )
    private fun moved() = TripReducer.reduce(driving(), Action.SimulateMovement(movement))
    private fun parked() = TripReducer.reduce(moved(), Action.Park(parked))
    private fun candidate() = TripReducer.reduce(parked(), Action.Finish(finished))

    @Test fun collectionStartAndUserStopRequireParking() {
        assertThrows(IllegalArgumentException::class.java) {
            TripReducer.reduce(LocalSnapshot(parking = ParkingState.UNKNOWN), Action.StartCollection)
        }
        assertThrows(IllegalArgumentException::class.java) {
            TripReducer.reduce(driving(), Action.StopCollection)
        }
    }

    @Test fun parkingAloneNeitherClosesNorEnablesConfirmation() {
        val result = parked()
        assertNotNull(result.activeTrip)
        assertNull(result.activeTrip!!.candidateEndedAt)
        assertTrue(result.trips.isEmpty())
        assertThrows(IllegalArgumentException::class.java) {
            TripReducer.reduce(result, Action.Confirm(Purpose.BUSINESS, "미팅"))
        }
    }

    @Test fun cannotConfirmWhileDriving() {
        assertThrows(IllegalArgumentException::class.java) {
            TripReducer.reduce(driving(), Action.Confirm(Purpose.BUSINESS, "미팅"))
        }
    }

    @Test fun explicitFinishFixesBoundaryBeforePurposeConfirmation() {
        val state = TripReducer.reduce(candidate(), Action.Confirm(Purpose.BUSINESS, "미팅"))
        val record = state.trips.single()
        assertNull(state.activeTrip)
        assertEquals(23_400L, record.endOdometerM - record.startOdometerM)
        assertEquals(finished, record.endedAt)
        assertEquals("valid", record.quality)
        assertEquals("explicit_finish", record.boundaryReason)
        assertEquals("event-id", record.eventId)
        assertFalse(record.synced)
    }

    @Test fun deferQueuesNullablePurposeAndPreservesObservedDistance() {
        val state = TripReducer.reduce(candidate(), Action.Defer)
        assertNull(state.activeTrip)
        assertNull(state.trips.single().purpose)
        assertEquals("valid", state.trips.single().quality)
        assertEquals(23_400L, state.trips.single().endOdometerM - state.trips.single().startOdometerM)
        assertFalse(state.trips.single().synced)
    }

    @Test fun parkedCollectionStopQueuesGapWithoutClaimingTripEnd() {
        val state = TripReducer.reduce(parked(), Action.StopCollection)
        val record = state.trips.single()
        assertFalse(state.collecting)
        assertNull(state.activeTrip)
        assertNull(record.purpose)
        assertEquals("gap", record.quality)
        assertEquals("collection_stop", record.boundaryReason)
        assertEquals(parked, record.endedAt)
        assertEquals("event-id", record.eventId)
    }

    @Test fun restartQueuesPositiveGapOnceAndAllowsNewCollectionAfterMockParking() {
        val recovered = TripReducer.recover(moved())
        val record = recovered.trips.single()
        assertFalse(recovered.collecting)
        assertNull(recovered.activeTrip)
        assertEquals(ParkingState.UNKNOWN, recovered.parking)
        assertNull(record.purpose)
        assertEquals("gap", record.quality)
        assertEquals(movement, record.endedAt)
        assertEquals("event-id", record.eventId)
        assertEquals(1, TripReducer.recover(recovered).trips.size)
        var restarted = TripReducer.reduce(recovered, Action.Park(parked))
        restarted = TripReducer.reduce(restarted, Action.StartCollection)
        restarted = TripReducer.reduce(restarted, Action.StartTrip("trip-2", "event-2", finished))
        assertEquals("trip-2", restarted.activeTrip!!.tripId)
    }

    @Test fun zeroDistanceRecoveryDoesNotInventATrip() {
        val result = TripReducer.recover(driving())
        assertNull(result.activeTrip)
        assertTrue(result.trips.isEmpty())
        assertFalse(result.collecting)
    }

    @Test fun resumeDrivingInvalidatesFinishCandidate() {
        val resumed = TripReducer.reduce(candidate(), Action.ResumeDriving(finished))
        assertEquals(ParkingState.DRIVING, resumed.parking)
        assertNull(resumed.activeTrip!!.candidateEndedAt)
        assertTrue(resumed.trips.isEmpty())
    }

    @Test fun backgroundInterruptionCanPreserveDrivingLegWithoutUserStop() {
        val result = TripReducer.reduce(moved(), Action.InterruptCollection)
        assertFalse(result.collecting)
        assertEquals(ParkingState.UNKNOWN, result.parking)
        assertEquals(movement, result.trips.single().endedAt)
        assertEquals("gap", result.trips.single().quality)
        assertNull(result.trips.single().purpose)
    }

    @Test fun duplicateAcknowledgementDoesNotDuplicateTrip() {
        var state = TripReducer.reduce(candidate(), Action.Defer)
        state = TripReducer.reduce(state, Action.PrepareEvent("event-id", "prepared request"))
        repeat(2) { state = TripReducer.reduce(state, Action.AcceptAck(SyncAck("event-id", 1, 1))) }
        assertEquals(1, state.trips.size)
        assertTrue(state.trips.single().synced)
    }
}
