package io.fleetlog.demo.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import io.fleetlog.demo.data.DevSyncClient
import io.fleetlog.demo.data.JsonTripRepository
import io.fleetlog.demo.data.TripRepository
import io.fleetlog.demo.data.OutboxSynchronizer
import io.fleetlog.demo.domain.*
import io.fleetlog.demo.platform.*
import java.time.Instant
import java.time.format.DateTimeFormatterBuilder
import java.util.UUID
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

data class FleetLogUiState(
    val snapshot: LocalSnapshot = LocalSnapshot(),
    val ready: Boolean = false,
    val storageHealthy: Boolean = true,
    val busy: Boolean = false,
    val syncing: Boolean = false,
    val inFlightEventId: String? = null,
    val gate: InputGate = InputGate(),
    val inputAllowed: Boolean = false,
    val speech: SpeechState = SpeechState(),
    val message: String = "로컬 기록을 읽고 있습니다.",
)

class FleetLogViewModel(application: Application) : AndroidViewModel(application) {
    private val repository: TripRepository = JsonTripRepository(application.filesDir)
    private val vehicle: VehicleAdapter = MockVehicleAdapter()
    private val speechAdapter = MockSpeechAdapter()
    private var syncClient = DevSyncClient()
    private val mutex = Mutex()
    private val mutable = MutableStateFlow(FleetLogUiState())
    val state: StateFlow<FleetLogUiState> = mutable.asStateFlow()
    private var draftVersion = 0L
    private var hasLoadedSnapshot = false
    private var foreground = true
    private var voiceEpoch = 0L
    private val speechFlow = SpeechCoordinator(speechAdapter, ::speechTarget,
        { parsed -> speechTarget()?.let { target ->
            dispatch(Action.SetPurpose(parsed.purpose, parsed.note), "음성 결과를 초안으로 반영했습니다. 직접 확인한 뒤 저장하세요.", fromVoice = true, expectedVoiceTarget = target, expectedVoiceEpoch = voiceEpoch)
        } },
        { speech -> mutable.value = mutable.value.copy(speech = speech) })

    private fun cancelSpeech() { voiceEpoch++;speechFlow.cancel() }
    private val synchronizer = OutboxSynchronizer(
        readSnapshot = { mutable.value.snapshot }, persist = repository::save,
        publish = { next -> publish(mutable.value.copy(snapshot=next)) }, mutex = mutex,
        prepare = { event, version -> syncClient.prepare(event,version) }, send = { syncClient.send(it) },
        flight = { id -> publish(mutable.value.copy(inFlightEventId=id)) },
    )

    init {
        viewModelScope.launch {
            mutex.withLock {
                try {
                    val loaded = repository.load()
                    val recovered = TripReducer.recover(loaded)
                    repository.save(recovered)
                    hasLoadedSnapshot = true
                    publish(FleetLogUiState(recovered, ready = true, message =
                        if (recovered.trips.size > loaded.trips.size) "마지막 관측 구간을 미확정/gap으로 보관했습니다. 수집은 중지했습니다."
                        else "MOCK 주차·UX 상태를 확인한 뒤 직접 수집을 시작하세요. 실차·마이크 미연결입니다."))
                } catch (e: Exception) {
                    publish(mutable.value.copy(ready = true, storageHealthy = false,
                        message = "로컬 기록을 열 수 없습니다. 기존 파일을 보존하고 중단했습니다: ${e.message}"))
                }
            }
        }
        viewModelScope.launch {
            while (true) {
                delay(1000)
                val current = mutable.value
                if (current.inputAllowed && !current.gate.allowsInput(System.currentTimeMillis())) {
                    cancelSpeech()
                    dispatch(Action.UpdateVehicleState(ParkingState.UNKNOWN, UxRestrictionState.UNKNOWN),
                        "차량·UX 상태가 오래되어 입력을 잠갔습니다. MOCK 상태를 다시 확인하세요.")
                }
            }
        }
    }

