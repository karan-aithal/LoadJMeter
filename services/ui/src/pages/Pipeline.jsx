import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth.js';
import { api } from '../api/client.js';
import useOpsStream from '../hooks/useOpsStream.js';
import { btn, useAct, Msg, StreamBar } from '../components/ops-ui.jsx';
import { SettingsEditor, FleetControls, QueueActions } from '../components/ControlPanels.jsx';

const COLOR = { ok: '#4ade80', warn: '#fbbf24', bad: '#f87171', idle: '#64748b' };
const W = 1100, H = 400, BW = 120, BH = 64;
const STORE = 'lt_pipeline_layout';

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
const DEFAULT_POS = Object.fromEntries(Object.entries(NODES).map(([k, n]) => [k, { x: n.x, y: n.y }]));

// id, from, to, label on the line, dashed
const EDGES = [
  ['ui-api',       'ui',         'api',        'HTTP · SSE'],
  ['api-pending',  'api',        'pending',    'LPUSH'],
  ['pend-proc',    'pending',    'processing', 'BRPOPLPUSH'],
  ['proc-workers', 'processing', 'workers',    'job + k6'],
  ['workers-db',   'workers',    'db',         'PATCH · heartbeat'],
  ['proc-reaper',  'processing', 'reaper',     'scan', true],
  ['reaper-pend',  'reaper',     'pending',    'retry', true],
  ['proc-dlq',     'processing', 'dlq',        'dead-letter', true],
];

const ageMs = (iso) => Date.now() - Date.parse(iso);
const secs = (ms) => `${Math.round(ms / 1000)}s`;

// Line between two box centres, cut where it leaves each box (+ a small gap for the arrowhead).
function edgePath(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const k = Math.min(BW / 2 / (Math.abs(dx) || 1e-9), BH / 2 / (Math.abs(dy) || 1e-9));
  const len = Math.hypot(dx, dy) || 1, gap = 5 / len;
  return `M${a.x + dx * (k + gap)},${a.y + dy * (k + gap)} L${b.x - dx * (k + gap)},${b.y - dy * (k + gap)}`;
}

function useLayout() {
  const [pos, setPos] = useState(() => {
    try { return { ...DEFAULT_POS, ...JSON.parse(localStorage.getItem(STORE) || '{}') }; } catch { return DEFAULT_POS; }
  });
  useEffect(() => { try { localStorage.setItem(STORE, JSON.stringify(pos)); } catch { /* storage blocked */ } }, [pos]);
  return [pos, setPos, () => setPos(DEFAULT_POS)];
}

function analyse(snap) {
  if (!snap) return { health: {}, sub: {}, n: {} };
  const { queues, workers, counters, active, fleet = [], settings = {} } = snap;
  const stale = settings.reaperStaleMs || 20000;
  const oldest = workers.length ? Math.max(...workers.map((w) => ageMs(w.lastHeartbeat))) : 0;
  const up = fleet.filter((w) => !w.stale);
  const health = {
    ui: 'ok', api: settings.intakePaused ? 'warn' : 'ok', db: 'ok',
    pending:    queues.pending.length > 50 ? 'bad' : queues.pending.length > 10 ? 'warn' : queues.pending.length ? 'ok' : 'idle',
    processing: queues.processing.length ? 'ok' : 'idle',
    workers:    oldest > stale ? 'bad' : oldest > stale / 2 ? 'warn' : fleet.some((w) => w.stale) ? 'bad'
              : !up.length && queues.pending.length ? 'warn' : up.length ? 'ok' : 'idle',
    reaper:     settings.reaperPaused ? 'warn' : counters.reaped_total ? 'warn' : 'idle',
    dlq:        queues.dlq.length ? 'bad' : 'idle',
  };
  const sub = {
    ui: 'dashboard', api: settings.intakePaused ? 'intake PAUSED' : `fenced ${counters.fenced_writes_total}`, db: `${active} active`,
    pending: `${queues.pending.length} queued`, processing: `${queues.processing.length} in flight`,
    workers: fleet.length ? `${workers.length} busy / ${up.length} up` : `${workers.length} busy`,
    reaper: settings.reaperPaused ? 'PAUSED' : `reaped ${counters.reaped_total}`, dlq: `${queues.dlq.length} dead`,
  };
  return { health, sub, n: { workers: workers.length, pending: queues.pending.length, dlq: queues.dlq.length, oldest } };
}

