import React, { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { btn, input, useAct, Msg, TypeConfirm } from './ops-ui.jsx';

const STATE_COLOR = { idle: '#4ade80', busy: '#38bdf8', paused: '#fbbf24', draining: '#fbbf24', partitioned: '#f87171', unknown: '#64748b' };
const th = { textAlign: 'left', fontSize: 11, color: '#64748b', textTransform: 'uppercase', padding: '4px 6px', borderBottom: '1px solid #2d3148' };
const td = { fontSize: 12, color: '#e2e8f0', padding: '5px 6px', borderBottom: '1px solid #1e2235', verticalAlign: 'top' };

// Edits runtime settings (stored in Redis, read live by the reaper, intake gate and workers).
// `keys` picks which ones to show; `schema` (min/max/desc) comes from GET /ops/settings.
export function SettingsEditor({ keys, values, schema, token }) {
  const { busy, msg, run } = useAct();
  const [draft, setDraft] = useState({});
  if (!schema || !values) return <p style={{ color: '#64748b', fontSize: 12 }}>Loading settings…</p>;
  const save = (k, v) => run(() => api.putSettings({ [k]: v }, token), 'Saved');
  return (
    <div>
      {keys.map((k) => {
        const s = schema[k];
        if (!s) return null;
        const cur = values[k];
        return (
          <div key={k} style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 12, color: '#e2e8f0', fontFamily: 'monospace' }}>{k}</div>
            <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>{s.desc}{s.type === 'int' && ` (${s.min}–${s.max}, default ${s.def})`}</div>
            {s.type === 'bool' ? (
              <button disabled={busy} style={btn(cur ? '#fbbf24' : '#4ade80', busy)} onClick={() => save(k, !cur)}>{cur ? 'ON — turn off' : 'off — turn on'}</button>
            ) : (
              <span>
                <input type="number" aria-label={k} min={s.min} max={s.max} value={draft[k] ?? cur} style={{ ...input, width: 100 }}
                       onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
                <button disabled={busy || draft[k] === undefined || Number(draft[k]) === cur} style={{ ...btn('#7c83fd', busy || draft[k] === undefined || Number(draft[k]) === cur), marginLeft: 6 }}
                        onClick={() => save(k, Number(draft[k])).then((r) => r && setDraft(({ [k]: _, ...rest }) => rest))}>Apply</button>
              </span>
            )}
          </div>
        );
      })}
      <Msg msg={msg} />
    </div>
  );
}

// Worker fleet with per-worker and broadcast commands. Chaos-class commands need caps.chaos and a typed confirmation.
export function FleetControls({ fleet = [], caps = {}, token }) {
  const { busy, msg, run } = useAct();
  const [ask, setAsk] = useState(null);   // { id, cmd }
  const [secs, setSecs] = useState(30);
  const send = (id, cmd) => run(() => api.workerCmd(id, cmd, cmd === 'partition' ? { seconds: Number(secs) } : {}, token), (r) => `${cmd} → ${id} (${r.receivers} received)`);
  const go = (id, cmd, chaos) => (chaos ? setAsk({ id, cmd }) : send(id, cmd));
  const why = caps.chaos ? undefined : 'Disabled: set CHAOS_ENABLED=true on control-api';
  const row = (id, label, w) => (
    <tr key={id}>
      <td style={{ ...td, fontFamily: 'monospace' }}>{label}</td>
      <td style={{ ...td, color: STATE_COLOR[w?.state] || '#94a3b8' }}>{w ? (w.stale ? `${w.state} (stale ${Math.round(w.ageMs / 1000)}s)` : w.state) : 'all'}</td>
      <td style={td}>
        <button disabled={busy} style={btn('#fbbf24', busy)} onClick={() => go(id, 'pause')}>Pause</button>
        <button disabled={busy} style={btn('#4ade80', busy)} onClick={() => go(id, 'resume')}>Resume</button>
        {['drain', 'partition', 'crash'].map((c) => (
          <button key={c} title={why} disabled={busy || !caps.chaos} style={btn('#f87171', busy || !caps.chaos)} onClick={() => go(id, c, true)}>{c[0].toUpperCase() + c.slice(1)}</button>
        ))}
      </td>
    </tr>
  );
  return (
    <div>
      <div style={{ fontSize: 11, color: '#64748b', marginBottom: 6 }}>
        pause/resume stop or start job intake · drain finishes the job then exits · crash exits at once · partition cuts it off from control-api for
        <input type="number" aria-label="Partition seconds" min={5} max={300} value={secs} onChange={(e) => setSecs(e.target.value)} style={{ ...input, width: 56, margin: '0 4px' }} />s
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr><th style={th}>Worker</th><th style={th}>State</th><th style={th}>Command</th></tr></thead>
        <tbody>
          {!fleet.length && <tr><td style={td} colSpan={3}>No workers reporting. Start one: <code>docker compose up -d worker</code></td></tr>}
          {fleet.map((w) => row(w.workerId, w.workerId.slice(0, 14) + (w.runId ? ` · run ${w.runId.slice(0, 8)}` : ''), w))}
          {fleet.length > 1 && row('*', 'ALL WORKERS', null)}
        </tbody>
      </table>
      <Msg msg={msg} />
      {ask && <TypeConfirm title={`${ask.cmd} ${ask.id === '*' ? 'ALL workers' : ask.id}?`} word={ask.cmd}
                           onCancel={() => setAsk(null)} onConfirm={() => { const a = ask; setAsk(null); send(a.id, a.cmd); }} />}
    </div>
  );
}