    private fun publish(value: FleetLogUiState) {
        mutable.value = value.copy(inputAllowed = value.ready && value.storageHealthy && !value.busy && foreground &&
            value.gate.allowsInput(System.currentTimeMillis()) && value.snapshot.parking == ParkingState.PARKED &&
            value.snapshot.uxRestrictions == UxRestrictionState.UNRESTRICTED)
        speechFlow.contextChanged()
    }
    private fun speechTarget(): SpeechTarget? {
        val ui = mutable.value
        val id = ui.snapshot.editingTripId ?: ui.snapshot.activeTrip?.takeIf { it.candidateEndedAt != null }?.tripId ?: return null
        if (ui.snapshot.input == null) return null
        return SpeechTarget(id, draftVersion, ui.inputAllowed && foreground && ui.gate.allowsInput(System.currentTimeMillis()))
    }
    private fun requiresInput(action: Action): Boolean = when(action) {
        Action.StartCollection, Action.StopCollection, is Action.StartTrip, is Action.Finish,
        is Action.EditTrip, is Action.SetPurpose, Action.Review, Action.Save, Action.Defer -> true
        else -> false
    }
    fun startCollection() = dispatch(Action.StartCollection, "수집 세션을 시작했습니다. MOCK 운행을 시작할 수 있습니다.")
    fun stopCollection() { cancelSpeech();dispatch(Action.StopCollection, "수집을 종료했습니다. 미완료 관측 구간은 미확정/gap으로 보관했습니다.") }
    fun startTrip() = dispatch(Action.StartTrip(UUID.randomUUID().toString(), UUID.randomUUID().toString(), nowIso()), "MOCK 주행 중 · 입력이 잠겼습니다.")
    fun simulateMovement() = dispatch(Action.SimulateMovement(nowIso()), "MOCK 누적거리에 23.4km를 추가했습니다.")
    fun park() = dispatch(Action.Park(nowIso()), "MOCK 주차·UX 제한 해제를 확인했습니다. 운행은 자동 확정되지 않습니다.")
    fun resumeDriving() { cancelSpeech();dispatch(Action.ResumeDriving(nowIso()), "MOCK 재출발로 초안·종료 후보·음성을 취소했습니다.") }
    fun finish() = dispatch(Action.Finish(nowIso()), "운행 종료 후보를 고정했습니다. 용도를 확인하거나 미확정 보관하세요.")
    fun editTrip(id: String) { cancelSpeech();draftVersion++;dispatch(Action.EditTrip(id), "기존 운행의 용도를 보완합니다. 시각·거리·품질은 유지됩니다.") }
    fun setPurpose(purpose: Purpose?, note: String) { cancelSpeech();draftVersion++;dispatch(Action.SetPurpose(purpose, note), "입력 초안입니다. 요약 확인 후 저장하세요.") }
    fun review() { cancelSpeech();dispatch(Action.Review, "저장 전 용도·메모·거리를 확인하세요.") }
    fun editInput() { val input=mutable.value.snapshot.input ?: return;dispatch(Action.SetPurpose(input.purpose,input.note), "입력을 수정합니다. 종료 후보는 바뀌지 않습니다.") }
    fun save() { cancelSpeech();dispatch(Action.Save, "이 기기에 저장했습니다. 서버 수신은 별도 전송 후 확인합니다.") }
    fun defer() { cancelSpeech();dispatch(Action.Defer, "용도 미확정으로 이 기기에 보관했습니다. 전송할 수 있습니다.") }
    fun cancelInput() { cancelSpeech();dispatch(Action.CancelInput, "입력을 취소했습니다. 기존 기록은 유지합니다.") }
    fun unknownState() { cancelSpeech();dispatch(Action.UpdateVehicleState(ParkingState.UNKNOWN,UxRestrictionState.UNKNOWN), "차량·UX 상태가 UNKNOWN이므로 입력을 차단했습니다.") }
    fun restrictInput() { cancelSpeech();dispatch(Action.UpdateVehicleState(ParkingState.PARKED,UxRestrictionState.RESTRICTED), "MOCK UX 제한이 활성화되어 입력·음성을 차단했습니다.") }

    fun setSpeechMode(mode: MockSpeechMode) { speechAdapter.mode=mode }
    fun startVoice() {
        voiceEpoch++
        speechFlow.start()
        val context=speechFlow.state.context ?: return
        viewModelScope.launch { delay(15_000);speechFlow.timeout(context) }
    }
    fun completeMockPrompt() = speechAdapter.completePrompt()
    fun previewMockVoice() = speechAdapter.preview()
    fun completeMockVoice() = speechAdapter.complete()
    fun cancelVoice() = cancelSpeech()
    /** Debug/mock transport override, restricted by DevSyncClient to emulator/loopback. */
    fun setMockApiEndpoint(endpoint: String) {
        if(mutable.value.syncing) return
        try { syncClient=DevSyncClient(endpoint) }
        catch(_:Exception) { publish(mutable.value.copy(message="허용되지 않은 테스트 서버 주소입니다. 기존 mock 전송 주소를 유지합니다.")) }
    }
    fun onAppForegrounded() { foreground=true;publish(mutable.value) }
    fun onAppInactive() { foreground=false;cancelSpeech();publish(mutable.value) }
    fun onAppBackgrounded() {
        onAppInactive()
        dispatch(Action.InterruptCollection,
            "앱 이탈로 수집을 중단하고 마지막 관측 구간을 미확정/gap으로 보관했습니다.")
    }
    private fun nowIso(): String = DateTimeFormatterBuilder().appendInstant(3).toFormatter().format(Instant.now())

