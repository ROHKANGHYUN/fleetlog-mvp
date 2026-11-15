package io.fleetlog.demo.data

import io.fleetlog.demo.domain.*
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

class SyncFailure(val disposition: DeliveryStatus, message: String, cause: Throwable? = null) : Exception(message, cause)

/** Wire schema v1 is unchanged. Only explicitly mock data may enter this transport. */
class DevSyncClient(private val endpoint: String = "http://10.0.2.2:4000/api/trip-events") {
    init {
        val url = URL(endpoint)
        require(url.protocol == "http" && url.host in setOf("10.0.2.2", "127.0.0.1", "localhost") &&
            url.path == "/api/trip-events" && url.userInfo == null && url.query == null) { "로컬 mock 개발 서버만 사용할 수 있습니다." }
    }

    fun prepare(event: OutboxEvent, expectedServerVersion: Int): String {
        if (event.preparedBody != null) {
            validatePrepared(event, event.preparedBody, expectedServerVersion)
            return event.preparedBody
        }
        require(expectedServerVersion >= 0)
        val trip = event.payload
        return JSONObject().put("schemaVersion", 1).put("eventType", "TRIP_UPSERT")
            .put("eventId", event.eventId).put("tripId", event.tripId)
            .put("localRevision", event.localRevision).put("expectedServerVersion", expectedServerVersion).put("source", "mock")
            .put("payload", payload(trip)).toString()
    }

    suspend fun send(preparedBody: String): SyncAck = withContext(Dispatchers.IO) {
        val request = JSONObject(preparedBody)
        val connection = URL(endpoint).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "POST"
            connection.connectTimeout = 5_000;connection.readTimeout = 5_000
            connection.instanceFollowRedirects = false;connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            connection.setRequestProperty("X-FleetLog-Dev", "local-only")
            connection.outputStream.use { it.write(preparedBody.toByteArray(Charsets.UTF_8)) }
            val status = connection.responseCode
            if (status !in 200..299) {
                val disposition = when {
                    status == 409 -> DeliveryStatus.CONFLICT
                    status in 400..499 && status !in setOf(408, 429) -> DeliveryStatus.BLOCKED
                    else -> DeliveryStatus.QUEUED
                }
                throw SyncFailure(disposition, "서버 응답 HTTP $status. 기록과 준비 본문을 보존했습니다.")
            }
            val body = connection.inputStream.use { it.readBytes().toString(Charsets.UTF_8) }
            val json = try { JSONObject(body) } catch (e: Exception) {
                throw SyncFailure(DeliveryStatus.BLOCKED, "서버 성공 응답의 JSON을 확인해야 합니다.", e)
            }
            val ack = try { parseAck(json) }
                catch (e: Exception) { throw SyncFailure(DeliveryStatus.QUEUED, "서버 ACK 필드가 올바르지 않습니다. 확인 후 같은 이벤트로 재시도하세요.", e) }
            if (ack.eventId != request.getString("eventId") || ack.ackedLocalRevision != strictInt(request, "localRevision", 1) ||
                ack.serverVersion != Math.addExact(strictInt(request, "expectedServerVersion"), 1)) {
                throw SyncFailure(DeliveryStatus.QUEUED, "서버 ACK의 이벤트/리비전/버전이 일치하지 않습니다. 수신 완료로 표시하지 않습니다.")
            }
            ack
        } finally { connection.disconnect() }
    }

    companion object {
        private fun strictInt(json: JSONObject, key: String, minimum: Int = 0): Int {
            val value = json.get(key)
            require(value is Int || value is Long) { "$key 필드는 정수여야 합니다." }
            val number = (value as Number).toLong()
            require(number in minimum.toLong()..Int.MAX_VALUE.toLong())
            return number.toInt()
        }
        fun parseAck(json: JSONObject): SyncAck {
            require(json.keys().asSequence().toSet() == setOf("eventId", "ackedLocalRevision", "serverVersion"))
            return SyncAck(json.getString("eventId"), strictInt(json, "ackedLocalRevision", 1), strictInt(json, "serverVersion", 1))
        }
        fun payload(trip: TripRecord): JSONObject = JSONObject()
            .put("vehicleId", "demo-car-001").put("driverId", "demo-driver-001")
            .put("startedAt", trip.startedAt).put("endedAt", trip.endedAt)
            .put("startOdometerM", trip.startOdometerM).put("endOdometerM", trip.endOdometerM)
            .put("purpose", trip.purpose?.wireValue ?: JSONObject.NULL).put("note", trip.note).put("quality", trip.quality)

        fun validatePrepared(event: OutboxEvent, body: String, expectedServerVersion: Int) {
            val json = JSONObject(body)
            require(json.keys().asSequence().toSet() == setOf("schemaVersion", "eventType", "eventId", "tripId", "localRevision", "expectedServerVersion", "source", "payload"))
            require(strictInt(json, "schemaVersion", 1) == 1 && json.getString("eventType") == "TRIP_UPSERT" && json.getString("source") == "mock")
            require(json.getString("eventId") == event.eventId && json.getString("tripId") == event.tripId &&
                strictInt(json, "localRevision", 1) == event.localRevision && strictInt(json, "expectedServerVersion") == expectedServerVersion)
            val actual = json.getJSONObject("payload")
            val expected = payload(event.payload)
            require(actual.keys().asSequence().toSet() == expected.keys().asSequence().toSet() && actual.keys().asSequence().toSet().all {
                val a = actual.get(it)
                val b = expected.get(it)
                if (a is Number && b is Number) a.toString().toBigDecimal().compareTo(b.toString().toBigDecimal()) == 0 else a == b
            }) { "준비 본문과 전송 대기 기록이 다릅니다." }
        }
    }
}
