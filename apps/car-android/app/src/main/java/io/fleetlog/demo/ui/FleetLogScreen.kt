package io.fleetlog.demo.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.fleetlog.demo.domain.*
import io.fleetlog.demo.platform.*
import java.util.Locale

@Composable
fun FleetLogScreen(model: FleetLogViewModel) {
    val ui by model.state.collectAsStateWithLifecycle()
    val state=ui.snapshot
    val enabled=ui.ready && ui.storageHealthy && !ui.busy
    var stopDialog by remember { mutableStateOf(false) }
    LaunchedEffect(ui.inputAllowed) { if(!ui.inputAllowed) stopDialog=false }
    MaterialTheme(colorScheme=lightColorScheme(primary=Color(0xFF087C73),secondary=Color(0xFF10232F))) {
        Surface(Modifier.fillMaxSize(),color=Color(0xFFEDF2F2)) {
            LazyColumn(Modifier.fillMaxSize().safeDrawingPadding(),contentPadding=PaddingValues(20.dp),verticalArrangement=Arrangement.spacedBy(16.dp)) {
                item {
                    Text("Fleetlog",style=MaterialTheme.typography.headlineLarge)
                    Text("말 한마디로, 운행 기록은 Fleetlog.",style=MaterialTheme.typography.titleMedium)
                    Text("Android MOCK · 실제 차량·마이크·Pleos 서비스 미연결",color=MaterialTheme.colorScheme.primary)
                    Text("샘플 법인차 · 샘플 이용자",style=MaterialTheme.typography.bodyMedium)
                    Text(ui.message,Modifier.fillMaxWidth().background(Color(0xFFE0EEEB)).padding(16.dp))
                    if(ui.busy || ui.syncing) LinearProgressIndicator(Modifier.fillMaxWidth())
                    if(!ui.storageHealthy) ControlButton("기존 내용 유지하고 저장 다시 확인",ui.ready,model::retryStorage)
                }
                item {
                    Card(Modifier.fillMaxWidth(),colors=CardDefaults.cardColors(containerColor=Color(0xFF10232F),contentColor=Color(0xFFEDF7F7))) {
                        Column(Modifier.padding(20.dp),verticalArrangement=Arrangement.spacedBy(14.dp)) {
                            Text("Fleetlog · 차량 앱 영역 · MOCK",style=MaterialTheme.typography.titleMedium)
                            when {
                                state.parking==ParkingState.DRIVING -> {
                                    Text("운전에 집중해 주세요",style=MaterialTheme.typography.headlineMedium)
                                    Text(if(state.collecting) "수집 중입니다. 용도·메모·음성·기록 종료를 잠갔습니다." else "수집을 시작하지 않았습니다. 주차 후 시작하세요.")
                                }
                                !ui.inputAllowed -> {
                                    Text("주차·UX 상태 확인이 필요합니다",style=MaterialTheme.typography.headlineSmall)
                                    Text("UNKNOWN·오래된 상태·UX 제한에서는 입력할 수 없습니다. 개발용 제어에서 MOCK 상태를 확인하세요.")
                                }
                                state.input!=null -> PurposePanel(ui,model)
                                !state.collecting -> {
                                    Text("출발 전에 기록을 시작하세요",style=MaterialTheme.typography.headlineSmall)
                                    ControlButton("운행 기록 시작",enabled,model::startCollection)
                                    Text("직접 시작하기 전에는 운행을 수집하지 않습니다.")
                                }
                                state.activeTrip==null -> {
                                    Text("수집 세션이 켜져 있습니다",style=MaterialTheme.typography.headlineSmall)
                                    Text("개발용 제어에서 MOCK 운행을 시작하세요. 저장한 운행과 서버 수신은 아래에서 확인합니다.")
                                }
                                else -> {
                                    Text("이번 운행을 마칠까요?",style=MaterialTheme.typography.headlineSmall)
                                    Text(if(state.activeTrip.gap) "거리 확인 필요" else "이번 운행 ${km(state.odometerM-state.activeTrip.startOdometerM)} km")
                                    Text("잠깐 주차했다면 같은 운행을 이어갈 수 있습니다.")
                                    ControlButton("운행 마치기",enabled && state.odometerM>state.activeTrip.startOdometerM,model::finish)
                                }
                            }
                            if(state.collecting && ui.inputAllowed) TextButton(onClick={model.cancelVoice();stopDialog=true},modifier=Modifier.heightIn(min=56.dp)) { Text("기록 세션 종료",color=Color(0xFF5CE0CF)) }
                        }
                    }
                }
                item {
                    Card(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(18.dp),verticalArrangement=Arrangement.spacedBy(10.dp)) {
                            Text("로컬 저장과 서버 수신",style=MaterialTheme.typography.titleLarge)
                            Text("이 기기 ${state.trips.size}건 · 미수신 ${state.trips.count { it.ackedLocalRevision<it.localRevision }}건")
                            ControlButton(if(ui.syncing) "전송·수신 확인 중" else "개발 서버로 전송",enabled && ui.inputAllowed && !ui.syncing && TripReducer.nextEvent(state)!=null,model::syncPending)
                            Text("원인 확인이 필요한 오류와 409 충돌은 자동 우회하지 않습니다. 수신은 승인·마감·세무신고와 다릅니다.",style=MaterialTheme.typography.bodySmall)
                        }
                    }
                }
                item { Text("미확정 기록 ${state.trips.count { it.purpose==null }}건",style=MaterialTheme.typography.titleLarge) }
                if(state.trips.none { it.purpose==null }) item { Text("미확정 기록이 없습니다. 나중에 보관한 기록은 주차 후 이곳에서 보완합니다.") }
                items(state.trips.reversed(),key={it.tripId}) { trip ->
                    val events=state.outbox.filter { it.tripId==trip.tripId }
                    val conflicted=events.any { it.status==DeliveryStatus.CONFLICT }
                    val blocked=events.any { it.status==DeliveryStatus.BLOCKED }
                    val status=when {
                        conflicted -> "버전 충돌 · 전송 보류"
                        blocked -> "전송 오류 · 원인 확인 필요"
                        events.any { it.eventId==ui.inFlightEventId } -> "전송 중 · ACK 로컬 반영 전"
                        trip.ackedLocalRevision>=trip.localRevision -> "서버 수신 확인"
                        events.any { it.lastError!=null } -> "전송 실패 · 확인 후 동일 이벤트 재시도"
                        else -> "이 기기에 저장 · 전송 대기"
                    }
                    Card(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(18.dp),verticalArrangement=Arrangement.spacedBy(8.dp)) {
                            Text("${trip.purpose?.label ?: "용도 미확정"} · ${if(trip.quality=="valid") "${km(trip.endOdometerM-trip.startOdometerM)} km" else "거리 확인 필요"}",style=MaterialTheme.typography.titleMedium)
                            Text(status)
                            Text(trip.note.ifBlank { "메모 없음" })
                            Text("${trip.startedAt} → ${trip.endedAt}",style=MaterialTheme.typography.bodySmall)
                            Text("품질 ${trip.quality} · 로컬 수정 ${trip.localRevision} / 수신 확인 ${trip.ackedLocalRevision} · MOCK",style=MaterialTheme.typography.bodySmall)
                            if(trip.quality!="valid") Text("누락 구간입니다. 용도 보완으로 거리 품질이 정상으로 바뀌지 않습니다.")
                            if(trip.purpose==null) {
                                val unfinished=state.activeTrip?.let { state.odometerM>it.startOdometerM } == true
                                ControlButton("용도 보완",enabled && ui.inputAllowed && !unfinished && !blocked && !conflicted && state.input==null) { model.editTrip(trip.tripId) }
                                if(unfinished) Text("현재 운행을 먼저 마친 뒤 보완하세요.")
                            }
                        }
                    }
                }
                item { DeveloperPanel(ui,model) }
            }
            if(stopDialog) AlertDialog(onDismissRequest={stopDialog=false},title={Text("수집 세션을 종료할까요?")},text={Text("운행 마치기는 한 운행만, 세션 종료는 수집 전체를 끝냅니다. 미완료 관측 구간은 미확정/gap으로 보관합니다. 다음 수집은 직접 시작해야 합니다.")},confirmButton={TextButton(onClick={stopDialog=false;model.stopCollection()},modifier=Modifier.heightIn(min=56.dp)) { Text("세션 종료") }},dismissButton={TextButton(onClick={stopDialog=false},modifier=Modifier.heightIn(min=56.dp)) { Text("계속 기록") }})
        }
    }
}

