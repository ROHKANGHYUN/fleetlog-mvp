import { useEffect, useState } from 'react';

export class ReportingError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}
export const requestId = () => globalThis.crypto?.randomUUID?.() ?? `mvp-report-${Date.now()}-${Math.random().toString(36).slice(2)}`;
export const reportTime = (value: string | null | undefined) => value && Number.isFinite(Date.parse(value))
  ? new Intl.DateTimeFormat('ko-KR', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'Asia/Seoul' }).format(new Date(value)) : '확인 필요';
export const koreanDate = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value) + 9 * 3600000).toISOString().slice(0, 10) : '';
export const koreanMonth = (value: string) => koreanDate(value).slice(0, 7);

export async function reportingRequest<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal, cache: 'no-store', credentials: 'same-origin',
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const value = await response.json().catch(() => { throw new ReportingError('서버 응답을 확인하지 못했습니다.', response.status, 'INVALID_RESPONSE'); });
  if (!response.ok) throw new ReportingError(value?.error?.message ?? '요청을 처리하지 못했습니다.', response.status, value?.error?.code ?? 'REQUEST_FAILED');
  return value;
}

/** Polls one scope at a time. A changed month or a new refresh cancels the old request. */
export function useReportingQuery<T>(path: string) {
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [snapshot, setSnapshot] = useState<{ data: T | null; path: string; error: string; lastSuccess: string }>({ data: null, path, error: '', lastSuccess: '' });
  useEffect(() => {
    const abort = new AbortController(); let alive = true; let timer: ReturnType<typeof setTimeout>;
    setSnapshot(previous => previous.path === path ? previous : { data: null, path, error: '', lastSuccess: '' });
    async function poll() {
      try {
        const data = await reportingRequest<T>(path, undefined, abort.signal);
        if (alive) setSnapshot({ data, path, error: '', lastSuccess: new Date().toISOString() });
      } catch (cause) {
        if (alive && !abort.signal.aborted) setSnapshot(previous => ({ ...previous, error: cause instanceof Error ? cause.message : '조회하지 못했습니다.' }));
      } finally { if (alive) timer = setTimeout(() => void poll(), 1000); }
    }
    void poll();
    return () => { alive = false; abort.abort(); clearTimeout(timer); };
  }, [path, refreshVersion]);
  return { data: snapshot.path === path ? snapshot.data : null, error: snapshot.path === path ? snapshot.error : '', lastSuccess: snapshot.path === path ? snapshot.lastSuccess : '', refresh: () => setRefreshVersion(value => value + 1) };
}
