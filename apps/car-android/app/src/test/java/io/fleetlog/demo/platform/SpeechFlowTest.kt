package io.fleetlog.demo.platform

import io.fleetlog.demo.domain.ParkingState
import io.fleetlog.demo.domain.Purpose
import org.junit.Assert.*
import org.junit.Test

class SpeechFlowTest {
    private class Hostile : SpeechAdapter {
        override val capability = Capability.MockSupported
        val prompts = mutableListOf<Pair<SpeechContext, (SpeechEvent) -> Unit>>()
        val recognitions = mutableListOf<Pair<SpeechContext, (SpeechEvent) -> Unit>>()
        var cancelled = 0
        override fun startPrompt(context: SpeechContext, emit: (SpeechEvent) -> Unit) { prompts += context to emit }
        override fun stopPrompt(context: SpeechContext) {}
        override fun startRecognition(context: SpeechContext, emit: (SpeechEvent) -> Unit) { recognitions += context to emit }
        override fun finishRecognition(context: SpeechContext) {}
        override fun cancelRecognition(context: SpeechContext) { cancelled++ }
        fun prompt(index: Int = prompts.lastIndex) { prompts[index].let { it.second(SpeechEvent.PromptCompleted(it.first)) } }
        fun final(text: String, index: Int = recognitions.lastIndex) { recognitions[index].let { it.second(SpeechEvent.Final(it.first, text)) } }
    }
    private class Fixture {
        var target: SpeechTarget? = SpeechTarget("trip-a", 0, true)
        var serial = 0
        val adapter = Hostile()
        val drafts = mutableListOf<ParsedSpeech>()
        val flow = SpeechCoordinator(adapter, { target }, { drafts += it }, {}, { "speech-${++serial}" })
        fun listen() { flow.start();adapter.prompt();assertEquals(SpeechPhase.LISTENING, flow.state.phase) }
    }
    @Test fun recognitionWaitsForPromptAndInterimCannotCreateDraft() {
        val f=Fixture();f.flow.start()
        assertEquals(SpeechPhase.PROMPTING,f.flow.state.phase);assertTrue(f.adapter.recognitions.isEmpty())
        f.adapter.prompt()
        val operation=f.adapter.recognitions.single()
        operation.second(SpeechEvent.Interim(operation.first,"일반 업무"))
        assertEquals("일반 업무",f.flow.state.interim);assertTrue(f.drafts.isEmpty())
        f.adapter.final("일반 업무, 거래처 미팅")
        assertEquals(SpeechPhase.DRAFT,f.flow.state.phase);assertEquals(Purpose.BUSINESS,f.drafts.single().purpose)
        assertEquals("거래처 미팅",f.drafts.single().note)
    }
    @Test fun duplicateFinalAndLateInterimAreConsumedOnce() {
        val f=Fixture();f.listen();f.adapter.final("출퇴근");f.adapter.final("개인 용도, 장보기")
        assertEquals(1,f.drafts.size);assertEquals(Purpose.COMMUTE,f.drafts.single().purpose)
        val op=f.adapter.recognitions.single();op.second(SpeechEvent.Interim(op.first,"개인 용도"))
        assertEquals("",f.flow.state.interim)
    }
    @Test fun cancellationAndDepartureRejectHostileLateCallbacks() {
        for (mode in listOf("cancel","driving","unknown","inactive")) {
            val f=Fixture();f.listen()
            when(mode) {
                "cancel" -> f.flow.cancel()
                "driving","unknown" -> {f.target=f.target!!.copy(inputAllowed=false);f.flow.contextChanged()}
                else -> {f.target=null;f.flow.contextChanged()}
            }
            f.adapter.final("개인 용도, 장보기");f.adapter.prompt()
            assertTrue(f.drafts.isEmpty());assertEquals(SpeechPhase.IDLE,f.flow.state.phase)
        }
    }
    @Test fun oldSessionWrongTripAndManualEditCannotOverwriteNewDraft() {
        val f=Fixture();f.listen();f.listen()
        f.adapter.final("개인 용도",0);assertTrue(f.drafts.isEmpty())
        val op=f.adapter.recognitions.last()
        op.second(SpeechEvent.Final(op.first.copy(tripId="different"),"개인 용도"));assertTrue(f.drafts.isEmpty())
        f.target=f.target!!.copy(draftVersion=1);f.flow.contextChanged();f.adapter.final("업무, 이전 내용")
        assertTrue(f.drafts.isEmpty())
    }
    @Test fun differentTargetRejectsOldResultEvenWhenDraftVersionMatches() {
        val f=Fixture();f.listen();f.target=SpeechTarget("trip-b",0,true);f.flow.contextChanged();f.adapter.final("출퇴근")
        assertTrue(f.drafts.isEmpty());f.listen();f.adapter.final("출퇴근")
        assertEquals(Purpose.COMMUTE,f.drafts.single().purpose)
    }
    @Test fun timeoutAndFailureRemainManualInputStatesAndIgnoreLateSuccess() {
        val f=Fixture();f.listen();f.flow.timeout(f.flow.state.context!!);f.adapter.final("업무")
        assertEquals(SpeechPhase.ERROR,f.flow.state.phase);assertTrue(f.drafts.isEmpty())
        f.listen();val op=f.adapter.recognitions.last();op.second(SpeechEvent.Error(op.first,"권한 없음"));f.adapter.final("출퇴근")
        assertEquals(SpeechPhase.ERROR,f.flow.state.phase);assertTrue(f.drafts.isEmpty())
    }
    @Test fun mockAndDisabledAdapterNeverClaimRealRecognition() {
        val mock=MockSpeechAdapter();val drafts=mutableListOf<ParsedSpeech>();var target=SpeechTarget("trip",0,true)
        val flow=SpeechCoordinator(mock,{target},{drafts+=it},{})
        flow.start();mock.complete();assertEquals(SpeechPhase.PROMPTING,flow.state.phase)
        mock.completePrompt();mock.preview();assertTrue(drafts.isEmpty());mock.complete()
        assertEquals(1,drafts.size)
        val disabled=SpeechCoordinator(DisabledPleosSpeechAdapter(),{target},{drafts+=it},{})
        disabled.start();assertEquals(SpeechPhase.ERROR,disabled.state.phase);assertEquals(1,drafts.size)
    }
    @Test fun missingAmbiguousNegativeAndLongPurposeRequireHumanChoice() {
        for(text in listOf("업무 또는 개인 용도","출퇴근, 안 했습니다","아마 출퇴근","업무?","업무, ${"가".repeat(121)}")) {
            val result=SpeechParser.parse(text);assertNull(result.purpose);assertTrue(result.needsChoice);assertEquals(text,result.transcript)
        }
        assertEquals("거래처 미팅",SpeechParser.parse("거래처 미팅").note)
        assertEquals(Purpose.PERSONAL,SpeechParser.parse("개인 용도, 장보기").purpose)
    }
    @Test fun unknownRestrictedStaleAndDisconnectedInputAreFailClosed() {
        val valid=InputGate(ParkingState.PARKED,UxRestriction.UNRESTRICTED,true,1000)
        assertTrue(valid.allowsInput(2000));assertFalse(valid.allowsInput(31001))
        assertFalse(valid.copy(parking=ParkingState.UNKNOWN).allowsInput(2000))
        assertFalse(valid.copy(restriction=UxRestriction.UNKNOWN).allowsInput(2000))
        assertFalse(valid.copy(restriction=UxRestriction.RESTRICTED).allowsInput(2000))
        assertFalse(valid.copy(connected=false).allowsInput(2000));assertFalse(valid.allowsInput(999))
        assertFalse(InputGate().allowsInput(2000))
    }
}