@Composable
private fun PurposePanel(ui: FleetLogUiState,model:FleetLogViewModel) {
    val state=ui.snapshot
    val input=state.input ?: return
    val existing=state.trips.find { it.tripId==state.editingTripId }
    val draft=state.activeTrip
    val distance=if(existing!=null) {
        if(existing.quality=="valid") existing.endOdometerM-existing.startOdometerM else null
    } else draft?.let { if(it.gap) null else (it.candidateEndOdometerM ?: state.odometerM)-it.startOdometerM }
    val speech=ui.speech
    if(speech.phase in listOf(SpeechPhase.PROMPTING,SpeechPhase.LISTENING,SpeechPhase.PROCESSING)) {
        Text(when(speech.phase) { SpeechPhase.PROMPTING -> "어떤 용도로 운행하셨나요?";SpeechPhase.LISTENING -> "말씀을 기다리고 있습니다";else -> "결과를 정리하고 있습니다" },style=MaterialTheme.typography.headlineSmall)
        Text("MOCK 안내·인식입니다. 실제 소리나 마이크를 사용하지 않습니다.")
        if(speech.interim.isNotBlank()) Text("중간 결과 · 저장되지 않음\n${speech.interim}")
        ControlButton("음성 입력 취소",true,model::cancelVoice)
        return
    }
    if(state.reviewing) {
        Text("이 내용으로 남길까요?",style=MaterialTheme.typography.headlineSmall)
        Text("거리 ${distance?.let { "${km(it)} km" } ?: "거리 확인 필요"}")
        Text("용도 ${input.purpose?.label ?: "미확정"}\n메모 ${input.note.ifBlank { "없음" }}")
        Text("운행 종료 후보는 수정으로 돌아가도 바뀌지 않습니다.")
        ControlButton("확인하고 저장",ui.inputAllowed && input.purpose!=null,model::save)
        ControlButton("수정",ui.inputAllowed,model::editInput)
        return
    }
    Text(if(existing!=null) "미확정 기록 보완" else "어떤 운행이었나요?",style=MaterialTheme.typography.headlineSmall)
    Text("거리 ${distance?.let { "${km(it)} km" } ?: "거리 확인 필요"}")
    if(speech.phase==SpeechPhase.ERROR || speech.phase==SpeechPhase.DRAFT) {
        if(speech.transcript.isNotBlank()) Text("인식한 문장 · MOCK\n${speech.transcript}")
        Text(speech.message)
    }
    Purpose.entries.forEach { purpose ->
        FilterChip(selected=input.purpose==purpose,onClick={model.setPurpose(purpose,input.note)},enabled=ui.inputAllowed,
            label={Text(purpose.label)},modifier=Modifier.fillMaxWidth().heightIn(min=56.dp))
    }
    OutlinedTextField(value=input.note,onValueChange={if(it.length<=120) model.setPurpose(input.purpose,it)},enabled=ui.inputAllowed,
        label={Text("운행 메모 · 선택 · 120자")},modifier=Modifier.fillMaxWidth(),maxLines=3)
    ControlButton("요약 확인",ui.inputAllowed && input.purpose!=null,model::review)
    ControlButton(if(speech.phase==SpeechPhase.ERROR) "음성 다시 입력" else "음성으로 입력",ui.inputAllowed,model::startVoice)
    ControlButton("미확정으로 보관",ui.inputAllowed,model::defer)
    ControlButton(if(existing!=null) "보완 취소" else "계속 운행",ui.inputAllowed,model::cancelInput)
}

