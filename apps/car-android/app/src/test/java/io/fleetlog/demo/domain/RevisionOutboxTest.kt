package io.fleetlog.demo.domain

import org.junit.Assert.*
import org.junit.Test

class RevisionOutboxTest {
    private val start = "2026-11-15T01:00:00.000Z"
    private val end = "2026-11-15T01:30:00.000Z"
    private fun candidate(): LocalSnapshot {
        var s = TripReducer.reduce(LocalSnapshot(), Action.StartCollection)
        s = TripReducer.reduce(s, Action.StartTrip("trip", "event", start))
        s = TripReducer.reduce(s, Action.SimulateMovement(end))
        s = TripReducer.reduce(s, Action.Park(end))
        return TripReducer.reduce(s, Action.Finish(end))
    }
    private fun queued() = TripReducer.reduce(candidate(), Action.Defer)
    private fun correction(s: LocalSnapshot): LocalSnapshot {
        var next = TripReducer.reduce(s, Action.EditTrip("trip"))
        next = TripReducer.reduce(next, Action.SetPurpose(Purpose.COMMUTE, "보완"))
        next = TripReducer.reduce(next, Action.Review)
        return TripReducer.reduce(next, Action.Save)
    }
    @Test fun correctionPreservesRawGapAndUsesNewEventInSameTrip() {
        val gap = TripReducer.recover(candidate())
        val original = gap.trips.single()
        val ready = TripReducer.reduce(gap, Action.Park(end))
        val next = correction(ready)
        val revised = next.trips.single()
        assertEquals(original.tripId, revised.tripId)
        assertEquals(original.startedAt, revised.startedAt);assertEquals(original.endedAt, revised.endedAt)
        assertEquals(original.startOdometerM, revised.startOdometerM);assertEquals(original.endOdometerM, revised.endOdometerM)
        assertEquals("gap", revised.quality)
        assertEquals(2, revised.localRevision);assertFalse(revised.synced)
        assertNotEquals(original.eventId, revised.eventId)
        assertEquals(original.eventId, next.outbox.last().predecessorEventId)
        assertEquals(null, next.outbox.last().preparedBody)
    }
    @Test fun oldAckWhileCorrectionExistsOnlyCompletesItsOwnRevision() {
        var s = TripReducer.reduce(queued(), Action.PrepareEvent("event", "original body"))
        s = correction(s)
        assertEquals(0, s.trips.single().ackedLocalRevision)
        assertEquals("event", TripReducer.nextEvent(s)!!.eventId)
        s = TripReducer.reduce(s, Action.AcceptAck(SyncAck("event", 1, 1)))
        assertEquals(1, s.trips.single().ackedLocalRevision);assertFalse(s.trips.single().synced)
        assertEquals(2, s.trips.single().localRevision)
        val second = TripReducer.nextEvent(s)!!
        assertEquals(1, TripReducer.expectedVersion(s, second))
        s = TripReducer.reduce(s, Action.PrepareEvent(second.eventId, "revision 2 body"))
        s = TripReducer.reduce(s, Action.AcceptAck(SyncAck(second.eventId, 2, 2)))
        assertTrue(s.trips.single().synced);assertTrue(s.outbox.isEmpty())
        assertEquals(1, s.trips.size)
    }
    @Test fun rejectedAckAndPreparedBodyChangesLeaveImmutableInputStateUntouched() {
        val original = TripReducer.reduce(queued(), Action.PrepareEvent("event", "body"))
        assertThrows(IllegalArgumentException::class.java) { TripReducer.reduce(original, Action.PrepareEvent("event", "changed")) }
        for (ack in listOf(SyncAck("wrong", 1, 1), SyncAck("event", 2, 1), SyncAck("event", 1, 9))) {
            assertThrows(IllegalArgumentException::class.java) { TripReducer.reduce(original, Action.AcceptAck(ack)) }
        }
        assertFalse(original.trips.single().synced);assertEquals("body", original.outbox.single().preparedBody)
        assertTrue(original.receipts.isEmpty())
    }
    @Test fun conflictBlocksOnlyItsOwnDependentChain() {
        var s = correction(queued())
        s = TripReducer.reduce(s, Action.FailEvent("event", DeliveryStatus.CONFLICT, "409"))
        assertNull(TripReducer.nextEvent(s))
        assertThrows(IllegalArgumentException::class.java) { TripReducer.reduce(s, Action.EditTrip("trip")) }
        s = TripReducer.reduce(s, Action.StartTrip("other", "other-event", start))
        s = TripReducer.reduce(s, Action.SimulateMovement(end));s = TripReducer.reduce(s, Action.Park(end))
        s = TripReducer.reduce(s, Action.Finish(end));s = TripReducer.reduce(s, Action.Defer)
        assertEquals("other-event", TripReducer.nextEvent(s)!!.eventId)
        assertEquals(2, s.trips.size)
    }
    @Test fun safetyUnknownAndRestrictionBothInvalidateInputAndFinishCandidate() {
        for (action in listOf(Action.UpdateVehicleState(ParkingState.UNKNOWN, UxRestrictionState.UNRESTRICTED),
            Action.UpdateVehicleState(ParkingState.PARKED, UxRestrictionState.RESTRICTED),
            Action.UpdateVehicleState(ParkingState.PARKED, UxRestrictionState.UNKNOWN))) {
            val next = TripReducer.reduce(candidate(), action)
            assertNull(next.input);assertNull(next.activeTrip!!.candidateEndedAt)
            assertFalse(TripReducer.inputAllowed(next))
            assertThrows(IllegalArgumentException::class.java) { TripReducer.reduce(next, Action.SetPurpose(Purpose.BUSINESS, "")) }
        }
    }
    @Test fun delayedReviewAndDoubleSaveRetainTheCandidateAndSingleRecord() {
        var s = candidate()
        s = TripReducer.reduce(s, Action.SetPurpose(Purpose.BUSINESS, "처음"));s = TripReducer.reduce(s, Action.Review)
        s = TripReducer.reduce(s, Action.SetPurpose(Purpose.PERSONAL, "수정"));s = TripReducer.reduce(s, Action.Review)
        s = TripReducer.reduce(s, Action.Save)
        assertEquals(end, s.trips.single().endedAt);assertEquals(23_400L, s.trips.single().endOdometerM - s.trips.single().startOdometerM)
        assertEquals("수정", s.trips.single().note)
        val saved = s
        assertThrows(IllegalArgumentException::class.java) { TripReducer.reduce(saved, Action.Save) }
        assertEquals(1, saved.trips.size);assertEquals(1, saved.outbox.size)
    }
    @Test fun stoppingBeforeLateAckNeverRestartsCapture() {
        var s = TripReducer.reduce(queued(), Action.PrepareEvent("event", "body"))
        s = TripReducer.reduce(s, Action.StopCollection)
        s = TripReducer.reduce(s, Action.AcceptAck(SyncAck("event", 1, 1)))
        assertFalse(s.collecting);assertNull(s.activeTrip);assertTrue(s.trips.single().synced)
    }
}
