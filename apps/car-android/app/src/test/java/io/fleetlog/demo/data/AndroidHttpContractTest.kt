package io.fleetlog.demo.data

import io.fleetlog.demo.domain.*
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** Real Kotlin wire transport -> independent HTTP -> real temporary SQLite -> admin GET. */
class AndroidHttpContractTest {
    private val now = "2026-11-15T01:00:00.000Z"
    private fun uuid() = UUID.randomUUID().toString()
    private fun withServer(block: (String) -> Unit) {
        val root = File(requireNotNull(System.getProperty("fleetlog.repoRoot")))
        val process = ProcessBuilder("node", File(root, "tests/fixtures/android-api-server.mjs").absolutePath)
            .directory(root).redirectError(ProcessBuilder.Redirect.INHERIT).start()
        try {
            val address = JSONObject(process.inputStream.bufferedReader().readLine()).getString("address")
            block(address)
        } finally {
            process.outputStream.close()
            if (!process.waitFor(10, TimeUnit.SECONDS)) { process.destroy(); process.waitFor(5, TimeUnit.SECONDS) }
            assertFalse("Only the fixture HTTP process must be stopped", process.isAlive)
        }
    }
    private fun get(address: String, path: String): JSONObject {
        val connection = URL(address + path).openConnection() as HttpURLConnection
        try {
            connection.setRequestProperty("X-FleetLog-Dev", "local-only")
            connection.connectTimeout = 5000; connection.readTimeout = 5000
            assertEquals(200, connection.responseCode)
            return JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
        } finally { connection.disconnect() }
    }
    private fun leg(): LocalSnapshot {
        var s = TripReducer.reduce(LocalSnapshot(), Action.Park(now))
        s = TripReducer.reduce(s, Action.StartCollection)
        s = TripReducer.reduce(s, Action.StartTrip(uuid(), uuid(), now))
        s = TripReducer.reduce(s, Action.SimulateMovement(now))
        s = TripReducer.reduce(s, Action.Park(now))
        s = TripReducer.reduce(s, Action.Finish(now))
        return TripReducer.reduce(s, Action.Defer)
    }
    @Test fun unconfirmedRetryAndCorrectionMatchTheRealServerContract() = withServer { address -> runBlocking {
        val client = DevSyncClient("$address/api/trip-events")
        var s = leg()
        val original = s.trips.single()
        assertEquals(0, get(address, "/api/trips").getJSONArray("trips").length())
        val event = requireNotNull(TripReducer.nextEvent(s))
        val body = client.prepare(event, TripReducer.expectedVersion(s, event))
        s = TripReducer.reduce(s, Action.PrepareEvent(event.eventId, body))
        // Roundtrip before sending models process loss and retains exact prepared text.
        s = LocalSnapshotCodec.decode(LocalSnapshotCodec.encode(s))
        val persistedEvent = s.outbox.single()
        assertEquals(body, client.prepare(persistedEvent, TripReducer.expectedVersion(s, persistedEvent)))
        val firstAck = client.send(body)
        // Response loss / local ACK save failure: replay before accepting it locally.
        assertEquals(firstAck, client.send(body))
        val received = get(address, "/api/trips").getJSONArray("trips")
        assertEquals(1, received.length())
        assertTrue(received.getJSONObject(0).getJSONObject("payload").isNull("purpose"))
        assertEquals(1, get(address, "/api/exceptions").getJSONArray("trips").length())
        s = TripReducer.reduce(s, Action.AcceptAck(firstAck))
        s = TripReducer.reduce(s, Action.EditTrip(original.tripId))
        s = TripReducer.reduce(s, Action.SetPurpose(Purpose.COMMUTE, "Android Kotlin HTTP 보완"))
        s = TripReducer.reduce(s, Action.Review)
        s = TripReducer.reduce(s, Action.Save)
        val amendment = requireNotNull(TripReducer.nextEvent(s))
        assertEquals(1, TripReducer.expectedVersion(s, amendment))
        val revisedBody = client.prepare(amendment, TripReducer.expectedVersion(s, amendment))
        s = TripReducer.reduce(s, Action.PrepareEvent(amendment.eventId, revisedBody))
        s = TripReducer.reduce(s, Action.AcceptAck(client.send(revisedBody)))
        assertTrue(s.outbox.isEmpty())
        val latest = get(address, "/api/trips").getJSONArray("trips")
        assertEquals(1, latest.length())
        assertEquals(original.tripId, latest.getJSONObject(0).getString("tripId"))
        assertEquals(2, latest.getJSONObject(0).getInt("serverVersion"))
        val payload = latest.getJSONObject(0).getJSONObject("payload")
        assertEquals("commute", payload.getString("purpose"))
        assertEquals(original.startedAt, payload.getString("startedAt"))
        assertEquals(original.endedAt, payload.getString("endedAt"))
        assertEquals(original.endOdometerM, payload.getLong("endOdometerM"))
        assertEquals(0, get(address, "/api/exceptions").getJSONArray("trips").length())
    } }

    @Test fun aRecoveredGapStaysAnAdminExceptionAfterPurposeCorrection() = withServer { address -> runBlocking {
        val client = DevSyncClient("$address/api/trip-events")
        var s = TripReducer.reduce(LocalSnapshot(), Action.StartCollection)
        s = TripReducer.reduce(s, Action.StartTrip(uuid(), uuid(), now))
        s = TripReducer.reduce(s, Action.SimulateMovement(now))
        s = TripReducer.recover(s)
        val original = s.trips.single()
        assertEquals("gap", original.quality)
        suspend fun sendNext() {
            val event = requireNotNull(TripReducer.nextEvent(s))
            val body = client.prepare(event, TripReducer.expectedVersion(s, event))
            s = TripReducer.reduce(s, Action.PrepareEvent(event.eventId, body))
            s = TripReducer.reduce(s, Action.AcceptAck(client.send(body)))
        }
        sendNext()
        assertEquals(1, get(address, "/api/exceptions").getJSONArray("trips").length())
        s = TripReducer.reduce(s, Action.Park(now))
        s = TripReducer.reduce(s, Action.EditTrip(original.tripId))
        s = TripReducer.reduce(s, Action.SetPurpose(Purpose.BUSINESS, "gap 용도 보완"))
        s = TripReducer.reduce(s, Action.Review)
        s = TripReducer.reduce(s, Action.Save)
        sendNext()
        val list = get(address, "/api/trips").getJSONArray("trips")
        assertEquals(1, list.length())
        assertEquals(2, list.getJSONObject(0).getInt("serverVersion"))
        assertEquals("gap", list.getJSONObject(0).getJSONObject("payload").getString("quality"))
        assertEquals(original.endedAt, list.getJSONObject(0).getJSONObject("payload").getString("endedAt"))
        assertEquals(1, get(address, "/api/exceptions").getJSONArray("trips").length())
        val summary = get(address, "/api/review-summary")
        assertEquals(1, summary.getInt("receivedCount"))
        assertEquals(0, summary.getInt("unconfirmedCount"))
        assertEquals(1, summary.getInt("invalidDistanceCount"))
        assertFalse(summary.getBoolean("readyForPurposeReview"))
    } }
}