@Composable
private fun DeveloperPanel(ui:FleetLogUiState,model:FleetLogViewModel) {
    val s=ui.snapshot
    val enabled=ui.ready && ui.storageHealthy && !ui.busy
    Card(Modifier.fillMaxWidth(),colors=CardDefaults.cardColors(containerColor=Color(0xFFDDE7E7))) {
        Column(Modifier.padding(18.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
            Text("개발용 제어 · MOCK",style=MaterialTheme.typography.titleLarge)
            Text("차량 앱 밖의 이벤트 주입입니다. 차량 제어·실제 주행 상태 확인이 아닙니다.")
            Text("수집 ${if(s.collecting) "켜짐" else "중지"} · ${s.parking} / UX ${s.uxRestrictions}")
            Text("모의 누적거리 ${km(s.odometerM)} km · 출처 APP_MOCK")
            Text(if(ui.gate.connected) "MOCK 상태 관측을 확인했습니다. 실제 차량 서비스 연결이 아닙니다." else "MOCK 상태 관측 전 또는 연결 불명입니다. 실제 차량 서비스는 disabled입니다.")
            ControlButton("MOCK 주차·UX 상태 새로 확인",enabled,model::park)
            ControlButton("MOCK 운행 시작",enabled && ui.inputAllowed && s.collecting && s.activeTrip==null && s.input==null,model::startTrip)
            ControlButton("MOCK 23.4km 이동",enabled && s.collecting && s.activeTrip!=null && s.parking==ParkingState.DRIVING,model::simulateMovement)
            ControlButton("MOCK 재출발",enabled && ui.inputAllowed && s.collecting && s.activeTrip!=null,model::resumeDriving)
            ControlButton("MOCK UNKNOWN",enabled,model::unknownState)
            ControlButton("MOCK UX 제한 활성화",enabled,model::restrictInput)
            Text("상태는 30초가 지나면 오래된 것으로 처리하고 입력·음성을 잠급니다. 이는 mock 실험 설정입니다.")
            Text("모의 음성 결과 유형")
            Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.spacedBy(4.dp)) {
                TextButton(onClick={model.setSpeechMode(MockSpeechMode.NORMAL)},modifier=Modifier.weight(1f).heightIn(min=56.dp)) { Text("정상") }
                TextButton(onClick={model.setSpeechMode(MockSpeechMode.FAILED)},modifier=Modifier.weight(1f).heightIn(min=56.dp)) { Text("실패") }
                TextButton(onClick={model.setSpeechMode(MockSpeechMode.UNAVAILABLE)},modifier=Modifier.weight(1f).heightIn(min=56.dp)) { Text("사용 불가") }
            }
            ControlButton("MOCK 안내 완료 이벤트",ui.speech.phase==SpeechPhase.PROMPTING,model::completeMockPrompt)
            ControlButton("MOCK 중간 결과",ui.speech.phase==SpeechPhase.LISTENING,model::previewMockVoice)
            ControlButton("MOCK 최종 결과",ui.speech.phase==SpeechPhase.LISTENING,model::completeMockVoice)
            Text("실제 SDK 초기화·서비스 연결·기능 지원·실차 데이터·인증·실제 음성은 확인되지 않아 disabled입니다. 원음 파일을 저장하지 않습니다.",style=MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun ControlButton(label:String,enabled:Boolean,onClick:()->Unit) {
    Button(onClick=onClick,enabled=enabled,modifier=Modifier.fillMaxWidth().heightIn(min=60.dp)) { Text(label) }
}
private fun km(meters:Long):String=String.format(Locale.KOREA,"%,.1f",meters/1000.0)