const items = (q) => q.items.map((i) => [`${(i.id || '?').slice(0, 8)} · ${i.scenario || '?'}`, `attempt ${i.attempt}${i.lastError ? ` · ${i.lastError}` : ''}`]);

// What each box / line shows in the inspector: static facts, live facts, the settings you can edit, and its actions.
function nodeDoc(id, s) {
  const { queues, workers, counters, active, recent, reaper } = s;
  const doc = {
    ui:         { rows: [['role', 'React app served by nginx'], ['talks to', 'Control API over HTTP; live feed over SSE'], ['auth', 'operator JWT']] },
    api:        { keys: ['intakePaused'], rows: [['fenced writes (since start)', counters.fenced_writes_total], ['active runs', active],
                  ['routes', 'POST /tests, /ops/*, worker PATCH + heartbeat']] },
    pending:    { actions: 'pending', rows: [['redis key', 'jobs:pending'], ...items(queues.pending)] },
    processing: { rows: [['redis key', 'jobs:processing'], ...items(queues.processing)] },
    workers:    { fleet: true, rows: workers.map((w) => [w.workerId, `run ${w.runId.slice(0, 8)} · epoch ${w.epoch} · heartbeat ${secs(ageMs(w.lastHeartbeat))} ago`]) },
    db:         { rows: [['active runs', active], ...Object.entries(recent.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {})).map(([k, v]) => [`recent ${k}`, v])] },
    reaper:     { keys: ['reaperPaused', 'reaperStaleMs', 'reaperIntervalMs', 'maxRetries'], reaperRun: true,
                  rows: [['reaped (since API start)', counters.reaped_total], ['passes', reaper.runs], ['last pass', reaper.lastRunAt ? `${new Date(reaper.lastRunAt).toLocaleTimeString()} · ${reaper.lastReaped} requeued` : 'not yet']] },
    dlq:        { actions: 'dlq', rows: [['redis key', 'jobs:dead-letter'], ...items(queues.dlq)] },
  };
  return doc[id];
}

function edgeDoc(id, s) {
  const { queues, workers, counters, reaper, settings = {} } = s;
  const oldest = workers.length ? Math.max(...workers.map((w) => ageMs(w.lastHeartbeat))) : null;
  const doc = {
    'ui-api':       { title: 'UI → Control API', rows: [['transport', 'HTTPS REST + Server-Sent Events'], ['calls', 'POST /tests · GET /ops/stream?token&ms=…'], ['auth', 'Bearer JWT (operator role)'],
                      ['note', 'EventSource cannot set headers, so the JWT rides in ?token= on the stream only']], stream: true },
    'api-pending':  { title: 'Control API → jobs:pending', keys: ['intakePaused'], rows: [['transport', 'Redis LPUSH'], ['key', 'jobs:pending'], ['idempotency', 'SET job:enqueued:<id> NX EX 24h'],
                      ['queued now', queues.pending.length]] },
    'pend-proc':    { title: 'jobs:pending → jobs:processing', rows: [['transport', 'Redis BRPOPLPUSH (atomic pop + hold)'], ['poll', 'worker blocks 2s per attempt'],
                      ['why', 'a job is never in neither list: a dead worker leaves it in processing for the reaper'], ['in flight', queues.processing.length]] },
    'proc-workers': { title: 'jobs:processing → Workers', rows: [['transport', 'payload handed to the popping worker; k6 runs as its child process'], ['busy workers', workers.length]], fleet: true },
    'workers-db':   { title: 'Workers → Postgres (via Control API)', keys: ['heartbeatIntervalMs', 'maxRetries'],
                      rows: [['transport', 'HTTP PATCH /tests/:id/status · POST /tests/:id/heartbeat'], ['auth', 'x-api-key (worker role)'],
                      ['fencing', 'every write carries the epoch; 409 means stop'], ['oldest heartbeat', oldest === null ? '—' : `${secs(oldest)} ago`], ['fenced writes', counters.fenced_writes_total]], partition: true },
    'proc-reaper':  { title: 'jobs:processing ⇢ Reaper', keys: ['reaperPaused', 'reaperStaleMs', 'reaperIntervalMs'], reaperRun: true,
                      rows: [['transport', 'Redis LRANGE + Postgres read (updated_at = heartbeat)'], ['stale after', secs(settings.reaperStaleMs || 0)],
                      ['last pass', reaper.lastRunAt ? new Date(reaper.lastRunAt).toLocaleTimeString() : 'not yet']] },
    'reaper-pend':  { title: 'Reaper ⇢ jobs:pending (retry)', keys: ['maxRetries'], rows: [['transport', 'Lua LREM + LPUSH, attempt + 1'], ['guard', 'cancel tombstone: a cancelled run is dropped, not requeued'],
                      ['retries allowed', settings.maxRetries], ['reaped (since start)', counters.reaped_total]] },
    'proc-dlq':     { title: 'jobs:processing ⇢ Dead-letter', keys: ['maxRetries'], actions: 'dlq', rows: [['transport', 'Lua LREM + LPUSH, atomic'], ['when', `attempt reaches ${settings.maxRetries} (worker or reaper)`], ['dead now', queues.dlq.length]] },
  };
  return doc[id];
}

