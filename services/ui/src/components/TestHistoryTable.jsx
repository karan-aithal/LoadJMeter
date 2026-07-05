import React from 'react';
import { Link } from 'react-router-dom';
import VerdictBadge from './VerdictBadge.jsx';

const th = {
  padding: '10px 12px', textAlign: 'left', fontSize: 12, fontWeight: 600,
  color: '#64748b', textTransform: 'uppercase', borderBottom: '1px solid #2d3148',
};
const td = {
  padding: '10px 12px', fontSize: 13, color: '#e2e8f0', borderBottom: '1px solid #1e2235',
};

function fmt(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

export default function TestHistoryTable({ runs, onCancel }) {
  if (!runs?.length) {
    return <p style={{ color: '#64748b', marginTop: 16, fontSize: 14 }}>No test runs yet.</p>;
  }

  return (
    <div style={{ overflowX: 'auto', marginTop: 24 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', background: '#1a1d2e', borderRadius: 8 }}>
        <thead>
          <tr>
            {['Verdict', 'Status', 'Scenario', 'VUs', 'Duration', 'Started', 'Worker', 'Actions'].map(h => (
              <th key={h} style={th}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {runs.map(run => (
            <tr key={run.id} style={{ cursor: 'pointer' }}>
              <td style={td}><VerdictBadge value={run.verdict || run.status} /></td>
              <td style={td}><VerdictBadge value={run.status} /></td>
              <td style={{ ...td, fontFamily: 'monospace' }}>{run.config?.scenario}</td>
              <td style={td}>{run.config?.vus}</td>
              <td style={td}>{run.config?.duration}</td>
              <td style={{ ...td, fontSize: 12, color: '#64748b' }}>{fmt(run.started_at || run.created_at)}</td>
              <td style={{ ...td, fontSize: 12, color: '#64748b', fontFamily: 'monospace' }}>
                {run.worker_id?.slice(0, 12) || '—'}
              </td>
              <td style={td}>
                <Link to={`/tests/${run.id}`}
                  style={{ color: '#7c83fd', textDecoration: 'none', fontSize: 13 }}>
                  View
                </Link>
                {['pending', 'running'].includes(run.status) && (
                  <button onClick={() => onCancel?.(run.id)}
                    style={{ marginLeft: 12, background: 'none', border: '1px solid #991b1b',
                             color: '#f87171', padding: '3px 10px', borderRadius: 4,
                             cursor: 'pointer', fontSize: 12 }}>
                    Cancel
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
