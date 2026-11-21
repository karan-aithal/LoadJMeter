import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth.js';
import { api } from '../api/client.js';
import useOpsStream from '../hooks/useOpsStream.js';

const th = { padding: '8px 12px', textAlign: 'left', fontSize: 12, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', borderBottom: '1px solid #2d3148' };
const td = { padding: '8px 12px', fontSize: 13, color: '#e2e8f0', borderBottom: '1px solid #1e2235' };
const btn = (color) => ({ background: 'none', border: `1px solid ${color}`, color, padding: '3px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 12, marginRight: 8 });

function Counter({ label, value, color = '#e2e8f0' }) {
  return (
    <div style={{ background: '#1a1d2e', borderRadius: 8, padding: '12px 18px', minWidth: 130 }}>
      <div style={{ fontSize: 22, fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: 12, color: '#64748b' }}>{label}</div>
    </div>
  );
}

function QueueTable({ title, queue, dlq, onRequeue, onPurge, busy }) {
  return (
    <section style={{ marginTop: 28 }}>
      <h3 style={{ fontSize: 14, color: '#e2e8f0', marginBottom: 8 }}>
        {title} <span style={{ color: '#64748b', fontWeight: 400 }}>({queue.length}{queue.items.length < queue.length ? `, showing ${queue.items.length}` : ''})</span>
      </h3>
      {!queue.items.length ? <p style={{ color: '#64748b', fontSize: 13 }}>Empty.</p> : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', background: '#1a1d2e', borderRadius: 8 }}>
            <thead><tr>
              {['Run', 'Scenario', 'Attempt', dlq ? 'Reason' : 'Last error', dlq ? 'Dead-lettered' : 'Created', ...(dlq ? ['Actions'] : [])].map((h) => <th key={h} style={th}>{h}</th>)}
            </tr></thead>
            <tbody>
              {queue.items.map((j, i) => (
                <tr key={j.id || i}>
                  <td style={{ ...td, fontFamily: 'monospace' }}>{j.id ? <Link to={`/tests/${j.id}`} style={{ color: '#7c83fd' }}>{j.id.slice(0, 8)}</Link> : <em>unparseable</em>}</td>
                  <td style={td}>{j.scenario || '—'}</td>
                  <td style={td}>{j.attempt}</td>
                  <td style={{ ...td, color: '#94a3b8' }}>{(dlq ? j.deadLetterReason : j.lastError) || '—'}</td>
                  <td style={{ ...td, fontSize: 12, color: '#64748b' }}>{(dlq ? j.deadLetteredAt : j.createdAt) ? new Date(dlq ? j.deadLetteredAt : j.createdAt).toLocaleString() : '—'}</td>
                  {dlq && (
                    <td style={td}>
                      {j.id && <>
                        <button disabled={busy} style={btn('#7c83fd')} onClick={() => onRequeue(j.id)}>Requeue</button>
                        <button disabled={busy} style={btn('#f87171')} onClick={() => onPurge(j.id)}>Purge</button>
                      </>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default function Queues() {
  const { token } = useAuth();
  const { data, mode, error } = useOpsStream(token);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { ok, text, runId? }

  async function act(fn, okText) {
    setBusy(true); setMsg(null);
    try { const r = await fn(); setMsg({ ok: true, text: okText, runId: r?.id }); }
    catch (ex) { setMsg({ ok: false, text: ex.message }); }
    finally { setBusy(false); }
  }
  const requeue = (id) => act(() => api.requeueDlq(id, token), 'Requeued as new run');
  const purge = (id) => { if (window.confirm(`Permanently remove ${id.slice(0, 8)} from the dead-letter queue?`)) act(() => api.purgeDlq(id, token), 'Purged'); };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h2 style={{ fontSize: 16, color: '#e2e8f0' }}>Queues</h2>
        <span style={{ fontSize: 12, color: mode === 'live' ? '#4ade80' : mode === 'error' ? '#f87171' : '#fbbf24' }}>● {mode}</span>
      </div>
      {error && <p style={{ color: '#f87171', fontSize: 13, marginTop: 8 }}>{error}</p>}
      {msg && (
        <p role="status" style={{ color: msg.ok ? '#4ade80' : '#f87171', fontSize: 13, marginTop: 8 }}>
          {msg.text}{msg.runId && <> — <Link to={`/tests/${msg.runId}`} style={{ color: '#7c83fd' }}>view run</Link></>}
        </p>
      )}
      {!data ? <p style={{ color: '#64748b', marginTop: 16 }}>Loading…</p> : <>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 16 }}>
          <Counter label="pending" value={data.queues.pending.length} />
          <Counter label="processing" value={data.queues.processing.length} />
          <Counter label="dead-letter" value={data.queues.dlq.length} color={data.queues.dlq.length ? '#f87171' : '#e2e8f0'} />
          <Counter label="reaped (since API start)" value={data.counters.reaped_total} color={data.counters.reaped_total ? '#fbbf24' : '#e2e8f0'} />
          <Counter label="fenced writes (since start)" value={data.counters.fenced_writes_total} />
        </div>
        <QueueTable title="jobs:dead-letter" queue={data.queues.dlq} dlq busy={busy} onRequeue={requeue} onPurge={purge} />
        <QueueTable title="jobs:processing" queue={data.queues.processing} />
        <QueueTable title="jobs:pending" queue={data.queues.pending} />
      </>}
    </div>
  );
}
