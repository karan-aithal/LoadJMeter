import { useEffect, useState } from 'react';
import { api, opsStreamUrl } from '../api/client.js';

const POLL_MS = 3000;

// Live ops snapshot from control-api. SSE first; if the stream errors (proxy without SSE, expired token) fall back
// to 3s polling, which surfaces the real error (e.g. 401) instead of EventSource's silent reconnect loop.
// ponytail: no SSE retry after falling back, a page reload re-tries it.
export default function useOpsStream(token) {
  const [data, setData] = useState(null);
  const [mode, setMode] = useState('connecting'); // connecting | live | polling | error
  const [error, setError] = useState('');

  useEffect(() => {
    let es, timer, stopped = false;

    function poll() {
      const tick = async () => {
        try { setData(await api.opsQueues(token)); setMode('polling'); setError(''); }
        catch (ex) { setMode('error'); setError(ex.message); }
      };
      tick();
      timer = setInterval(tick, POLL_MS);
    }

    if (typeof EventSource === 'undefined') poll();
    else {
      es = new EventSource(opsStreamUrl(token));
      es.onmessage = (ev) => {
        if (stopped) return;
        try { setData(JSON.parse(ev.data)); setMode('live'); setError(''); } catch { /* ignore malformed frame */ }
      };
      es.onerror = () => { es.close(); if (!stopped) poll(); };
    }

    return () => { stopped = true; es && es.close(); clearInterval(timer); };
  }, [token]);

  return { data, mode, error };
}
