package io.fleetlog.demo.domain

import java.util.UUID

enum class ParkingState { PARKED, DRIVING, UNKNOWN }
enum class UxRestrictionState { UNRESTRICTED, RESTRICTED, UNKNOWN }
enum class Purpose(val wireValue: String, val label: String) {
    BUSINESS("business", "일반 업무"), COMMUTE("commute", "출퇴근"), PERSONAL("personal", "개인 용도")
}
enum class DeliveryStatus { QUEUED, CONFLICT, BLOCKED }
data class TripInput(val purpose: Purpose? = null, val note: String = "")
data class SyncAck(val eventId: String, val ackedLocalRevision: Int, val serverVersion: Int)

data class TripDraft(
    val tripId: String, val eventId: String, val startedAt: String, val startOdometerM: Long,
    val lastObservedAt: String, val gap: Boolean = false, val candidateEndedAt: String? = null,
    val candidateEndOdometerM: Long? = null,
)

data class TripRecord(
    val tripId: String, val eventId: String, val startedAt: String, val endedAt: String,
    val startOdometerM: Long, val endOdometerM: Long, val purpose: Purpose?, val note: String,
    val quality: String, val boundaryReason: String, val synced: Boolean = false,
    val localRevision: Int = 1, val ackedLocalRevision: Int = if (synced) 1 else 0,
    val serverVersion: Int = if (synced) 1 else 0,
)

data class OutboxEvent(
    val eventId: String, val tripId: String, val localRevision: Int, val baseServerVersion: Int,
    val predecessorEventId: String?, val payload: TripRecord, val preparedBody: String? = null,
    val status: DeliveryStatus = DeliveryStatus.QUEUED, val lastError: String? = null,
    val attempts: Int = 0,
)

data class LocalSnapshot(
    val odometerM: Long = 12_000_000,
    val parking: ParkingState = ParkingState.PARKED,
    val collecting: Boolean = false,
    val activeTrip: TripDraft? = null,
    val trips: List<TripRecord> = emptyList(),
    val outbox: List<OutboxEvent> = emptyList(),
    val receipts: Map<String, SyncAck> = emptyMap(),
    val editingTripId: String? = null,
    val input: TripInput? = null,
    val reviewing: Boolean = false,
    val uxRestrictions: UxRestrictionState = UxRestrictionState.UNRESTRICTED,
)

sealed interface Action {
    data object StartCollection : Action
    data object StopCollection : Action
    data object InterruptCollection : Action
    data class StartTrip(val id: String, val eventId: String, val now: String) : Action
    data class SimulateMovement(val now: String, val meters: Long = 23_400) : Action
    data class Park(val now: String) : Action
    data class ResumeDriving(val now: String) : Action
    data class Finish(val now: String) : Action
    data class Confirm(val purpose: Purpose, val note: String) : Action
    data object Defer : Action
    data class EditTrip(val tripId: String) : Action
    data class SetPurpose(val purpose: Purpose?, val note: String) : Action
    data object Review : Action
    data object Save : Action
    data object CancelInput : Action
    data class UpdateVehicleState(val parking: ParkingState, val uxRestrictions: UxRestrictionState) : Action
    data class PrepareEvent(val eventId: String, val body: String) : Action
    data class AcceptAck(val ack: SyncAck) : Action
    data class FailEvent(val eventId: String, val status: DeliveryStatus, val message: String) : Action
    // Retained only as a source-compatible legacy symbol; an ID alone is not an ACK.
    data class MarkSynced(val eventIds: Set<String>) : Action
}

/** Pure state transitions. Callers persist next state before publishing it. */
object TripReducer {
    fun inputAllowed(s: LocalSnapshot) = s.parking == ParkingState.PARKED &&
        s.uxRestrictions == UxRestrictionState.UNRESTRICTED
    private fun requireParked(s: LocalSnapshot) {
        require(inputAllowed(s)) { "주차와 UX 제한 해제 상태를 확인한 뒤 입력할 수 있습니다." }
    }
    fun nextEvent(s: LocalSnapshot): OutboxEvent? = s.outbox.firstOrNull {
        it.status == DeliveryStatus.QUEUED && (it.predecessorEventId == null || s.receipts.containsKey(it.predecessorEventId))
    }
    fun expectedVersion(s: LocalSnapshot, e: OutboxEvent): Int = e.predecessorEventId?.let {
        requireNotNull(s.receipts[it]) { "선행 변경의 ACK를 먼저 확인해야 합니다." }.serverVersion
    } ?: e.baseServerVersion

