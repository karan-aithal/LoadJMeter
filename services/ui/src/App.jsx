import React, { createContext, useContext, useState } from 'react';
import { BrowserRouter, Routes, Route, Link, Navigate } from 'react-router-dom';
import Dashboard from './pages/Dashboard.jsx';
import TestDetail from './pages/TestDetail.jsx';

export const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);

const s = {
  nav: { display: 'flex', alignItems: 'center', gap: 24, padding: '12px 24px',
         background: '#1a1d2e', borderBottom: '1px solid #2d3148' },
  brand: { fontWeight: 700, fontSize: 18, color: '#7c83fd', textDecoration: 'none' },
  navLink: { color: '#94a3b8', textDecoration: 'none', fontSize: 14 },
  main: { padding: '24px', maxWidth: 1280, margin: '0 auto' },
};

function LoginPage({ onLogin }) {
  const [apiKey, setApiKey] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true); setErr('');
    try {
      const { token } = await fetch('/api/auth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey }),
      }).then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.error); return d; });
      onLogin(token);
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
      <form onSubmit={handleSubmit} style={{ background: '#1a1d2e', padding: 32, borderRadius: 8, minWidth: 320 }}>
        <h2 style={{ marginBottom: 16, color: '#7c83fd' }}>Load Test Platform</h2>
        <label style={{ display: 'block', marginBottom: 8, fontSize: 14, color: '#94a3b8' }}>API Key</label>
        <input
          type="password"
          value={apiKey}
          onChange={e => setApiKey(e.target.value)}
          style={{ width: '100%', padding: '8px 12px', background: '#0f1117', color: '#e2e8f0',
                   border: '1px solid #2d3148', borderRadius: 4, marginBottom: 16 }}
          placeholder="Enter your API key"
          required
        />
        {err && <p style={{ color: '#f87171', marginBottom: 12, fontSize: 13 }}>{err}</p>}
        <button type="submit" disabled={loading}
          style={{ width: '100%', padding: '10px', background: '#7c83fd', color: '#fff',
                   border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 600 }}>
          {loading ? 'Signing in…' : 'Sign In'}
        </button>
      </form>
    </div>
  );
}

export default function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem('lt_token') || '');

  function handleLogin(t) {
    sessionStorage.setItem('lt_token', t);
    setToken(t);
  }
  function handleLogout() {
    sessionStorage.removeItem('lt_token');
    setToken('');
  }

  if (!token) return <LoginPage onLogin={handleLogin} />;

  return (
    <AuthContext.Provider value={{ token }}>
      <BrowserRouter>
        <nav style={s.nav}>
          <Link to="/" style={s.brand}>⚡ LoadTest</Link>
          <Link to="/" style={s.navLink}>Dashboard</Link>
          <button onClick={handleLogout}
            style={{ marginLeft: 'auto', background: 'none', border: '1px solid #2d3148',
                     color: '#94a3b8', padding: '6px 14px', borderRadius: 4, cursor: 'pointer', fontSize: 13 }}>
            Sign out
          </button>
        </nav>
        <main style={s.main}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/tests/:id" element={<TestDetail />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </BrowserRouter>
    </AuthContext.Provider>
  );
}