// Real infrastructure chaos (docker containers / k8s pods). Visible only when the API has CHAOS_ENABLED + a driver.
export function InfraPanel({ caps = {}, token }) {
  const { busy, msg, run } = useAct();
  const [workers, setWorkers] = useState([]);
  const [ask, setAsk] = useState(null);
  const [secs, setSecs] = useState(30);
  const driver = caps.infraDriver;

  useEffect(() => {
    if (!driver) return undefined;
    let alive = true;
    const load = () => api.infra(token).then((r) => alive && setWorkers(r.workers)).catch(() => {});
    load(); const t = setInterval(load, 3000);
    return () => { alive = false; clearInterval(t); };
  }, [driver, token]);

  if (!driver) {
    return <p style={{ color: '#64748b', fontSize: 13 }}>
      Real-infrastructure chaos is off. Enable it with <code>CHAOS_ENABLED=true</code> and a driver (<code>CHAOS_DRIVER=docker</code> via
      {' '}<code>docker-compose.chaos.yml</code>, or <code>k8s</code> via the Helm <code>chaos.enabled</code> value).
    </p>;
  }
  const act = (action, target) => run(() => api.infraAction(action, { target, seconds: Number(secs) }, token), `${action} ${target}: done`);
  const go = (action, target) => (['kill', 'partition', 'restart'].includes(action) ? setAsk({ action, target }) : act(action, target));
  const dock = driver === 'docker';
  return (
    <div>
      <div style={{ fontSize: 11, color: '#64748b', marginBottom: 6 }}>
        driver <b>{driver}</b> · acts on worker {dock ? 'containers' : 'pods'} only
        {dock && <> · partition disconnects the container from its networks for <input type="number" aria-label="Infra partition seconds" min={5} max={300} value={secs} onChange={(e) => setSecs(e.target.value)} style={{ ...input, width: 56, margin: '0 4px' }} />s, then reconnects</>}
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr><th style={th}>{dock ? 'Container' : 'Pod'}</th><th style={th}>State</th><th style={th}>Action</th></tr></thead>
        <tbody>
          {!workers.length && <tr><td style={td} colSpan={3}>None found.</td></tr>}
          {workers.map((w) => (
            <tr key={w.id}>
              <td style={{ ...td, fontFamily: 'monospace' }}>{w.name}</td>
              <td style={td}>{w.status}</td>
              <td style={td}>
                <button disabled={busy} style={btn('#f87171', busy)} onClick={() => go('kill', w.id)}>Kill</button>
                <button disabled={busy} style={btn('#fbbf24', busy)} onClick={() => go('restart', w.id)}>Restart</button>
                {dock && <>
                  <button disabled={busy} style={btn('#4ade80', busy)} onClick={() => go('start', w.id)}>Start</button>
                  <button disabled={busy} style={btn('#f87171', busy)} onClick={() => go('partition', w.id)}>Partition</button>
                  <button disabled={busy} style={btn('#7c83fd', busy)} onClick={() => go('heal', w.id)}>Heal</button>
                </>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Msg msg={msg} />
      {ask && <TypeConfirm title={`${ask.action} ${ask.target} on real infrastructure?`} word={ask.action}
                           onCancel={() => setAsk(null)} onConfirm={() => { const a = ask; setAsk(null); act(a.action, a.target); }} />}
    </div>
  );
}

// Bulk queue actions. Purges ask for typed confirmation.
export function QueueActions({ which = ['pending', 'dlq'], settings, token }) {
  const { busy, msg, run } = useAct();
  const [ask, setAsk] = useState(null);
  const paused = settings && settings.intakePaused;
  const acts = {
    requeue: () => run(() => api.requeueDlqAll(token), (r) => `Requeued ${r.requeued} as new runs`),
    purgeDlq: () => run(() => api.purgeDlqAll(token), (r) => `Purged ${r.purged} from the dead-letter queue`),
    purgePending: () => run(() => api.purgePending(token), (r) => `Cancelled and removed ${r.purged} pending jobs`),
    intake: () => run(() => api.putSettings({ intakePaused: !paused }, token), paused ? 'Intake resumed' : 'Intake paused'),
  };
  return (
    <div>
      {which.includes('pending') && <>
        <button disabled={busy} style={btn(paused ? '#4ade80' : '#fbbf24', busy)} onClick={acts.intake}>{paused ? '▶ Resume intake' : '❚❚ Pause intake'}</button>
        <button disabled={busy} style={btn('#f87171', busy)} onClick={() => setAsk({ word: 'purge', title: 'Cancel and remove ALL pending jobs?', go: acts.purgePending })}>Purge pending</button>
      </>}
      {which.includes('dlq') && <>
        <button disabled={busy} style={btn('#7c83fd', busy)} onClick={acts.requeue}>Requeue all DLQ</button>
        <button disabled={busy} style={btn('#f87171', busy)} onClick={() => setAsk({ word: 'purge', title: 'Permanently purge the dead-letter queue?', go: acts.purgeDlq })}>Purge DLQ</button>
      </>}
      <Msg msg={msg} />
      {ask && <TypeConfirm title={ask.title} word={ask.word} onCancel={() => setAsk(null)} onConfirm={() => { const a = ask; setAsk(null); a.go(); }} />}
    </div>
  );
}

export function AuditLog({ token }) {
  const [rows, setRows] = useState([]);
  useEffect(() => {
    let alive = true;
    const load = () => api.audit(token).then((r) => alive && setRows(r.entries)).catch(() => {});
    load(); const t = setInterval(load, 4000);
    return () => { alive = false; clearInterval(t); };
  }, [token]);
  if (!rows.length) return <p style={{ color: '#64748b', fontSize: 13 }}>No operator actions recorded yet.</p>;
  return (
    <div style={{ maxHeight: 260, overflowY: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr><th style={th}>Time</th><th style={th}>Actor</th><th style={th}>Action</th><th style={th}>Detail</th><th style={th}>Result</th></tr></thead>
        <tbody>{rows.map((r, i) => (
          <tr key={i}>
            <td style={{ ...td, color: '#64748b' }}>{new Date(r.at).toLocaleTimeString()}</td>
            <td style={td}>{r.actor}</td>
            <td style={{ ...td, fontFamily: 'monospace' }}>{r.action}</td>
            <td style={{ ...td, color: '#94a3b8', wordBreak: 'break-all' }}>{JSON.stringify(r.detail)}</td>
            <td style={{ ...td, color: r.result === 'ok' ? '#4ade80' : '#f87171' }}>{r.result}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}
