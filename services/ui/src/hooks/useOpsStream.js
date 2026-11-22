import { useEffect, useState } from 'react';
import { api, opsStreamUrl } from '../api/client.js';

const POLL_MS = 3000;
const KEY = 'lt_stream_ms';
const readMs = () => { try { return parseInt(localStorage.getItem(KEY), 10) || 2000; } catch { return 2000; } };

// Live ops snapshot from control-api. SSE first; if the stream errors (proxy without SSE, expired token) fall back
// to polling, which surfaces the real error (e.g. 401) instead of EventSource's silent reconnect loop.
// Operator controls: `paused` closes the connection (last data stays on screen), `intervalMs` is the frame interval.
// ponytail: no SSE retry after falling back, a page reload re-tries it.
export default function useOpsStream(token) {
  const [data, setData] = useState(null);
  const [mode, setMode] = useState('connecting'); // connecting | live | polling | paused | error
  const [error, setError] = useState('');
  const [paused, setPaused] = useState(false);
  const [intervalMs, setIntervalMsState] = useState(readMs);

  const setIntervalMs = (ms) => { setIntervalMsState(ms); try { localStorage.setItem(KEY, String(ms)); } catch { /* storage blocked */ } };

  useEffect(() => {
    if (paused) { setMode('paused'); return undefined; }
    let es, timer, stopped = false;

    function poll() {
      const tick = async () => {
        try { setData(await api.opsQueues(token)); setMode('polling'); setError(''); }
        catch (ex) { setMode('error'); setError(ex.message); }
      };
      tick();
      timer = setInterval(tick, Math.max(POLL_MS, intervalMs));
    }

    if (typeof EventSource === 'undefined') poll();
    else {
      setMode('connecting');
      es = new EventSource(opsStreamUrl(token, intervalMs));
      es.onmessage = (ev) => {
        if (stopped) return;
        try { setData(JSON.parse(ev.data)); setMode('live'); setError(''); } catch { /* ignore malformed frame */ }
      };
      es.onerror = () => { es.close(); if (!stopped) poll(); };
    }

    return () => { stopped = true; es && es.close(); clearInterval(timer); };
  }, [token, paused, intervalMs]);

  return { data, mode, error, paused, setPaused, intervalMs, setIntervalMs };
}
