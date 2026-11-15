import { useEffect, useMemo, useRef, useState } from 'react';
import type { FleetController } from '../../../../packages/domain/index.mjs';
import { VoiceFlow } from '../../../../packages/domain/voice-flow.mjs';
import { createMockVoiceAdapter } from './mock-adapter.mjs';

export function useVoiceInput(controller: FleetController, visible: boolean) {
  const adapter = useMemo(() => createMockVoiceAdapter(), [controller]);
  const flow = useMemo(() => new VoiceFlow({ controller, adapter }), [controller, adapter]);
  const [voice, setVoice] = useState(() => flow.getState());
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  useEffect(() => {
    const unsubscribe = flow.subscribe(setVoice);
    const disconnect = flow.connect();
    setVoice(flow.getState());
    const active = () => flow.setForeground(visibleRef.current && document.visibilityState !== 'hidden' && document.hasFocus());
    const inactive = () => flow.setForeground(false);
    document.addEventListener('visibilitychange', active);
    window.addEventListener('blur', inactive);
    window.addEventListener('focus', active);
    window.addEventListener('pagehide', inactive);
    active();
    return () => {
      document.removeEventListener('visibilitychange', active);
      window.removeEventListener('blur', inactive);
      window.removeEventListener('focus', active);
      window.removeEventListener('pagehide', inactive);
      // disconnect cancels both operations. Keep the adapter reusable when React
      // reconnects effects (including StrictMode); terminal dispose forbids reuse.
      unsubscribe(); disconnect();
    };
  }, [flow, adapter]);
  useEffect(() => { flow.setForeground(visible && document.visibilityState !== 'hidden' && document.hasFocus()); }, [flow, visible]);
  return { voice, flow, adapter };
}
