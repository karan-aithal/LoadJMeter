import React, { useEffect, useState } from 'react';
import { useAuth } from '../App.jsx';
import { api } from '../api/client.js';
import VerdictBadge from './VerdictBadge.jsx';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const POLL_MS = 3000;

export default function LiveStatus({ runId, onFinished }) {
  const { token } = useAuth();
  const [run, setRun] = useState(null);

  useEffect(() => {
    if (!runId) return;
    let active = true;

    async function poll() {
      try {
        const data = await api.getTest(runId, token);
        if (!active) return;
        setRun(data);
        if (TERMINAL.has(data.status)) {
          onFinished?.(data);
          return;
        }
        setTimeout(poll, POLL_MS);
      } catch {
        if (active) setTimeout(poll, POLL_MS * 2);
      }
    }

    poll();
    return () => { active = false; };
  }, [runId, token]);

  if (!run) return null;

  const elapsed = run.started_at
    ? Math.round((Date.now() - new Date(run.started_at)) / 1000) + 's'
    : null;

  return (
    <div style={{ background: '#1a1d2e', borderRadius: 8, padding: '20px 24px', marginTop: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 12 }}>
        <span style={{ fontSize: 14, color: '#94a3b8' }}>Live Status</span>
        <VerdictBadge value={run.status} />
        {run.verdict && <VerdictBadge value={run.verdict} size="lg" />}
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <tbody>
          {[
            ['ID',       run.id],
            ['Scenario', run.config?.scenario],
            ['VUs',      run.config?.vus],
            ['Duration', run.config?.duration],
            ['Worker',   run.worker_id || '—'],
            ['Elapsed',  elapsed || '—'],
            ['Error',    run.error_message || '—'],
          ].map(([k, v]) => (
            <tr key={k}>
              <td style={{ padding: '4px 0', color: '#94a3b8', width: 100 }}>{k}</td>
              <td style={{ padding: '4px 0', color: '#e2e8f0', wordBreak: 'break-all' }}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!TERMINAL.has(run.status) && (
        <div style={{ marginTop: 12 }}>
          <div style={{ height: 4, background: '#2d3148', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: '40%', background: '#7c83fd',
                          animation: 'indeterminate 1.5s infinite linear',
                          borderRadius: 2 }} />
          </div>
          <style>{`@keyframes indeterminate{0%{transform:translateX(-150%)}100%{transform:translateX(350%)}}`}</style>
        </div>
      )}
    </div>
  );
}