    private fun append(s: LocalSnapshot, record: TripRecord): LocalSnapshot {
        val predecessor = s.outbox.lastOrNull { it.tripId == record.tripId }
        val event = OutboxEvent(record.eventId, record.tripId, record.localRevision,
            record.serverVersion, predecessor?.eventId, record)
        return s.copy(trips = s.trips.filterNot { it.tripId == record.tripId } + record,
            outbox = s.outbox + event, editingTripId = null, input = null, reviewing = false)
    }
    private fun queue(s: LocalSnapshot, purpose: Purpose?, note: String, endedAt: String,
                      gap: Boolean, reason: String): LocalSnapshot {
        val draft = requireNotNull(s.activeTrip)
        val end = draft.candidateEndOdometerM ?: s.odometerM
        require(end > draft.startOdometerM) { "0km 또는 역전된 거리는 저장할 수 없습니다." }
        require(note.length <= 120)
        val record = TripRecord(draft.tripId, draft.eventId, draft.startedAt, endedAt,
            draft.startOdometerM, end, purpose, note,
            quality = if (gap || draft.gap) "gap" else "valid", boundaryReason = reason)
        return append(s, record).copy(activeTrip = null)
    }
    private fun closeInput(s: LocalSnapshot, purpose: Purpose?, note: String): LocalSnapshot {
        requireParked(s); require(note.length <= 120)
        val existing = s.editingTripId?.let { id -> requireNotNull(s.trips.find { it.tripId == id }) }
        if (existing != null) {
            // A correction can only change purpose/note and delivery metadata.
            val record = existing.copy(eventId = UUID.randomUUID().toString(), purpose = purpose, note = note,
                synced = false, localRevision = Math.addExact(existing.localRevision, 1))
            return append(s, record)
        }
        require(s.collecting)
        val endedAt = requireNotNull(s.activeTrip?.candidateEndedAt) { "먼저 운행 마치기를 눌러 주세요." }
        return queue(s, purpose, note, endedAt, gap = false, reason = "explicit_finish")
    }
    private fun interrupt(s: LocalSnapshot, reason: String): LocalSnapshot {
        val draft = s.activeTrip
        val observed = s.copy(input = null, editingTripId = null, reviewing = false,
            activeTrip = draft?.copy(candidateEndedAt = null, candidateEndOdometerM = null))
        val preserved = if (draft != null && s.odometerM > draft.startOdometerM) {
            queue(observed, null, "", draft.lastObservedAt, gap = true, reason = reason)
        } else observed.copy(activeTrip = null)
        return preserved.copy(collecting = false)
    }
    private fun cancelInput(s: LocalSnapshot) = s.copy(editingTripId = null, input = null, reviewing = false,
        activeTrip = s.activeTrip?.copy(candidateEndedAt = null, candidateEndOdometerM = null))

