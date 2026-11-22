import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { btn, input, useAct, Msg, TypeConfirm } from './ops-ui.jsx';

const fmt = (ms) => (ms == null ? '…' : `${(ms / 1000).toFixed(1)}s`);

// Master switch for chaos-class actions (crash/drain/partition/infra). Runtime setting `chaosEnabled`; CHAOS_ENABLED is its default.
// Turning on needs a typed confirmation; turning off is immediate. Both are audited by PUT /ops/settings.
function ChaosSwitch({ on, token }) {
  const { busy, msg, run } = useAct();
  const [ask, setAsk] = useState(false);
  const set = (v) => run(() => api.putSettings({ chaosEnabled: v }, token), v ? 'Chaos enabled' : 'Chaos disabled');
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12, padding: '8px 12px', borderRadius: 8, background: '#12141f', border: `1px solid ${on ? '#f87171' : '#2d3148'}` }}>
      <span style={{ fontSize: 13, color: on ? '#f87171' : '#94a3b8' }}>● Chaos {on ? 'ENABLED' : 'disabled'}</span>
      <span style={{ fontSize: 12, color: '#64748b', flex: 1 }}>{on ? 'Workers can be crashed, drained, partitioned or killed.' : 'Crash, drain, partition and real kills are blocked until you enable chaos.'}</span>
      <button disabled={busy} style={btn(on ? '#4ade80' : '#f87171', busy)} onClick={() => (on ? set(false) : setAsk(true))}>{on ? 'Disable chaos' : 'Enable chaos'}</button>
      <Msg msg={msg} />
      {ask && <TypeConfirm title="Enable chaos controls?" word="enable" onCancel={() => setAsk(false)} onConfirm={() => { setAsk(false); set(true); }} />}
    </div>
  );
}

// One-click "kill the worker mid-job" experiment, the same scenario as infra/scripts/chaos-kill-worker.sh:
//   launch a job -> wait until a worker runs it -> kill that worker -> watch the reaper requeue it -> retry completes.
// Timings are client-side from the live stream (frame interval granularity), like the script's polls. Not persisted.
export default function ChaosLab({ snap, token }) {
  const { busy, msg, run } = useAct();
  const [exp, setExp] = useState(null);       // { runId, phase, workerId, killedAt, retryAt, doneAt, via, status }
  const [via, setVia] = useState('crash');
  const [ask, setAsk] = useState(false);
  const [duration, setDuration] = useState(45);
  const acting = useRef(false);
  const caps = (snap && snap.capabilities) || {};
  const fleet = (snap && snap.fleet) || [];

  useEffect(() => {
    if (!exp || !snap || exp.phase === 'done') return;
    const row = (snap.recent || []).find((r) => r.id === exp.runId);
    const now = Date.now();
    if (exp.phase === 'launched') {
      const w = snap.workers.find((x) => x.runId === exp.runId);
      if (w && !acting.current) {
        acting.current = true;
        const kill = exp.via === 'kill' ? api.infraAction('kill', { target: w.workerId }, token) : api.workerCmd(w.workerId, 'crash', {}, token);
        kill.then(() => setExp((e) => ({ ...e, phase: 'killed', workerId: w.workerId, epoch: w.epoch, killedAt: Date.now() })))
            .catch((ex) => setExp((e) => ({ ...e, phase: 'done', error: ex.message })))
            .finally(() => { acting.current = false; });
      }
    } else if (exp.phase === 'killed' && row) {
      const patch = {};
      // the reaper bumps the epoch when it requeues; a retry is the run going 'running' again at a higher epoch (works even if the same worker came back)
      if (!exp.retryAt && row.status === 'running' && row.epoch > exp.epoch) patch.retryAt = now;
      if (['completed', 'failed', 'cancelled'].includes(row.status)) { patch.phase = 'done'; patch.doneAt = now; patch.status = row.status; patch.verdict = row.verdict; }
      if (Object.keys(patch).length) setExp((e) => ({ ...e, ...patch }));
    }
  }, [snap, exp, token]);

  const start = () => run(async () => {
    const r = await api.createTest({ scenario: 'fast', vus: 2, duration: `${duration}s` }, crypto.randomUUID(), token);
    setExp({ runId: r.id, phase: 'launched', via });
    return r;
  }, 'Job launched, waiting for a worker to pick it up…');

  const live = exp && exp.phase !== 'done';
  return (
    <div>
      <ChaosSwitch on={!!caps.chaos} token={token} />
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, color: '#e2e8f0' }}>Kill-worker experiment:</span>
        <select aria-label="Kill method" value={via} onChange={(e) => setVia(e.target.value)} style={input}>
          <option value="crash">soft crash (worker exits)</option>
          <option value="kill" disabled={!caps.infraDriver}>real kill (container/pod){caps.infraDriver ? '' : ' — needs a chaos driver'}</option>
        </select>
        <label style={{ fontSize: 12, color: '#94a3b8' }}>job length <input type="number" min={20} max={300} value={duration} onChange={(e) => setDuration(Number(e.target.value))} style={{ ...input, width: 60 }} /> s</label>
        <button disabled={!caps.chaos || busy || live || !fleet.length} style={btn('#f87171', !caps.chaos || busy || live || !fleet.length)} onClick={() => setAsk(true)}>Run experiment</button>
      </div>
      {fleet.length === 1 && <p style={{ color: '#94a3b8', fontSize: 12, marginTop: 6 }}>Only one worker is up: after the kill nobody can run the retry until a worker is started again (Infra panel → Start, or <code>docker compose up -d worker</code>).</p>}
      {!fleet.length && <p style={{ color: '#94a3b8', fontSize: 12, marginTop: 6 }}>No workers are reporting, so there is nothing to kill.</p>}
      <Msg msg={msg} />
      {exp && (
        <div style={{ marginTop: 12, background: '#12141f', borderRadius: 8, padding: 14, fontSize: 13 }}>
          <div>run <Link to={`/tests/${exp.runId}`} style={{ color: '#7c83fd' }}>{exp.runId.slice(0, 8)}</Link> · phase <b>{exp.phase}</b>{exp.error && <span style={{ color: '#f87171' }}> · {exp.error}</span>}</div>
          {exp.killedAt && <div style={{ color: '#94a3b8', marginTop: 4 }}>
            killed {exp.workerId.slice(0, 12)} · recovery (MTTR) {fmt(exp.retryAt && exp.retryAt - exp.killedAt)} · {exp.doneAt ? `finished ${exp.status}${exp.verdict ? ` / ${exp.verdict}` : ''} after ${fmt(exp.doneAt - exp.killedAt)}` : 'waiting for the retry to finish…'}
          </div>}
          {exp.phase === 'killed' && !exp.retryAt && <div style={{ color: '#64748b', fontSize: 12, marginTop: 4 }}>The reaper requeues after the stale window; see the Pipeline tab for the move.</div>}
        </div>
      )}
      {ask && <TypeConfirm title="Kill a worker mid-job?" word="kill" onCancel={() => setAsk(false)} onConfirm={() => { setAsk(false); start(); }} />}
    </div>
  );
}
