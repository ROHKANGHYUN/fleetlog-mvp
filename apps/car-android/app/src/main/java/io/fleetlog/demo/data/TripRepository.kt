package io.fleetlog.demo.data

import android.util.AtomicFile
import io.fleetlog.demo.domain.*
import java.io.File
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

interface TripRepository {
    suspend fun load(): LocalSnapshot
    suspend fun save(snapshot: LocalSnapshot)
}

/** Migration is read-only until the caller durably commits the complete recovered state. */
object LocalSnapshotCodec {
    private fun required(json: JSONObject, key: String): Any {
        require(json.has(key)) { "누락된 로컬 필드: $key" }
        return json.get(key)
    }
    private fun string(json: JSONObject, key: String): String {
        val value = required(json, key)
        require(value is String) { "$key 필드는 문자열이어야 합니다." }
        return value
    }
    private fun boolean(json: JSONObject, key: String): Boolean {
        val value = required(json, key)
        require(value is Boolean) { "$key 필드는 Boolean이어야 합니다." }
        return value
    }
    private fun long(json: JSONObject, key: String): Long {
        val value = required(json, key)
        require(value is Int || value is Long) { "$key 필드는 정수여야 합니다." }
        return (value as Number).toLong()
    }
    private fun int(json: JSONObject, key: String): Int {
        val value = long(json, key)
        require(value in Int.MIN_VALUE.toLong()..Int.MAX_VALUE.toLong())
        return value.toInt()
    }
    private fun nullableString(json: JSONObject, key: String): String? {
        val value = required(json, key)
        if (value === JSONObject.NULL) return null
        require(value is String) { "$key 필드는 문자열 또는 null이어야 합니다." }
        return value
    }
    private fun nullableLong(json: JSONObject, key: String): Long? =
        if (required(json, key) === JSONObject.NULL) null else long(json, key)
    private fun nullableObject(json: JSONObject, key: String): JSONObject? {
        val value = required(json, key)
        if (value === JSONObject.NULL) return null
        require(value is JSONObject) { "$key 필드는 객체 또는 null이어야 합니다." }
        return value
    }
    private fun records(array: JSONArray, version: Int) = (0 until array.length()).map { record(array.getJSONObject(it), version) }
    private fun record(r: JSONObject, version: Int): TripRecord {
        val synced = boolean(r, "synced")
        return TripRecord(string(r, "tripId"), string(r, "eventId"), string(r, "startedAt"), string(r, "endedAt"),
            long(r, "startOdometerM"), long(r, "endOdometerM"),
            nullableString(r, "purpose")?.let { value -> Purpose.entries.first { it.wireValue == value } },
            string(r, "note"), string(r, "quality"), string(r, "boundaryReason"), synced,
            if (version == 2) 1 else int(r, "localRevision"),
            if (version == 2) if (synced) 1 else 0 else int(r, "ackedLocalRevision"),
            if (version == 2) if (synced) 1 else 0 else int(r, "serverVersion"))
    }
    private fun recordJson(r: TripRecord) = JSONObject().put("tripId", r.tripId).put("eventId", r.eventId)
        .put("startedAt", r.startedAt).put("endedAt", r.endedAt).put("startOdometerM", r.startOdometerM).put("endOdometerM", r.endOdometerM)
        .put("purpose", r.purpose?.wireValue ?: JSONObject.NULL).put("note", r.note).put("quality", r.quality)
        .put("boundaryReason", r.boundaryReason).put("synced", r.synced).put("localRevision", r.localRevision)
        .put("ackedLocalRevision", r.ackedLocalRevision).put("serverVersion", r.serverVersion)

