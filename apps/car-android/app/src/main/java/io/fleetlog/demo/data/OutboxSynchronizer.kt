package io.fleetlog.demo.data

import io.fleetlog.demo.domain.*
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext

data class SyncRunResult(val sent: Int = 0, val held: Int = 0, val failed: Int = 0, val busy: Boolean = false)

/** Shared by the actual Android ViewModel and JVM failure tests. Never locks over HTTP. */
class OutboxSynchronizer(
    private val readSnapshot: () -> LocalSnapshot,
    private val persist: suspend (LocalSnapshot) -> Unit,
    private val publish: (LocalSnapshot) -> Unit,
    private val mutex: Mutex,
    private val prepare: (OutboxEvent, Int) -> String,
    private val send: suspend (String) -> SyncAck,
    private val flight: (String?) -> Unit = {},
) {
    private val busy = AtomicBoolean(false)
    suspend fun run(): SyncRunResult {
        if (!busy.compareAndSet(false, true)) return SyncRunResult(busy = true)
        val attempted = mutableSetOf<String>()
        var sent = 0
        var failed = 0
        try {
            while (true) {
                val request = mutex.withLock {
                    val current = readSnapshot()
                    val event = TripReducer.nextEvent(current.copy(outbox = current.outbox.filterNot { it.eventId in attempted }))
                        ?: return@withLock null
                    attempted += event.eventId
                    val body = prepare(event, TripReducer.expectedVersion(current, event))
                    val next = TripReducer.reduce(current, Action.PrepareEvent(event.eventId, body))
                    persist(next) // A failed prepare write sends nothing and publishes nothing.
                    publish(next)
                    flight(event.eventId)
                    event.eventId to body
                } ?: break
                val ack = try { send(request.second) }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (error: Exception) {
                    mutex.withLock {
                        flight(null)
                        val current = readSnapshot()
                        val status = (error as? SyncFailure)?.disposition ?: DeliveryStatus.QUEUED
                        val next = TripReducer.reduce(current, Action.FailEvent(request.first, status, error.message ?: "연결 실패"))
                        persist(next)
                        publish(next)
                    }
                    failed++
                    continue
                }
                mutex.withLock {
                    // Validation and durable ACK commit use the latest snapshot, including
                    // revisions created while HTTP was pending. A failed commit is NOT a
                    // transport failure and cannot consume the original prepared request.
                    val next = TripReducer.reduce(readSnapshot(), Action.AcceptAck(ack))
                    persist(next)
                    publish(next)
                    flight(null)
                }
                sent++
            }
            return mutex.withLock {
                SyncRunResult(sent, readSnapshot().outbox.count { it.status != DeliveryStatus.QUEUED }, failed)
            }
        } finally {
            try { withContext(NonCancellable) { mutex.withLock { flight(null) } } }
            finally { busy.set(false) }
        }
    }
}
