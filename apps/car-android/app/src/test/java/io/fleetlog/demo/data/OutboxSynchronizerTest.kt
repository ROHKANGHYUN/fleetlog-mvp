package io.fleetlog.demo.data

import io.fleetlog.demo.domain.*
import java.util.UUID
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class OutboxSynchronizerTest {
    private val start = "2026-11-15T01:00:00.000Z"
    private val end = "2026-11-15T01:30:00.000Z"
    private fun queued(): LocalSnapshot {
        var s = TripReducer.reduce(LocalSnapshot(), Action.StartCollection)
        s = TripReducer.reduce(s, Action.StartTrip(UUID.randomUUID().toString(), UUID.randomUUID().toString(), start))
        s = TripReducer.reduce(s, Action.SimulateMovement(end));s = TripReducer.reduce(s, Action.Park(end))
        return TripReducer.reduce(TripReducer.reduce(s, Action.Finish(end)), Action.Defer)
    }
    private fun ack(body: String): SyncAck {
        val json = JSONObject(body)
        return SyncAck(json.getString("eventId"), json.getInt("localRevision"), json.getInt("expectedServerVersion") + 1)
    }
    private class Fixture(initial: LocalSnapshot) {
        var current = initial
        var durable = initial
        var fail: (LocalSnapshot) -> Boolean = { false }
        var publications = 0
        val mutex = Mutex()
        val sent = mutableListOf<String>()
        var flight: String? = null
        fun engine(send: suspend (String) -> SyncAck = { body ->
            val json = JSONObject(body);SyncAck(json.getString("eventId"), json.getInt("localRevision"), json.getInt("expectedServerVersion") + 1)
        }) = OutboxSynchronizer({ current }, { next ->
            if (fail(next)) throw IllegalStateException("quota")
            LocalSnapshotCodec.validate(next);durable = next
        }, { next -> publications++;current = next }, mutex,
            { event, expected -> DevSyncClient().prepare(event, expected) },
            { body -> sent += body;send(body) }, { flight = it })
    }
    @Test fun failedPrepareNeverDispatchesOrPublishes() = runBlocking {
        val f = Fixture(queued());val before = f.current
        f.fail = { it.outbox.any { e -> e.preparedBody != null } }
        try { f.engine().run();fail("must reject") } catch (expected: IllegalStateException) { assertEquals("quota", expected.message) }
        assertEquals(before, f.current);assertEquals(before, f.durable);assertEquals(0, f.publications);assertTrue(f.sent.isEmpty());assertNull(f.flight)
    }
    @Test fun ackLocalCommitFailurePreservesPreparedBodyAndRecoversByIdenticalRetry() = runBlocking {
        val f = Fixture(queued());val engine = f.engine()
        f.fail = { it.receipts.isNotEmpty() }
        try { engine.run();fail("must reject") } catch (expected: IllegalStateException) { assertEquals("quota", expected.message) }
        assertEquals(1, f.current.outbox.size);assertFalse(f.current.trips.single().synced);assertTrue(f.current.receipts.isEmpty())
        assertEquals(f.current, f.durable)
        val prepared = f.current.outbox.single().preparedBody
        f.fail = { false };engine.run()
        assertEquals(prepared, f.sent[0]);assertEquals(f.sent[0], f.sent[1])
        assertEquals(1, f.current.trips.size);assertTrue(f.current.trips.single().synced);assertTrue(f.current.outbox.isEmpty())
    }
    @Test fun sameEngineIgnoresConcurrentRunsAndKeepsNewCorrectionUntilItsOwnAck() = runBlocking {
        val f = Fixture(queued());val firstEntered = CompletableDeferred<Unit>();val firstReply = CompletableDeferred<SyncAck>()
        val secondEntered = CompletableDeferred<Unit>();val secondReply = CompletableDeferred<SyncAck>()
        val engine = f.engine { body -> if (f.sent.size == 1) { firstEntered.complete(Unit);firstReply.await() } else { secondEntered.complete(Unit);secondReply.await() } }
        val run = async { engine.run() };firstEntered.await()
        assertTrue(engine.run().busy);assertEquals(1, f.sent.size)
        val id = f.current.trips.single().tripId
        f.mutex.withLock {
            var next = TripReducer.reduce(f.current, Action.EditTrip(id))
            next = TripReducer.reduce(next, Action.SetPurpose(Purpose.COMMUTE, "보완 중"));next = TripReducer.reduce(next, Action.Review)
            next = TripReducer.reduce(next, Action.Save);f.current = next;f.durable = next
        }
        assertNull(f.current.outbox.last().preparedBody)
        firstReply.complete(ack(f.sent.first()));secondEntered.await()
        assertEquals(1, f.current.trips.single().ackedLocalRevision);assertEquals(2, f.current.trips.single().localRevision)
        assertFalse(f.current.trips.single().synced);assertEquals(1, JSONObject(f.sent.last()).getInt("expectedServerVersion"))
        secondReply.complete(ack(f.sent.last()));run.await()
        assertEquals(2, f.current.trips.single().ackedLocalRevision);assertTrue(f.current.trips.single().synced)
    }
    @Test fun conflictHoldsDependentButAllowsIndependentTrip() = runBlocking {
        var initial = queued();val conflictId = initial.trips.single().tripId
        initial = TripReducer.reduce(initial, Action.EditTrip(conflictId))
        initial = TripReducer.reduce(initial, Action.SetPurpose(Purpose.PERSONAL, "보완"));initial = TripReducer.reduce(initial, Action.Review)
        initial = TripReducer.reduce(initial, Action.Save)
        initial = TripReducer.reduce(initial, Action.StartTrip(UUID.randomUUID().toString(), UUID.randomUUID().toString(), start))
        initial = TripReducer.reduce(initial, Action.SimulateMovement(end));initial = TripReducer.reduce(initial, Action.Park(end))
        initial = TripReducer.reduce(initial, Action.Finish(end));initial = TripReducer.reduce(initial, Action.Defer)
        val f = Fixture(initial)
        f.engine { body -> if (JSONObject(body).getString("tripId") == conflictId) throw SyncFailure(DeliveryStatus.CONFLICT, "409") else ack(body) }.run()
        assertEquals(2, f.sent.size);assertEquals(2, f.current.outbox.size)
        assertEquals(DeliveryStatus.CONFLICT, f.current.outbox.first().status)
        assertNull(f.current.outbox.last().preparedBody)
        assertTrue(f.current.trips.first { it.tripId != conflictId }.synced)
        assertFalse(f.current.trips.first { it.tripId == conflictId }.synced)
    }
    @Test fun transientFailureRetriesOnlyOnNextExplicitRunWithExactBody() = runBlocking {
        val f = Fixture(queued());var fail = true
        val engine = f.engine { body -> if (fail) { fail = false;throw java.net.SocketTimeoutException("timeout") } else ack(body) }
        assertEquals(1, engine.run().failed);assertEquals(1, f.sent.size)
        assertEquals(DeliveryStatus.QUEUED, f.current.outbox.single().status)
        engine.run();assertEquals(f.sent[0], f.sent[1]);assertTrue(f.current.trips.single().synced)
    }
}