    fun decode(raw: String): LocalSnapshot {
        val json = JSONObject(raw);val version = int(json, "version")
        require(version in setOf(2, 3)) { "지원하지 않는 로컬 저장 형식입니다. 원본을 보존했습니다." }
        val odometer = long(json, "odometerM")
        val draft = nullableObject(json, "activeTrip")?.let {
            val end = nullableString(it, "candidateEndedAt")
            TripDraft(string(it, "tripId"), string(it, "eventId"), string(it, "startedAt"), long(it, "startOdometerM"),
                string(it, "lastObservedAt"), boolean(it, "gap"), end,
                if (version == 2) if (end == null) null else odometer else nullableLong(it, "candidateEndOdometerM"))
        }
        val trips = records(json.getJSONArray("trips"), version)
        val receipts = if (version == 2) trips.filter { it.synced }.associate { it.eventId to SyncAck(it.eventId, 1, 1) } else {
            val stored = json.getJSONObject("receipts")
            stored.keys().asSequence().associateWith { id -> val ack = stored.getJSONObject(id)
                SyncAck(string(ack, "eventId"), int(ack, "ackedLocalRevision"), int(ack, "serverVersion")) }
        }
        val outbox = if (version == 2) trips.filterNot { it.synced }.map {
            OutboxEvent(it.eventId, it.tripId, 1, 0, null, it)
        } else {
            val array = json.getJSONArray("outbox")
            (0 until array.length()).map { i -> val e = array.getJSONObject(i)
                OutboxEvent(string(e, "eventId"), string(e, "tripId"), int(e, "localRevision"), int(e, "baseServerVersion"),
                    nullableString(e, "predecessorEventId"), record(e.getJSONObject("payload"), 3), nullableString(e, "preparedBody"),
                    DeliveryStatus.valueOf(string(e, "status")), nullableString(e, "lastError"), int(e, "attempts")) }
        }
        val input = if (version == 2) draft?.candidateEndedAt?.let { TripInput() } else nullableObject(json, "input")?.let {
            TripInput(nullableString(it, "purpose")?.let { value -> Purpose.entries.first { it.wireValue == value } }, string(it, "note")) }
        return LocalSnapshot(odometer, ParkingState.valueOf(string(json, "parking")), boolean(json, "collecting"), draft, trips,
            outbox, receipts, if (version == 2) null else nullableString(json, "editingTripId"), input,
            version == 3 && boolean(json, "reviewing"), if (version == 2) UxRestrictionState.UNKNOWN else UxRestrictionState.valueOf(string(json, "uxRestrictions")))
            .also(::validate)
    }

    fun encode(snapshot: LocalSnapshot): String {
        validate(snapshot)
        val json = JSONObject().put("version", 3).put("odometerM", snapshot.odometerM).put("parking", snapshot.parking.name)
            .put("collecting", snapshot.collecting).put("uxRestrictions", snapshot.uxRestrictions.name)
            .put("editingTripId", snapshot.editingTripId ?: JSONObject.NULL).put("reviewing", snapshot.reviewing)
        json.put("activeTrip", snapshot.activeTrip?.let { JSONObject().put("tripId", it.tripId).put("eventId", it.eventId)
            .put("startedAt", it.startedAt).put("startOdometerM", it.startOdometerM).put("lastObservedAt", it.lastObservedAt)
            .put("gap", it.gap).put("candidateEndedAt", it.candidateEndedAt ?: JSONObject.NULL)
            .put("candidateEndOdometerM", it.candidateEndOdometerM ?: JSONObject.NULL) } ?: JSONObject.NULL)
        json.put("input", snapshot.input?.let { JSONObject().put("purpose", it.purpose?.wireValue ?: JSONObject.NULL).put("note", it.note) } ?: JSONObject.NULL)
        json.put("trips", JSONArray(snapshot.trips.map(::recordJson)))
        json.put("outbox", JSONArray(snapshot.outbox.map { e -> JSONObject().put("eventId", e.eventId).put("tripId", e.tripId)
            .put("localRevision", e.localRevision).put("baseServerVersion", e.baseServerVersion)
            .put("predecessorEventId", e.predecessorEventId ?: JSONObject.NULL).put("payload", recordJson(e.payload))
            .put("preparedBody", e.preparedBody ?: JSONObject.NULL).put("status", e.status.name)
            .put("lastError", e.lastError ?: JSONObject.NULL).put("attempts", e.attempts) }))
        json.put("receipts", JSONObject().also { stored -> snapshot.receipts.forEach { (id, ack) ->
            stored.put(id, JSONObject().put("eventId", ack.eventId).put("ackedLocalRevision", ack.ackedLocalRevision).put("serverVersion", ack.serverVersion)) } })
        return json.toString()
    }

