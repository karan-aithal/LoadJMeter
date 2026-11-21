import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth.js';
import useOpsStream from '../hooks/useOpsStream.js';

const COLOR = { ok: '#4ade80', warn: '#fbbf24', bad: '#f87171', idle: '#64748b' };
const STALE_MS = 20000; // matches REAPER_STALE_MS default

// Node centres on a 1100x360 canvas. Boxes are 120x64.
const NODES = {
  ui:         { x: 80,   y: 110, label: 'UI' },
  api:        { x: 270,  y: 110, label: 'Control API' },
  pending:    { x: 460,  y: 110, label: 'jobs:pending' },
  processing: { x: 650,  y: 110, label: 'jobs:processing' },
  workers:    { x: 840,  y: 110, label: 'Workers' },
  db:         { x: 1020, y: 110, label: 'Postgres' },
  reaper:     { x: 460,  y: 290, label: 'Reaper' },
  dlq:        { x: 650,  y: 290, label: 'Dead-letter' },
};
// [id, svg path, dashed]
const EDGES = [
  ['ui-api',        'M140,110 L210,110'],
  ['api-pending',   'M330,110 L400,110'],
  ['pend-proc',     'M520,110 L590,110'],
  ['proc-workers',  'M710,110 L780,110'],
  ['workers-db',    'M900,110 L960,110'],
  ['proc-reaper',   'M620,142 L490,258', true],
  ['reaper-pend',   'M460,258 L460,142', true],
  ['proc-dlq',      'M650,142 L650,258', true],
];

const ageMs = (iso) => Date.now() - Date.parse(iso);

function analyse(snap) {
  if (!snap) return { health: {}, sub: {} };
  const { queues, workers, counters, active } = snap;
  const ages = workers.map((w) => ageMs(w.lastHeartbeat));
  const oldest = ages.length ? Math.max(...ages) : 0;
  const health = {
    ui: 'ok', api: 'ok', db: 'ok',
    pending:    queues.pending.length > 50 ? 'bad' : queues.pending.length > 10 ? 'warn' : queues.pending.length ? 'ok' : 'idle',
    processing: queues.processing.length ? 'ok' : 'idle',
    workers:    oldest > STALE_MS ? 'bad' : oldest > STALE_MS / 2 ? 'warn'
              : !workers.length && queues.pending.length ? 'warn' : workers.length ? 'ok' : 'idle',
    reaper:     counters.reaped_total ? 'warn' : 'idle',
    dlq:        queues.dlq.length ? 'bad' : 'idle',
  };
  const sub = {
    ui: 'dashboard', api: `fenced ${counters.fenced_writes_total}`, db: `${active} active`,
    pending: `${queues.pending.length} queued`, processing: `${queues.processing.length} in flight`,
    workers: `${workers.length} busy`, reaper: `reaped ${counters.reaped_total}`, dlq: `${queues.dlq.length} dead`,
  };
  return { health, sub, workers: workers.length, pending: queues.pending.length, dlq: queues.dlq.length };
}

function detail(sel, snap) {
  const { queues, workers, counters, active, recent } = snap;
  const items = (q) => q.items.map((i) => [`${(i.id || '?').slice(0, 8)} · ${i.scenario || '?'}`, `attempt ${i.attempt}${i.lastError ? ` · ${i.lastError}` : ''}`]);
  switch (sel) {
    case 'pending': case 'processing': case 'dlq': return items(queues[sel]);
    case 'workers': return workers.map((w) => [w.workerId, `run ${w.runId.slice(0, 8)} · epoch ${w.epoch} · heartbeat ${Math.round(ageMs(w.lastHeartbeat) / 1000)}s ago`]);
    case 'reaper':  return [['reaped (since API start)', counters.reaped_total], ['stale after', `${STALE_MS / 1000}s without heartbeat`]];
    case 'api':     return [['fenced writes (since start)', counters.fenced_writes_total], ['active runs', active]];
    default:        return [['active runs', active], ...Object.entries(recent.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {})).map(([k, v]) => [`recent ${k}`, v])];
  }
}

function Dots({ path, n, color, dur = 2.4 }) {
  return Array.from({ length: Math.min(n, 4) }, (_, i) => (
    <circle key={i} r="4" fill={color}>
      <animateMotion dur={`${dur}s`} begin={`${-(i * dur) / Math.min(n, 4)}s`} repeatCount="indefinite" path={path} />
    </circle>
  ));
}

