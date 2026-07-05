import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../App.jsx';
import { api } from '../api/client.js';
import TestForm from '../components/TestForm.jsx';
import TestHistoryTable from '../components/TestHistoryTable.jsx';
import LiveStatus from '../components/LiveStatus.jsx';
import GrafanaEmbed from '../components/GrafanaEmbed.jsx';

export default function Dashboard() {
  const { token } = useAuth();
  const [runs, setRuns]           = useState([]);
  const [page, setPage]           = useState(1);
  const [total, setTotal]         = useState(0);
  const [liveRunId, setLiveRunId] = useState(null);
  const [loading, setLoading]     = useState(false);

  const fetchRuns = useCallback(async (p = 1) => {
    setLoading(true);
    try {
      const res = await api.listTests(p, token);
      setRuns(res.items);
      setTotal(res.total);
    } catch { /* no-op */ }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => { fetchRuns(page); }, [fetchRuns, page]);

  function handleCreated(run) {
    setLiveRunId(run.id);
    fetchRuns(1);
  }

  function handleFinished() {
    fetchRuns(page);
  }

  async function handleCancel(id) {
    try {
      await api.cancelTest(id, token);
      fetchRuns(page);
    } catch (ex) {
      alert(ex.message);
    }
  }

  const totalPages = Math.ceil(total / 20);

  return (
    <div>
      <TestForm onCreated={handleCreated} />

      {liveRunId && (
        <LiveStatus runId={liveRunId} onFinished={handleFinished} />
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 40 }}>
        <h2 style={{ fontSize: 16, color: '#e2e8f0' }}>
          Test History {loading && <span style={{ fontSize: 13, color: '#64748b' }}>refreshing…</span>}
        </h2>
        <button onClick={() => fetchRuns(page)}
          style={{ background: 'none', border: '1px solid #2d3148', color: '#94a3b8',
                   padding: '6px 14px', borderRadius: 4, cursor: 'pointer', fontSize: 13 }}>
          Refresh
        </button>
      </div>

      <TestHistoryTable runs={runs} onCancel={handleCancel} />

      {totalPages > 1 && (
        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'center' }}>
          <button disabled={page <= 1} onClick={() => setPage(p => p - 1)}
            style={{ padding: '6px 14px', background: '#1a1d2e', border: '1px solid #2d3148',
                     color: '#94a3b8', borderRadius: 4, cursor: 'pointer' }}>← Prev</button>
          <span style={{ padding: '6px 14px', color: '#64748b', fontSize: 13 }}>
            {page} / {totalPages}
          </span>
          <button disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}
            style={{ padding: '6px 14px', background: '#1a1d2e', border: '1px solid #2d3148',
                     color: '#94a3b8', borderRadius: 4, cursor: 'pointer' }}>Next →</button>
        </div>
      )}

      <GrafanaEmbed />
    </div>
  );
}