    fun validate(s: LocalSnapshot) {
        require(s.odometerM >= 0 && s.trips.map { it.tripId }.distinct().size == s.trips.size)
        s.trips.forEach { r ->
            require(r.tripId.isNotBlank() && r.eventId.isNotBlank() && r.startOdometerM >= 0 && r.endOdometerM > r.startOdometerM && r.note.length <= 120)
            require(r.quality in setOf("valid", "gap") && Instant.parse(r.endedAt) >= Instant.parse(r.startedAt))
            require(r.localRevision > 0 && r.ackedLocalRevision in 0..r.localRevision && r.serverVersion >= 0 && r.synced == (r.ackedLocalRevision >= r.localRevision))
            require((r.ackedLocalRevision == 0) == (r.serverVersion == 0))
        }
        require(s.outbox.map { it.eventId }.distinct().size == s.outbox.size)
        require(s.outbox.map { it.tripId to it.localRevision }.distinct().size == s.outbox.size)
        val previous = mutableMapOf<String, OutboxEvent>()
        s.outbox.forEach { e ->
            val r = requireNotNull(s.trips.find { it.tripId == e.tripId })
            require(e.eventId == e.payload.eventId && e.tripId == e.payload.tripId && e.localRevision == e.payload.localRevision &&
                e.localRevision > r.ackedLocalRevision && e.localRevision <= r.localRevision && e.baseServerVersion >= 0 && e.attempts >= 0)
            require(e.payload.copy(eventId = r.eventId, purpose = r.purpose, note = r.note, synced = r.synced,
                localRevision = r.localRevision, ackedLocalRevision = r.ackedLocalRevision, serverVersion = r.serverVersion) == r) { "원본 운행 필드가 다릅니다." }
            if (e.localRevision == r.localRevision) require(e.payload.purpose == r.purpose && e.payload.note == r.note)
            e.predecessorEventId?.let { id ->
                require(previous[id]?.let { it.tripId == e.tripId && it.localRevision < e.localRevision } == true || s.receipts[id]?.ackedLocalRevision?.let { it < e.localRevision } == true)
            }
            e.preparedBody?.let { DevSyncClient.validatePrepared(e, it, TripReducer.expectedVersion(s, e)) }
            require(!s.receipts.containsKey(e.eventId));previous[e.eventId] = e
        }
        s.trips.filterNot { it.synced }.forEach { r -> require(s.outbox.any { it.tripId == r.tripId && it.localRevision == r.localRevision }) }
        s.receipts.forEach { (id, ack) -> require(id == ack.eventId && ack.ackedLocalRevision > 0 && ack.serverVersion > 0) }
        s.activeTrip?.let { d ->
            require(s.collecting && d.tripId.isNotBlank() && d.eventId.isNotBlank() && d.startOdometerM in 0..s.odometerM)
            require(Instant.parse(d.lastObservedAt) >= Instant.parse(d.startedAt))
            require((d.candidateEndedAt == null) == (d.candidateEndOdometerM == null))
            d.candidateEndedAt?.let { require(Instant.parse(it) >= Instant.parse(d.startedAt));require(d.candidateEndOdometerM!! in d.startOdometerM..s.odometerM) }
        }
        require(s.editingTripId == null || s.trips.any { it.tripId == s.editingTripId })
        require(!s.reviewing || s.input?.purpose != null)
        require(s.input == null || (s.input.note.length <= 120 && (s.editingTripId != null || s.activeTrip?.candidateEndedAt != null)))
    }
}

/** Existing app-private filename and AtomicFile replacement remain unchanged. */
class JsonTripRepository(directory: File) : TripRepository {
    private val file = AtomicFile(File(directory, "fleetlog-demo-v1.json"))
    override suspend fun load(): LocalSnapshot = withContext(Dispatchers.IO) {
        if (!file.baseFile.exists() && !File(file.baseFile.path + ".bak").exists()) return@withContext LocalSnapshot()
        LocalSnapshotCodec.decode(file.openRead().use { it.readBytes().toString(Charsets.UTF_8) })
    }
    override suspend fun save(snapshot: LocalSnapshot) = withContext(Dispatchers.IO) {
        val bytes = LocalSnapshotCodec.encode(snapshot).toByteArray(Charsets.UTF_8)
        val stream = file.startWrite()
        try { stream.write(bytes);file.finishWrite(stream) }
        catch (e: Exception) { file.failWrite(stream);throw e }
    }
}
