import React, { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../auth.js';
import { api } from '../api/client.js';

const th = { padding: '8px 12px', textAlign: 'left', fontSize: 12, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', borderBottom: '1px solid #2d3148' };
const td = { padding: '8px 12px', fontSize: 13, color: '#e2e8f0', borderBottom: '1px solid #1e2235' };
const fmt = (n) => (typeof n === 'number' ? `${Number.isInteger(n) ? n : n.toFixed(1)}s` : '—');

function Tile({ label, value, sub, color = '#e2e8f0' }) {
  return (
    <div style={{ background: '#1a1d2e', borderRadius: 8, padding: '12px 18px', minWidth: 150 }}>
      <div style={{ fontSize: 22, fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: 12, color: '#64748b' }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

// kill at t=0 -> recovery (MTTR: retry running again) -> retry run until completion
function Timeline({ run, max }) {
  const mttr = run.mttr_seconds, done = run.completion_seconds;
  if (typeof done !== 'number' || !max) return <span style={{ color: '#64748b' }}>—</span>;
  const rec = typeof mttr === 'number' ? Math.min(mttr, done) : 0;
  const pct = (v) => `${(v / max) * 100}%`;
  return (
    <div role="img" aria-label={`recovery ${fmt(mttr)}, completed after ${fmt(done)}`}
         style={{ display: 'flex', height: 12, width: 260, background: '#0f1117', borderRadius: 3, overflow: 'hidden' }}>
      <div title={`recovery (MTTR) ${fmt(mttr)}`} style={{ width: pct(rec), background: '#fbbf24' }} />
      <div title={`retry run ${fmt(done - rec)}`} style={{ width: pct(done - rec), background: '#4ade80' }} />
    </div>
  );
}

const SKIP = new Set(['file', 'kind', 'env', 'job']);

export default function Chaos() {
  const { token } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null);

  const load = useCallback(async () => {
    try { setData(await api.opsChaos(token)); setError(''); } catch (ex) { setError(ex.message); }
  }, [token]);
  useEffect(() => { load(); }, [load]);

  const s = data?.summary;
  const max = data ? Math.max(0, ...data.runs.map((r) => r.completion_seconds || 0)) : 0;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h2 style={{ fontSize: 16, color: '#e2e8f0' }}>Chaos &amp; recovery runs</h2>
        <button onClick={load} style={{ marginLeft: 'auto', background: 'none', border: '1px solid #2d3148', color: '#94a3b8', padding: '5px 14px', borderRadius: 4, cursor: 'pointer', fontSize: 13 }}>Refresh</button>
      </div>
      {error && <p style={{ color: '#f87171', fontSize: 13, marginTop: 8 }}>{error}</p>}
      {data && !s && <p style={{ color: '#64748b', marginTop: 16, fontSize: 14 }}>No results found in <code>{data.dir}</code>.</p>}

      {s && <>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 16 }}>
          <Tile label="runs passed" value={`${s.passed}/${s.runs}`} color={s.passed === s.runs ? '#4ade80' : '#fbbf24'} />
          <Tile label="lost jobs" value={s.lost_jobs} color={s.lost_jobs ? '#f87171' : '#4ade80'} />
          <Tile label="duplicate completions" value={s.duplicate_completions} color={s.duplicate_completions ? '#f87171' : '#4ade80'} />
          <Tile label="MTTR p50 / p95" value={`${fmt(s.mttr_seconds.p50)} / ${fmt(s.mttr_seconds.p95)}`} sub={`max ${fmt(s.mttr_seconds.max)}`} />
          <Tile label="completion p50 / p95" value={`${fmt(s.completion_seconds.p50)} / ${fmt(s.completion_seconds.p95)}`} sub={`max ${fmt(s.completion_seconds.max)}`} />
        </div>
        {s.git_shas.length > 1 && (
          <p role="note" style={{ color: '#fbbf24', fontSize: 13, marginTop: 12 }}>
            ⚠ These runs span {s.git_shas.length} code versions ({s.git_shas.map((g) => g.slice(0, 7)).join(', ')}); aggregates mix old and new behaviour.
          </p>
        )}

        <div style={{ overflowX: 'auto', marginTop: 20 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', background: '#1a1d2e', borderRadius: 8 }}>
            <thead><tr>{['Run', 'Kind', 'Result', 'MTTR', 'Completion', 'Timeline', 'Code'].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>
              {data.runs.map((r) => (
                <React.Fragment key={r.file}>
                  <tr onClick={() => setOpen(open === r.file ? null : r.file)} style={{ cursor: 'pointer' }} aria-expanded={open === r.file}>
                    <td style={{ ...td, fontFamily: 'monospace' }}>{r.file.replace('.json', '')}</td>
                    <td style={td}>{r.kind}</td>
                    <td style={{ ...td, color: r.result === 'PASS' ? '#4ade80' : '#f87171', fontWeight: 700 }}>{r.result || '—'}</td>
                    <td style={td}>{fmt(r.mttr_seconds)}</td>
                    <td style={td}>{fmt(r.completion_seconds)}</td>
                    <td style={td}><Timeline run={r} max={max} /></td>
                    <td style={{ ...td, fontFamily: 'monospace', fontSize: 12, color: r.env?.uncommitted_files ? '#fbbf24' : '#64748b' }}>
                      {r.env?.git_sha?.slice(0, 7) || '—'}{r.env?.uncommitted_files ? ` +${r.env.uncommitted_files} dirty` : ''}
                    </td>
                  </tr>
                  {open === r.file && (
                    <tr><td colSpan={7} style={{ ...td, background: '#12141f' }}>
                      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: 12 }}>
                        {Object.entries(r).filter(([k, v]) => !SKIP.has(k) && v !== null && typeof v !== 'object').map(([k, v]) => (
                          <div key={k}><span style={{ color: '#64748b' }}>{k}</span> <span style={{ fontFamily: 'monospace' }}>{String(v)}</span></div>
                        ))}
                      </div>
                    </td></tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ color: '#64748b', fontSize: 12, marginTop: 10 }}>
          <span style={{ color: '#fbbf24' }}>■</span> recovery (kill → retry running) &nbsp;
          <span style={{ color: '#4ade80' }}>■</span> retry run to completion. Click a row for all fields.
        </p>
      </>}
    </div>
  );
}