function Node({ id, health, sub, selected, onSelect }) {
  const n = NODES[id];
  const c = COLOR[health || 'idle'];
  return (
    <g role="button" tabIndex={0} aria-label={`${n.label}: ${sub || ''}`} style={{ cursor: 'pointer', outline: 'none' }}
       onClick={() => onSelect(id)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSelect(id)}>
      <rect x={n.x - 60} y={n.y - 32} width="120" height="64" rx="10" fill="#1a1d2e" stroke={c} strokeWidth={selected ? 3 : 1.5}
            style={{ filter: health && health !== 'idle' ? `drop-shadow(0 0 6px ${c}88)` : 'none' }} />
      <text x={n.x} y={n.y - 4} textAnchor="middle" fill="#e2e8f0" fontSize="13" fontWeight="600">{n.label}</text>
      <text x={n.x} y={n.y + 16} textAnchor="middle" fill={c} fontSize="11">{sub || '…'}</text>
    </g>
  );
}

const MODE_COLOR = { live: '#4ade80', polling: '#fbbf24', connecting: '#64748b', error: '#f87171' };

export default function Pipeline() {
  const { token } = useAuth();
  const { data, mode, error } = useOpsStream(token);
  const [paused, setPaused] = useState(false);
  const [snap, setSnap] = useState(null);
  const [sel, setSel] = useState('pending');
  const svg = useRef(null);

  useEffect(() => { if (!paused && data) setSnap(data); }, [data, paused]);
  useEffect(() => {
    const el = svg.current;
    if (el && el.pauseAnimations) paused ? el.pauseAnimations() : el.unpauseAnimations();
  }, [paused]);

  const a = analyse(snap);
  const rows = snap ? detail(sel, snap) : [];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <h2 style={{ fontSize: 16, color: '#e2e8f0' }}>Pipeline</h2>
        <span style={{ fontSize: 12, color: MODE_COLOR[mode] }}>● {mode}</span>
        {snap && <span style={{ fontSize: 12, color: '#64748b' }}>{new Date(snap.at).toLocaleTimeString()}</span>}
        <button onClick={() => setPaused((p) => !p)} aria-pressed={paused}
          style={{ marginLeft: 'auto', background: 'none', border: '1px solid #2d3148', color: '#94a3b8', padding: '5px 14px', borderRadius: 4, cursor: 'pointer', fontSize: 13 }}>
          {paused ? '▶ Play' : '❚❚ Pause'}
        </button>
      </div>
      {error && <p style={{ color: '#f87171', fontSize: 13, marginBottom: 8 }}>{error}</p>}

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 720px', borderRadius: 8, border: '1px solid #2d3148', background: '#0f1117',
                      backgroundImage: 'radial-gradient(#2d3148 1px, transparent 1px)', backgroundSize: '20px 20px' }}>
          <svg ref={svg} viewBox="0 0 1100 360" width="100%" role="img" aria-label="Job pipeline diagram">
            {EDGES.map(([id, d, dashed]) => (
              <path key={id} d={d} fill="none" stroke={id === 'proc-dlq' && a.dlq ? COLOR.bad : '#3b4160'} strokeWidth="2" strokeDasharray={dashed ? '5 4' : undefined} />
            ))}
            {snap && <>
              <Dots path="M330,110 L400,110" n={a.pending} color="#7c83fd" />
              <Dots path="M520,110 L590,110" n={a.pending ? 1 : 0} color="#7c83fd" />
              <Dots path="M710,110 L780,110" n={a.workers} color="#38bdf8" />
              <Dots path="M900,110 L960,110" n={a.workers} color="#4ade80" dur={3} />
              <Dots path="M650,142 L650,258" n={a.dlq ? 1 : 0} color={COLOR.bad} dur={3} />
            </>}
            {Object.keys(NODES).map((id) => (
              <Node key={id} id={id} health={a.health[id]} sub={a.sub[id]} selected={sel === id} onSelect={setSel} />
            ))}
            {/* worker chips */}
            {snap && snap.workers.slice(0, 4).map((w, i) => (
              <text key={w.workerId} x="780" y={170 + i * 16} fill="#94a3b8" fontSize="10" fontFamily="monospace">{w.workerId.slice(0, 18)}</text>
            ))}
          </svg>
        </div>

        <aside style={{ flex: '1 1 260px', background: '#1a1d2e', borderRadius: 8, padding: 16, minHeight: 200 }}>
          <h3 style={{ fontSize: 14, color: '#7c83fd', marginBottom: 10 }}>{NODES[sel].label}</h3>
          {!rows.length && <p style={{ color: '#64748b', fontSize: 13 }}>Nothing here.</p>}
          {rows.map(([k, v], i) => (
            <div key={i} style={{ fontSize: 12, padding: '6px 0', borderBottom: '1px solid #2d3148' }}>
              <div style={{ color: '#e2e8f0', fontFamily: 'monospace' }}>{k}</div>
              <div style={{ color: '#94a3b8' }}>{String(v)}</div>
            </div>
          ))}
        </aside>
      </div>
      <p style={{ color: '#64748b', fontSize: 12, marginTop: 10 }}>
        Green = healthy, amber = backing up / stale heartbeat, red = dead-lettered or worker lost. Click a node for details.
      </p>
    </div>
  );
}
