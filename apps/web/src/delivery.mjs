/** Read-only UI presentation of the controller's persisted delivery state. */
/** @param {import('../../../packages/domain/index.mjs').FleetState} state
 * @param {import('../../../packages/domain/index.mjs').LocalTrip} record */
export function deliveryStatus(state, record) {
  const events = state.outbox.filter(event => event.tripId === record.tripId);
  // Include predecessors: a newer revision may be waiting on an older failure.
  if (events.some(event => event.status === 'conflict')) {
    return { kind: 'conflict', tone: 'warning', label: '버전 충돌', detail: '서버 기록과 달라 전송을 멈췄습니다. 개발 담당자의 확인이 필요합니다.' };
  }
  if (events.some(event => event.status === 'blocked')) {
    return { kind: 'blocked', tone: 'error', label: '전송 오류 · 원인 확인 필요', detail: '요청 형식·권한 또는 서버 응답을 확인해야 합니다. 이 기록과 후속 변경을 보존하고 전송을 보류했습니다.' };
  }
  if (record.ackedLocalRevision >= record.localRevision) {
    return { kind: 'received', tone: 'success', label: '서버 수신 완료', detail: 'Fleetlog 비즈에서 이 기록을 확인할 수 있습니다.' };
  }
  if (events.some(event => event.eventId === state.inFlightEventId)) {
    return { kind: 'sending', tone: 'neutral', label: '전송 중 · 수신 확인 중', detail: '아직 서버 ACK의 로컬 저장을 완료하지 않았습니다. 후속 수정이 있으면 앞선 수신 확인 뒤에 전송합니다.' };
  }
  if (events.some(event => event.lastError)) {
    const invalidAck = events.some(event => event.failureKind === 'ack');
    return { kind: 'failed', tone: 'error', label: invalidAck ? '서버 수신 응답 확인 필요' : '전송 실패 · 재시도 가능', detail: invalidAck ? '응답의 이벤트·리비전·버전이 맞지 않습니다. 원인을 확인한 뒤 동일 이벤트로 재시도해 주세요.' : '이 기기의 기록은 보관되어 있습니다. 연결을 확인한 뒤 다시 전송해 주세요.' };
  }
  return {
    kind: 'pending', tone: 'warning', label: state.online ? '전송 대기' : '오프라인 · 전송 대기',
    detail: record.ackedLocalRevision > 0
      ? '이번 수정본은 전송 대기 중입니다. Fleetlog 비즈에는 이전 수신본이 표시됩니다.'
      : '아직 서버 수신을 확인하지 못했습니다. 아래에서 전송 상태를 확인해 주세요.',
  };
}