function Dots({ path, n, color, dur = 2.4 }) {
  const c = Math.min(n, 4);
  return Array.from({ length: c }, (_, i) => (
    <circle key={i} r="4" fill={color}>
      <animateMotion dur={`${dur}s`} begin={`${-(i * dur) / c}s`} repeatCount="indefinite" path={path} />
    </circle>
  ));
}

function Inspector({ sel, snap, schema, token, stream }) {
  const { busy, msg, run } = useAct();
  if (!snap) return <p style={{ color: '#64748b', fontSize: 13 }}>Waiting for data…</p>;
  const isEdge = sel.kind === 'edge';
  const d = isEdge ? edgeDoc(sel.id, snap) : nodeDoc(sel.id, snap);
  const title = isEdge ? d.title : NODES[sel.id].label;
  const caps = snap.capabilities || {};
  return (
    <>
      <h3 style={{ fontSize: 14, color: '#7c83fd', marginBottom: 4 }}>{title}</h3>
      <div style={{ fontSize: 11, color: '#64748b', marginBottom: 10 }}>{isEdge ? 'connection' : 'component'}</div>
      {(sel.id === 'ui' || d.stream) && <div style={{ marginBottom: 12 }}><StreamBar s={stream} /></div>}

      <Section name="Details">
        {!d.rows.length && <p style={{ color: '#64748b', fontSize: 13 }}>Nothing here.</p>}
        {d.rows.map(([k, v], i) => (
          <div key={i} style={{ fontSize: 12, padding: '5px 0', borderBottom: '1px solid #2d3148' }}>
            <div style={{ color: '#e2e8f0', fontFamily: 'monospace' }}>{k}</div>
            <div style={{ color: '#94a3b8', wordBreak: 'break-word' }}>{String(v)}</div>
          </div>
        ))}
      </Section>

      {d.keys && <Section name="Settings (applied live)"><SettingsEditor keys={d.keys} values={snap.settings} schema={schema} token={token} /></Section>}
      {d.reaperRun && <Section name="Reaper">
        <button disabled={busy} style={btn('#7c83fd', busy)} onClick={() => run(() => api.reaperRun(token), (r) => `Pass done: ${r.reaped} requeued`)}>Run a pass now</button>
        <Msg msg={msg} />
      </Section>}
      {d.actions && <Section name="Queue actions"><QueueActions which={[d.actions]} settings={snap.settings} token={token} /></Section>}
      {d.fleet && <Section name="Workers"><FleetControls fleet={snap.fleet} caps={caps} token={token} /></Section>}
      {d.partition && <Section name="Chaos">
        <button disabled={busy || !caps.chaos} title={caps.chaos ? undefined : 'Disabled: set CHAOS_ENABLED=true on control-api'} style={btn('#f87171', busy || !caps.chaos)}
                onClick={() => window.confirm('Cut ALL workers off from control-api for 30s?') && run(() => api.workerCmd('*', 'partition', { seconds: 30 }, token), 'Partitioned all workers for 30s')}>
          Partition all workers (30s)
        </button>
        <Msg msg={msg} />
      </Section>}
    </>
  );
}

const Section = ({ name, children }) => (
  <section style={{ marginTop: 14 }}>
    <h4 style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase', marginBottom: 6 }}>{name}</h4>
    {children}
  </section>
);

