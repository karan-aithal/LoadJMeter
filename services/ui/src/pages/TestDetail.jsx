import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../App.jsx';
import { api } from '../api/client.js';
import VerdictBadge from '../components/VerdictBadge.jsx';
import LiveStatus from '../components/LiveStatus.jsx';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

function Field({ label, value }) {
  return (
    <tr>
      <td style={{ padding: '6px 0', color: '#64748b', fontSize: 13, width: 140 }}>{label}</td>
      <td style={{ padding: '6px 0', color: '#e2e8f0', fontSize: 13, wordBreak: 'break-all' }}>
        {value ?? '—'}
      </td>
    </tr>
  );
}

export default function TestDetail() {
  const { id } = useParams();
  const { token } = useAuth();
  const navigate = useNavigate();
  const [run, setRun] = useState(null);
  const [err, setErr] = useState('');
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    api.getTest(id, token).then(setRun).catch(e => setErr(e.message));
  }, [id, token]);

  async function handleCancel() {
    setCancelling(true);
    try {
      const updated = await api.cancelTest(id, token);
      setRun(updated);
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setCancelling(false);
    }
  }

  if (err) return <p style={{ color: '#f87171', marginTop: 16 }}>{err}</p>;
  if (!run) return <p style={{ color: '#64748b', marginTop: 16 }}>Loading…</p>;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 28 }}>
        <button onClick={() => navigate(-1)}
          style={{ background: 'none', border: '1px solid #2d3148', color: '#94a3b8',
                   padding: '6px 14px', borderRadius: 4, cursor: 'pointer', fontSize: 13 }}>
          ← Back
        </button>
        <h2 style={{ fontSize: 18, color: '#e2e8f0' }}>Test Run</h2>
      </div>

      {/* Verdict — front and center */}
      <div style={{ background: '#1a1d2e', borderRadius: 8, padding: '24px', marginBottom: 24,
                    display: 'flex', alignItems: 'center', gap: 20 }}>
        <div>
          <p style={{ fontSize: 12, color: '#64748b', marginBottom: 6 }}>VERDICT</p>
          <VerdictBadge value={run.verdict || run.status} size="lg" />
        </div>
        {run.error_message && (
          <div style={{ borderLeft: '2px solid #374151', paddingLeft: 20 }}>
            <p style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>ERROR</p>
            <p style={{ fontSize: 13, color: '#f87171' }}>{run.error_message}</p>
          </div>
        )}
        {!TERMINAL.has(run.status) && (
          <button onClick={handleCancel} disabled={cancelling}
            style={{ marginLeft: 'auto', background: '#7f1d1d', border: '1px solid #991b1b',
                     color: '#f87171', padding: '8px 20px', borderRadius: 4,
                     cursor: 'pointer', fontWeight: 600 }}>
            {cancelling ? 'Cancelling…' : 'Cancel Run'}
          </button>
        )}
      </div>

      {/* Details table */}
      <div style={{ background: '#1a1d2e', borderRadius: 8, padding: 24, marginBottom: 24 }}>
        <h3 style={{ fontSize: 14, color: '#94a3b8', marginBottom: 16 }}>Details</h3>
        <table style={{ borderCollapse: 'collapse' }}>
          <tbody>
            <Field label="ID"           value={run.id} />
            <Field label="Status"       value={<VerdictBadge value={run.status} />} />
            <Field label="Scenario"     value={run.config?.scenario} />
            <Field label="VUs"          value={run.config?.vus} />
            <Field label="Duration"     value={run.config?.duration} />
            <Field label="Ramp-up"      value={run.config?.rampUp || '—'} />
            <Field label="Ramp-down"    value={run.config?.rampDown || '—'} />
            <Field label="Worker"       value={run.worker_id} />
            <Field label="Created"      value={run.created_at ? new Date(run.created_at).toLocaleString() : null} />
            <Field label="Started"      value={run.started_at ? new Date(run.started_at).toLocaleString() : null} />
            <Field label="Completed"    value={run.completed_at ? new Date(run.completed_at).toLocaleString() : null} />
          </tbody>
        </table>
      </div>

      {/* Live polling if still running */}
      {!TERMINAL.has(run.status) && (
        <LiveStatus runId={run.id} onFinished={updated => setRun(updated)} />
      )}
    </div>
  );
}
