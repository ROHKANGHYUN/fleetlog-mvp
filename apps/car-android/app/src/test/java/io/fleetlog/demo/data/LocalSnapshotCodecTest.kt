package io.fleetlog.demo.data

import io.fleetlog.demo.domain.*
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class LocalSnapshotCodecTest {
    private val start = "2026-11-15T01:00:00.000Z"
    private val end = "2026-11-15T01:30:00.000Z"
    private fun queued(): LocalSnapshot {
        var s = TripReducer.reduce(LocalSnapshot(), Action.StartCollection)
        s = TripReducer.reduce(s, Action.StartTrip(UUID.randomUUID().toString(), UUID.randomUUID().toString(), start))
        s = TripReducer.reduce(s, Action.SimulateMovement(end));s = TripReducer.reduce(s, Action.Park(end))
        return TripReducer.reduce(TripReducer.reduce(s, Action.Finish(end)), Action.Defer)
    }
    private fun legacyRecord(r: TripRecord) = JSONObject().put("tripId", r.tripId).put("eventId", r.eventId)
        .put("startedAt", r.startedAt).put("endedAt", r.endedAt).put("startOdometerM", r.startOdometerM)
        .put("endOdometerM", r.endOdometerM).put("purpose", r.purpose?.wireValue ?: JSONObject.NULL)
        .put("note", r.note).put("quality", r.quality).put("boundaryReason", r.boundaryReason).put("synced", r.synced)
    private fun legacy(trips: List<TripRecord>) = JSONObject().put("version", 2).put("odometerM", 12_023_400)
        .put("parking", "PARKED").put("collecting", false).put("activeTrip", JSONObject.NULL)
        .put("trips", JSONArray(trips.map(::legacyRecord))).toString()

    @Test fun migratesVersionTwoWithoutChangingTripOrEventIdentifiersOrRawFields() {
        val first = queued().trips.single().copy(note = "미전송 원본")
        val second = first.copy(tripId = UUID.randomUUID().toString(), eventId = UUID.randomUUID().toString(), synced = true,
            purpose = Purpose.COMMUTE, note = "수신 원본", ackedLocalRevision = 1, serverVersion = 1)
        val raw = legacy(listOf(first, second))
        val migrated = LocalSnapshotCodec.decode(raw)
        assertEquals(listOf(first, second), migrated.trips)
        assertEquals(first.eventId, migrated.outbox.single().eventId)
        assertNull(migrated.outbox.single().preparedBody)
        assertEquals(SyncAck(second.eventId, 1, 1), migrated.receipts[second.eventId])
        assertEquals(2, JSONObject(raw).getInt("version"))
        val v3 = LocalSnapshotCodec.encode(migrated)
        assertEquals(3, JSONObject(v3).getInt("version"))
        assertEquals(migrated, LocalSnapshotCodec.decode(v3))
    }
    @Test fun exactPreparedBodySurvivesRoundTripAndNumericJsonRepresentation() {
        var s = queued()
        val event = s.outbox.single()
        val client = DevSyncClient()
        val body = client.prepare(event, 0)
        s = TripReducer.reduce(s, Action.PrepareEvent(event.eventId, body))
        val restored = LocalSnapshotCodec.decode(LocalSnapshotCodec.encode(s))
        assertEquals(body, restored.outbox.single().preparedBody)
        assertEquals(body, client.prepare(restored.outbox.single(), 0))
        val request = JSONObject(body)
        assertEquals(1, request.getInt("localRevision"));assertEquals(0, request.getInt("expectedServerVersion"))
        assertEquals("mock", request.getString("source"));assertTrue(request.getJSONObject("payload").isNull("purpose"))
        assertEquals(23_400L, request.getJSONObject("payload").getLong("endOdometerM") - request.getJSONObject("payload").getLong("startOdometerM"))
    }
    @Test fun migratedUnsentEventCanReceiveItsOriginalVersionOneAck() {
        val original = queued().trips.single()
        var s = LocalSnapshotCodec.decode(legacy(listOf(original)))
        val client = DevSyncClient();val event = s.outbox.single()
        s = TripReducer.reduce(s, Action.PrepareEvent(event.eventId, client.prepare(event, 0)))
        s = TripReducer.reduce(s, Action.AcceptAck(SyncAck(event.eventId, 1, 1)))
        assertEquals(original.tripId, s.trips.single().tripId);assertTrue(s.trips.single().synced)
        assertEquals(s, LocalSnapshotCodec.decode(LocalSnapshotCodec.encode(s)))
    }
    @Test fun pendingRevisionChainKeepsPreparedOldPayloadAndUnpreparedCorrection() {
        var s = queued();val client = DevSyncClient();val first = s.outbox.single()
        s = TripReducer.reduce(s, Action.PrepareEvent(first.eventId, client.prepare(first, 0)))
        s = TripReducer.reduce(s, Action.EditTrip(first.tripId))
        s = TripReducer.reduce(s, Action.SetPurpose(Purpose.BUSINESS, "목적 보완"));s = TripReducer.reduce(s, Action.Review)
        s = TripReducer.reduce(s, Action.Save)
        val restored = LocalSnapshotCodec.decode(LocalSnapshotCodec.encode(s))
        assertEquals(2, restored.outbox.size);assertNull(restored.outbox.last().preparedBody)
        assertEquals(first.eventId, restored.outbox.last().predecessorEventId)
        assertNull(restored.outbox.first().payload.purpose)
        assertEquals(Purpose.BUSINESS, restored.trips.single().purpose)
        assertThrows(IllegalArgumentException::class.java) { TripReducer.expectedVersion(restored, restored.outbox.last()) }
    }
    @Test fun corruptLatestPayloadPreparedBodyAndReferencesAreRejectedWithoutRepairingInput() {
        val valid = LocalSnapshotCodec.encode(queued())
        for (corrupt in listOf<(JSONObject) -> Unit>(
            { it.getJSONArray("outbox").getJSONObject(0).getJSONObject("payload").put("note", "다른 메모") },
            { it.getJSONArray("outbox").getJSONObject(0).put("tripId", "different-trip") },
            { it.getJSONArray("trips").getJSONObject(0).put("quality", "inferred-valid") },
            { it.getJSONArray("outbox").getJSONObject(0).put("preparedBody", "{}") },
        )) {
            val damaged = JSONObject(valid);corrupt(damaged);val bytes = damaged.toString()
            assertThrows(Exception::class.java) { LocalSnapshotCodec.decode(bytes) }
            assertEquals(bytes, damaged.toString())
        }
    }
    @Test fun recoveryAndBlockedEventsRoundTripWithoutResumingOrChangingEventIdentity() {
        var s = queued();val id = s.outbox.single().eventId
        s = TripReducer.reduce(s, Action.FailEvent(id, DeliveryStatus.BLOCKED, "HTTP 403"))
        val recovered = TripReducer.recover(LocalSnapshotCodec.decode(LocalSnapshotCodec.encode(s)))
        assertFalse(recovered.collecting);assertEquals(ParkingState.UNKNOWN, recovered.parking)
        assertEquals(UxRestrictionState.UNKNOWN, recovered.uxRestrictions)
        assertEquals(id, recovered.outbox.single().eventId);assertEquals(DeliveryStatus.BLOCKED, recovered.outbox.single().status)
        assertNull(TripReducer.nextEvent(recovered))
    }
    @Test fun fractionalStringNegativeAndOverflowAcknowledgementVersionsAreNotCoerced() {
        for (bad in listOf<Any>(1.5, "1", -1, 0, 2147483648L)) {
            for (field in listOf("ackedLocalRevision", "serverVersion")) {
                val json = JSONObject().put("eventId", "event").put("ackedLocalRevision", 1).put("serverVersion", 1).put(field, bad)
                assertThrows(IllegalArgumentException::class.java) { DevSyncClient.parseAck(json) }
            }
        }
        assertEquals(SyncAck("event", 1, 1), DevSyncClient.parseAck(JSONObject("{\"eventId\":\"event\",\"ackedLocalRevision\":1,\"serverVersion\":1}")))
    }
    @Test fun wrongPrimitiveOrNullableObjectTypesAndMissingFieldsNeverSilentlyNormalize() {
        val valid = LocalSnapshotCodec.encode(queued())
        for (corrupt in listOf<(JSONObject) -> Unit>(
            { it.put("odometerM", 12_023_400.5) },
            { it.put("odometerM", "12023400") },
            { it.put("collecting", "false") },
            { it.put("activeTrip", "not an object") },
            { it.put("input", "not an object") },
            { it.remove("input") },
            { it.getJSONArray("trips").getJSONObject(0).put("localRevision", 1.5) },
            { it.getJSONArray("trips").getJSONObject(0).put("note", 123) },
            { it.getJSONArray("trips").getJSONObject(0).remove("purpose") },
            { it.getJSONArray("outbox").getJSONObject(0).put("attempts", "0") },
            { it.getJSONArray("outbox").getJSONObject(0).remove("preparedBody") },
        )) {
            val json = JSONObject(valid);corrupt(json);val bytes = json.toString()
            assertThrows(Exception::class.java) { LocalSnapshotCodec.decode(bytes) }
            assertEquals(bytes, json.toString())
        }
        for (bad in listOf<Any>("12023400", 12_023_400.5)) {
            val json = JSONObject(legacy(queued().trips)).put("odometerM", bad)
            assertThrows(IllegalArgumentException::class.java) { LocalSnapshotCodec.decode(json.toString()) }
        }
    }
}
