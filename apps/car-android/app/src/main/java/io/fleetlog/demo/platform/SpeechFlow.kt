package io.fleetlog.demo.platform

import io.fleetlog.demo.domain.Purpose
import java.util.UUID

data class SpeechContext(val sessionId: String, val tripId: String)
sealed interface SpeechEvent {
    val context: SpeechContext
    data class PromptCompleted(override val context: SpeechContext) : SpeechEvent
    data class Interim(override val context: SpeechContext, val text: String) : SpeechEvent
    data class Final(override val context: SpeechContext, val text: String) : SpeechEvent
    data class Ended(override val context: SpeechContext) : SpeechEvent
    data class Error(override val context: SpeechContext, val reason: String) : SpeechEvent
}

/** Application port only; method names do not claim a Pleos SDK interface. */
interface SpeechAdapter {
    val capability: Capability
    fun startPrompt(context: SpeechContext, emit: (SpeechEvent) -> Unit)
    fun stopPrompt(context: SpeechContext)
    fun startRecognition(context: SpeechContext, emit: (SpeechEvent) -> Unit)
    fun finishRecognition(context: SpeechContext)
    fun cancelRecognition(context: SpeechContext)
    fun close() {}
}

enum class MockSpeechMode { NORMAL, FAILED, EMPTY, UNAVAILABLE, TIMEOUT }
class MockSpeechAdapter : SpeechAdapter {
    override val capability: Capability = Capability.MockSupported
    var mode = MockSpeechMode.NORMAL
    var text = "일반 업무, 거래처 미팅"
    private var prompt: Pair<SpeechContext, (SpeechEvent) -> Unit>? = null
    private var recognition: Pair<SpeechContext, (SpeechEvent) -> Unit>? = null
    private var capturedMode = MockSpeechMode.NORMAL
    private var capturedText = ""
    override fun startPrompt(context: SpeechContext, emit: (SpeechEvent) -> Unit) { prompt = context to emit }
    override fun stopPrompt(context: SpeechContext) { if (prompt?.first == context) prompt = null }
    fun completePrompt() {
        val operation = prompt ?: return
        prompt = null
        operation.second(SpeechEvent.PromptCompleted(operation.first))
    }
    override fun startRecognition(context: SpeechContext, emit: (SpeechEvent) -> Unit) {
        recognition = context to emit; capturedMode = mode; capturedText = text
        if (capturedMode == MockSpeechMode.UNAVAILABLE) {
            recognition = null; emit(SpeechEvent.Error(context, "사용 불가"))
        }
    }
    fun preview() { recognition?.let { if (capturedMode == MockSpeechMode.NORMAL) it.second(SpeechEvent.Interim(it.first, capturedText)) } }
    fun complete() {
        val operation = recognition ?: return
        if (capturedMode == MockSpeechMode.TIMEOUT) return
        recognition = null
        when (capturedMode) {
            MockSpeechMode.NORMAL -> operation.second(SpeechEvent.Final(operation.first, capturedText))
            MockSpeechMode.FAILED -> operation.second(SpeechEvent.Error(operation.first, "인식 실패"))
            else -> operation.second(SpeechEvent.Ended(operation.first))
        }
    }
    override fun finishRecognition(context: SpeechContext) { if (recognition?.first == context) recognition = null }
    override fun cancelRecognition(context: SpeechContext) { if (recognition?.first == context) recognition = null }
    override fun close() { prompt = null; recognition = null }
}

class DisabledPleosSpeechAdapter : SpeechAdapter {
    override val capability = Capability.Unsupported("SpeechToText/TextToSpeech 공개 SDK는 확인했으나 팀 승인·서비스 엔진·실제 수신은 미확인입니다.")
    override fun startPrompt(context: SpeechContext, emit: (SpeechEvent) -> Unit) = emit(SpeechEvent.Error(context, capability.reason))
    override fun stopPrompt(context: SpeechContext) {}
    override fun startRecognition(context: SpeechContext, emit: (SpeechEvent) -> Unit) = emit(SpeechEvent.Error(context, capability.reason))
    override fun finishRecognition(context: SpeechContext) {}
    override fun cancelRecognition(context: SpeechContext) {}
}

data class ParsedSpeech(val transcript: String, val purpose: Purpose?, val note: String, val needsChoice: Boolean)
object SpeechParser {
    fun parse(text: String): ParsedSpeech {
        val input = text.trim()
        val patterns = listOf(Purpose.BUSINESS to Regex("일반\\s*업무|업무"), Purpose.COMMUTE to Regex("출퇴근"), Purpose.PERSONAL to Regex("개인\\s*용도|개인"))
        val mentioned = patterns.filter { it.second.containsMatchIn(input) }
        val uncertain = Regex("아마|아니|아닌|말고|모르|인지|일까|또는|혹은|불확실|애매|것\\s*같|않|없|(?:^|[\\s,])(?:안|못)(?:\\s|했|해|하|썼|쓰)").containsMatchIn(input)
        if (mentioned.size != 1 || uncertain) return ParsedSpeech(text, null, if (mentioned.isEmpty() && input.length <= 120) input else "", true)
        val match = mentioned.single().second.find(input)
        if (match?.range?.first != 0) return ParsedSpeech(text, null, "", true)
        val tail = input.substring(match.range.last + 1)
        if (tail.isNotEmpty() && !tail.first().isWhitespace() && tail.first() !in ",，:：·") return ParsedSpeech(text, null, "", true)
        val note = tail.trimStart(' ', '\t', '\n', ',', '，', ':', '：', '·').trim()
        if (note.length > 120) return ParsedSpeech(text, null, "", true)
        return ParsedSpeech(text, mentioned.single().first, note, false)
    }
}