function Node({ id, pos, health, sub, selected, onDown, onMove, onUp, onKey }) {
  const c = COLOR[health || 'idle'];
  return (
    <g role="button" tabIndex={0} aria-label={`${NODES[id].label}: ${sub || ''}. Drag or use arrow keys to move.`} style={{ cursor: 'grab', outline: 'none', touchAction: 'none' }}
       onPointerDown={(e) => onDown(e, id)} onPointerMove={onMove} onPointerUp={(e) => onUp(e, id)} onKeyDown={(e) => onKey(e, id)}>
      <rect x={pos.x - BW / 2} y={pos.y - BH / 2} width={BW} height={BH} rx="10" fill="#1a1d2e" stroke={c} strokeWidth={selected ? 3 : 1.5}
            style={{ filter: health && health !== 'idle' ? `drop-shadow(0 0 6px ${c}88)` : 'none' }} />
      <text x={pos.x} y={pos.y - 4} textAnchor="middle" fill="#e2e8f0" fontSize="13" fontWeight="600" pointerEvents="none">{NODES[id].label}</text>
      <text x={pos.x} y={pos.y + 16} textAnchor="middle" fill={c} fontSize="11" pointerEvents="none">{sub || '…'}</text>
    </g>
  );
}

export default function Pipeline() {
  const { token } = useAuth();
  const stream = useOpsStream(token);
  const { data: snap, error, paused } = stream;
  const [sel, setSel] = useState({ kind: 'node', id: 'pending' });
  const [expanded, setExpanded] = useState(false);
  const [pos, setPos, resetLayout] = useLayout();
  const [schema, setSchema] = useState(null);
  const svg = useRef(null);
  const drag = useRef(null);

  useEffect(() => { api.settings(token).then((r) => setSchema(r.schema)).catch(() => {}); }, [token]);
  useEffect(() => {
    const el = svg.current;
    if (el && el.pauseAnimations) paused ? el.pauseAnimations() : el.unpauseAnimations();
  }, [paused]);
  useEffect(() => {
    if (!expanded) return undefined;
    const onKey = (e) => e.key === 'Escape' && setExpanded(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  const toSvg = (e) => new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.current.getScreenCTM().inverse());
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const place = (id, x, y) => setPos((p) => ({ ...p, [id]: { x: clamp(x, BW / 2 + 4, W - BW / 2 - 4), y: clamp(y, BH / 2 + 4, H - BH / 2 - 4) } }));

  function onDown(e, id) {
    const pt = toSvg(e);
    drag.current = { id, dx: pos[id].x - pt.x, dy: pos[id].y - pt.y, sx: e.clientX, sy: e.clientY, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onMove(e) {
    const d = drag.current;
    if (!d || (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 4)) return; // under 4px = a click, not a drag
    d.moved = true;
    const pt = toSvg(e);
    place(d.id, pt.x + d.dx, pt.y + d.dy);
  }
  function onUp(_e, id) {
    if (drag.current && !drag.current.moved) setSel({ kind: 'node', id });
    drag.current = null;
  }
  function onKey(e, id) {
    const step = e.shiftKey ? 30 : 10;
    const move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (move) { e.preventDefault(); place(id, pos[id].x + move[0], pos[id].y + move[1]); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSel({ kind: 'node', id }); }
  }

  const a = analyse(snap);
  const path = (from, to) => edgePath(pos[from], pos[to]);
  const frame = expanded
    ? { position: 'fixed', inset: 0, zIndex: 50, background: '#0f1117', padding: 16, display: 'flex', flexDirection: 'column' }
    : {};

  return (
    <div style={frame}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: 16, color: '#e2e8f0' }}>Pipeline</h2>
        <StreamBar s={stream} />
        {snap && <span style={{ fontSize: 12, color: '#64748b' }}>{new Date(snap.at).toLocaleTimeString()}</span>}
        <span style={{ marginLeft: 'auto' }}>
          <button style={btn()} onClick={resetLayout}>Reset layout</button>
          <button style={btn()} aria-pressed={expanded} onClick={() => setExpanded((x) => !x)}>{expanded ? '⤡ Collapse (Esc)' : '⤢ Expand'}</button>
        </span>
      </div>
      {error && <p style={{ color: '#f87171', fontSize: 13, marginBottom: 8 }}>{error}</p>}

      <div style={{ display: 'flex', gap: 16, flexWrap: expanded ? 'nowrap' : 'wrap', flex: expanded ? 1 : undefined, minHeight: 0 }}>
        <div style={{ flex: '1 1 720px', minHeight: 0, borderRadius: 8, border: '1px solid #2d3148', background: '#0f1117',
                      backgroundImage: 'radial-gradient(#2d3148 1px, transparent 1px)', backgroundSize: '20px 20px' }}>
          <svg ref={svg} viewBox={`0 0 ${W} ${H}`} width="100%" height={expanded ? '100%' : undefined} role="group" aria-label="Job pipeline diagram">
            <defs>
              {Object.entries({ n: '#3b4160', s: '#7c83fd', b: COLOR.bad }).map(([k, c]) => (
                <marker key={k} id={`arrow-${k}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L10,5 L0,10 z" fill={c} />
                </marker>
              ))}
            </defs>
            {EDGES.map(([id, from, to, label, dashed]) => {
              const on = sel.kind === 'edge' && sel.id === id;
              const hot = id === 'proc-dlq' && a.n.dlq;
              const mid = { x: (pos[from].x + pos[to].x) / 2, y: (pos[from].y + pos[to].y) / 2 };
              return (
                <g key={id} style={{ cursor: 'pointer' }} onClick={() => setSel({ kind: 'edge', id })} role="button" tabIndex={0} aria-label={`Connection ${label}`}
                   onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setSel({ kind: 'edge', id })}>
                  <path d={path(from, to)} fill="none" stroke="transparent" strokeWidth="16" />
                  <path d={path(from, to)} fill="none" stroke={on ? '#7c83fd' : hot ? COLOR.bad : '#3b4160'} strokeWidth={on ? 3 : 2}
                        strokeDasharray={dashed ? '5 4' : undefined} markerEnd={`url(#arrow-${on ? 's' : hot ? 'b' : 'n'})`} />
                  <text x={mid.x} y={mid.y - 7} textAnchor="middle" fontSize="10" fill={on ? '#a5b4fc' : '#64748b'} pointerEvents="none">{label}</text>
                </g>
              );
            })}
            {snap && <>
              <Dots path={path('api', 'pending')} n={a.n.pending} color="#7c83fd" />
              <Dots path={path('pending', 'processing')} n={a.n.pending ? 1 : 0} color="#7c83fd" />
              <Dots path={path('processing', 'workers')} n={a.n.workers} color="#38bdf8" />
              <Dots path={path('workers', 'db')} n={a.n.workers} color="#4ade80" dur={3} />
              <Dots path={path('processing', 'dlq')} n={a.n.dlq ? 1 : 0} color={COLOR.bad} dur={3} />
            </>}
            {Object.keys(NODES).map((id) => (
              <Node key={id} id={id} pos={pos[id]} health={a.health[id]} sub={a.sub[id]} selected={sel.kind === 'node' && sel.id === id}
                    onDown={onDown} onMove={onMove} onUp={onUp} onKey={onKey} />
            ))}
            {snap && (snap.fleet || []).slice(0, 4).map((w, i) => (
              <text key={w.workerId} x={pos.workers.x - BW / 2} y={pos.workers.y + BH / 2 + 16 + i * 14} fill={w.stale ? COLOR.bad : '#94a3b8'} fontSize="10" fontFamily="monospace" pointerEvents="none">
                {w.workerId.slice(0, 12)} · {w.state}
              </text>
            ))}
          </svg>
        </div>

        <aside style={{ flex: expanded ? '0 0 380px' : '1 1 300px', background: '#1a1d2e', borderRadius: 8, padding: 16, minHeight: 200, overflowY: 'auto', maxHeight: expanded ? 'none' : 640 }}>
          <Inspector sel={sel} snap={snap} schema={schema} token={token} stream={stream} />
        </aside>
      </div>
      <p style={{ color: '#64748b', fontSize: 12, marginTop: 10 }}>
        Green = healthy, amber = backing up / paused / stale heartbeat, red = dead-lettered or worker lost. Click a box or a line for details and controls; drag boxes (or focus and use arrow keys) to rearrange. Layout is saved in this browser.
      </p>
    </div>
  );
}