    private fun dispatch(action: Action, message: String, fromVoice: Boolean = false, expectedVoiceTarget: SpeechTarget? = null, expectedVoiceEpoch: Long? = null) {
        viewModelScope.launch {
            mutex.withLock {
                val current=mutable.value
                if (!current.ready || !current.storageHealthy) return@withLock
                // A final can wait behind a storage write. Recheck its captured trip
                // and draft version after acquiring the mutex, not only at callback time.
                if(fromVoice && (expectedVoiceEpoch!=voiceEpoch || expectedVoiceTarget==null || speechTarget()!=expectedVoiceTarget)) return@withLock
                if (requiresInput(action) && (!current.inputAllowed || !current.gate.allowsInput(System.currentTimeMillis()))) {
                    cancelSpeech();publish(current.copy(message="주차·UX 제한·상태 최신성이 확인돼야 입력할 수 있습니다."));return@withLock
                }
                if (vehicle.capability !is Capability.MockSupported) {
                    publish(current.copy(message="실제 SDK 미지원으로 수집을 시작하지 않았습니다. MOCK으로 자동 전환하지 않습니다."));return@withLock
                }
                val next=try { vehicle.observe(current.snapshot.odometerM,current.snapshot.parking).getOrThrow();TripReducer.reduce(current.snapshot,action) }
                catch(e:Exception) { publish(current.copy(message=e.message ?: "허용되지 않은 동작입니다."));return@withLock }
                val gate=when(action) {
                    is Action.Park -> InputGate(ParkingState.PARKED,UxRestriction.UNRESTRICTED,true,System.currentTimeMillis())
                    is Action.StartTrip, is Action.ResumeDriving -> InputGate(ParkingState.DRIVING,UxRestriction.RESTRICTED,true,System.currentTimeMillis())
                    is Action.UpdateVehicleState -> InputGate(action.parking,when(action.uxRestrictions) {
                        UxRestrictionState.UNRESTRICTED -> UxRestriction.UNRESTRICTED
                        UxRestrictionState.RESTRICTED -> UxRestriction.RESTRICTED
                        UxRestrictionState.UNKNOWN -> UxRestriction.UNKNOWN
                    },action.parking!=ParkingState.UNKNOWN,System.currentTimeMillis())
                    Action.InterruptCollection -> InputGate()
                    else -> current.gate
                }
                publish(current.copy(busy=true))
                try {
                    repository.save(next)
                    publish(mutable.value.copy(snapshot=next,gate=gate,busy=false,message=message))
                } catch(e:Exception) {
                    val failedSpeech=if(fromVoice) mutable.value.speech.copy(phase=SpeechPhase.ERROR,message="음성 초안을 저장하지 못했습니다. 입력은 보존했습니다.") else mutable.value.speech
                    publish(mutable.value.copy(storageHealthy=false,busy=false,speech=failedSpeech,message="저장 실패: 기존 기록·초안을 보존했습니다. 저장 공간을 확인하세요: ${e.message}"))
                }
            }
        }
    }

    fun retryStorage() {
        viewModelScope.launch { mutex.withLock {
            val current=mutable.value
            // A failed initial load cannot be overwritten with an empty snapshot.
            if(!current.ready || !hasLoadedSnapshot) return@withLock
            try { repository.save(current.snapshot);publish(current.copy(storageHealthy=true,message="기존 내용을 유지한 채 저장을 확인했습니다. 필요한 동작을 다시 실행하세요.")) }
            catch(e:Exception) { publish(current.copy(message="저장 확인 실패. 기존 데이터는 초기화하지 않습니다: ${e.message}")) }
        } }
    }

    fun syncPending() {
        viewModelScope.launch {
            val admitted=mutex.withLock {
                val current=mutable.value
                if(current.syncing || !current.ready || !current.storageHealthy || !current.inputAllowed) false
                else { publish(current.copy(syncing=true,message="MOCK 전송을 시작합니다. ACK의 로컬 반영까지 확인합니다."));true }
            }
            if(!admitted) return@launch
            try {
                val result=synchronizer.run()
                mutex.withLock {
                    publish(mutable.value.copy(message=when {
                        result.held>0 -> "충돌·원인 확인 오류 ${result.held}건을 보류했습니다. 다른 운행의 전송은 계속할 수 있습니다."
                        result.failed>0 -> "재시도 가능한 전송 실패 ${result.failed}건이 있습니다. 기록과 동일 준비 본문을 유지합니다."
                        result.sent>0 -> "서버 ACK를 이 기기에 반영했습니다. 최신 변경의 수신 상태는 각 기록에서 확인하세요."
                        else -> "전송 가능한 대기 기록이 없습니다. 보류 사유와 선행 ACK를 확인하세요."
                    }))
                }
            } catch(e:Exception) {
                mutex.withLock { publish(mutable.value.copy(storageHealthy=false,inFlightEventId=null,message="전송 상태 로컬 저장 실패. 준비 본문과 미ACK 기록을 보존했습니다: ${e.message}")) }
            } finally { mutex.withLock { publish(mutable.value.copy(syncing=false,inFlightEventId=null)) } }
        }
    }
    override fun onCleared() { speechFlow.close();vehicle.close();super.onCleared() }
}