enum class SpeechPhase { IDLE, PROMPTING, LISTENING, PROCESSING, DRAFT, ERROR }
data class SpeechState(val phase: SpeechPhase = SpeechPhase.IDLE, val context: SpeechContext? = null,
                       val interim: String = "", val transcript: String = "", val message: String = "")
data class SpeechTarget(val tripId: String, val draftVersion: Long, val inputAllowed: Boolean)

/** Memory-only session guard; it never saves a trip or original audio. */
class SpeechCoordinator(
    private val adapter: SpeechAdapter,
    private val target: () -> SpeechTarget?,
    private val applyDraft: (ParsedSpeech) -> Unit,
    private val changed: (SpeechState) -> Unit,
    private val id: () -> String = { UUID.randomUUID().toString() },
) {
    var state = SpeechState(); private set
    private var expected: SpeechTarget? = null
    private var accepting = false
    private fun publish(next: SpeechState) { state = next; changed(next) }
    private fun matches(context: SpeechContext): Boolean = accepting && context == state.context &&
        target()?.let { it.inputAllowed && it.tripId == expected?.tripId && it.draftVersion == expected?.draftVersion } == true
    fun start() {
        cancel()
        val current = target()?.takeIf { it.inputAllowed } ?: return
        expected = current; accepting = true
        val context = SpeechContext(id(), current.tripId)
        publish(SpeechState(SpeechPhase.PROMPTING, context))
        try { adapter.startPrompt(context, ::receive) } catch (_: Exception) { fail("음성을 사용할 수 없습니다.") }
    }
    fun contextChanged() { state.context?.let { if (accepting && !matches(it)) cancel() } }
    fun timeout(context: SpeechContext) { if (matches(context)) fail("음성 입력 시간이 초과됐습니다. 직접 입력하거나 미확정으로 보관하세요.") }
    fun cancel() {
        val context = state.context; accepting = false; expected = null
        if (context != null) {
            runCatching { adapter.stopPrompt(context) }
            runCatching { adapter.cancelRecognition(context) }
        }
        publish(SpeechState())
    }
    fun receive(event: SpeechEvent) {
        if (!matches(event.context)) return
        when (event) {
            is SpeechEvent.PromptCompleted -> if (state.phase == SpeechPhase.PROMPTING) {
                publish(state.copy(phase = SpeechPhase.LISTENING))
                try { adapter.stopPrompt(event.context);adapter.startRecognition(event.context, ::receive) }
                catch (_:Exception) { fail("음성 인식을 시작하지 못했습니다. 직접 입력할 수 있습니다.") }
            }
            is SpeechEvent.Interim -> if (state.phase == SpeechPhase.LISTENING) publish(state.copy(interim = event.text))
            is SpeechEvent.Final -> if (state.phase == SpeechPhase.LISTENING) {
                accepting = false // invalidate before adapter cleanup and duplicate callbacks
                try { adapter.finishRecognition(event.context) }
                catch (_:Exception) { fail("음성 작업을 정리하지 못했습니다. 직접 입력할 수 있습니다.");return }
                publish(state.copy(phase = SpeechPhase.PROCESSING, interim = ""))
                if (event.text.isBlank()) { fail("인식된 문장이 없습니다. 직접 입력하거나 다시 시도하세요."); return }
                val parsed = SpeechParser.parse(event.text)
                try {
                    applyDraft(parsed)
                    publish(state.copy(phase = SpeechPhase.DRAFT, transcript = parsed.transcript,
                        message = if (parsed.needsChoice) "용도를 하나로 확인할 수 없습니다. 직접 선택해 주세요." else "음성 초안입니다. 확인·수정 후 직접 저장하세요."))
                } catch (_: Exception) { fail("음성 초안을 반영하지 못했습니다. 직접 입력할 수 있습니다.") }
            }
            is SpeechEvent.Ended -> fail("인식된 문장이 없습니다. 직접 입력하거나 미확정으로 보관하세요.")
            is SpeechEvent.Error -> fail("${event.reason}. 직접 입력하거나 미확정으로 보관하세요.")
        }
    }
    private fun fail(message: String) {
        val previous = state
        cancel()
        publish(previous.copy(phase = SpeechPhase.ERROR, interim = "", message = message))
    }
    fun close() { cancel();runCatching { adapter.close() } }
}