    fun reduce(s: LocalSnapshot, action: Action): LocalSnapshot = when (action) {
        Action.StartCollection -> { requireParked(s);require(!s.collecting);s.copy(collecting = true) }
        Action.StopCollection -> { requireParked(s);require(s.collecting);interrupt(s, "collection_stop") }
        Action.InterruptCollection -> interrupt(s, "interrupted").copy(parking = ParkingState.UNKNOWN, uxRestrictions = UxRestrictionState.UNKNOWN)
        is Action.StartTrip -> {
            requireParked(s);require(s.collecting && s.activeTrip == null)
            s.copy(parking = ParkingState.DRIVING, editingTripId = null, input = null, reviewing = false,
                activeTrip = TripDraft(action.id, action.eventId, action.now, s.odometerM, action.now))
        }
        is Action.SimulateMovement -> {
            require(s.collecting && s.activeTrip != null && s.parking == ParkingState.DRIVING)
            require(action.meters in 1..1_000_000L)
            s.copy(odometerM = Math.addExact(s.odometerM, action.meters),
                activeTrip = s.activeTrip.copy(lastObservedAt = action.now, candidateEndedAt = null, candidateEndOdometerM = null))
        }
        is Action.Park -> s.copy(parking = ParkingState.PARKED, uxRestrictions = UxRestrictionState.UNRESTRICTED,
            activeTrip = s.activeTrip?.copy(lastObservedAt = action.now))
        is Action.ResumeDriving -> {
            requireParked(s);require(s.collecting && s.activeTrip != null)
            cancelInput(s).copy(parking = ParkingState.DRIVING,
                activeTrip = s.activeTrip.copy(lastObservedAt = action.now, candidateEndedAt = null, candidateEndOdometerM = null))
        }
        is Action.Finish -> {
            requireParked(s);val draft = requireNotNull(s.activeTrip)
            require(s.collecting && s.odometerM > draft.startOdometerM)
            s.copy(activeTrip = draft.copy(candidateEndedAt = draft.candidateEndedAt ?: action.now,
                candidateEndOdometerM = draft.candidateEndOdometerM ?: s.odometerM,
                lastObservedAt = draft.candidateEndedAt ?: action.now), input = TripInput(), reviewing = false, editingTripId = null)
        }
        is Action.Confirm -> closeInput(s, action.purpose, action.note)
        Action.Defer -> { require(s.input != null);closeInput(s, null, "") }
        is Action.EditTrip -> {
            requireParked(s)
            require(s.activeTrip == null || s.odometerM <= s.activeTrip.startOdometerM) { "현재 운행을 먼저 마쳐 주세요." }
            require(s.outbox.none { it.tripId == action.tripId && it.status != DeliveryStatus.QUEUED }) { "전송 충돌 또는 오류 원인을 먼저 확인해 주세요." }
            val record = requireNotNull(s.trips.find { it.tripId == action.tripId })
            s.copy(editingTripId = record.tripId, input = TripInput(record.purpose, record.note), reviewing = false)
        }
        is Action.SetPurpose -> {
            requireParked(s);require(s.input != null);require(action.note.length <= 120)
            s.copy(input = TripInput(action.purpose, action.note), reviewing = false)
        }
        Action.Review -> { requireParked(s);require(s.input?.purpose != null);s.copy(reviewing = true) }
        Action.Save -> { require(s.reviewing);val input = requireNotNull(s.input);closeInput(s, requireNotNull(input.purpose), input.note) }
        Action.CancelInput -> cancelInput(s)
        is Action.UpdateVehicleState -> {
            val next = s.copy(parking = action.parking, uxRestrictions = action.uxRestrictions)
            if (inputAllowed(next)) next else cancelInput(next)
        }
        is Action.PrepareEvent -> {
            val event = requireNotNull(s.outbox.find { it.eventId == action.eventId })
            require(event.status == DeliveryStatus.QUEUED)
            expectedVersion(s, event)
            require(event.preparedBody == null || event.preparedBody == action.body) { "준비된 요청 본문을 바꿀 수 없습니다." }
            s.copy(outbox = s.outbox.map { if (it.eventId == action.eventId) it.copy(preparedBody = action.body, attempts = it.attempts + 1) else it })
        }
        is Action.AcceptAck -> {
            val ack = action.ack
            val event = s.outbox.find { it.eventId == ack.eventId }
            if (event == null) {
                require(s.receipts[ack.eventId] == ack) { "대상 이벤트가 없는 ACK입니다." };s
            } else {
                require(event.preparedBody != null && ack.ackedLocalRevision == event.localRevision &&
                    ack.serverVersion == Math.addExact(expectedVersion(s, event), 1)) { "서버 ACK의 이벤트/리비전/버전이 일치하지 않습니다." }
                s.copy(receipts = s.receipts + (ack.eventId to ack), outbox = s.outbox.filterNot { it.eventId == ack.eventId },
                    trips = s.trips.map { if (it.tripId == event.tripId) {
                        val completed = maxOf(it.ackedLocalRevision, ack.ackedLocalRevision)
                        it.copy(ackedLocalRevision = completed, serverVersion = maxOf(it.serverVersion, ack.serverVersion), synced = completed >= it.localRevision)
                    } else it })
            }
        }
        is Action.FailEvent -> s.copy(outbox = s.outbox.map { if (it.eventId == action.eventId) it.copy(status = action.status, lastError = action.message) else it })
        is Action.MarkSynced -> throw IllegalArgumentException("이벤트 ID만으로 수신 완료를 표시할 수 없습니다. 검증된 ACK를 사용하세요.")
    }
    fun recover(s: LocalSnapshot): LocalSnapshot = interrupt(s, "recovered")
        .copy(parking = ParkingState.UNKNOWN, uxRestrictions = UxRestrictionState.UNKNOWN)
}
