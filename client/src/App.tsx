import { useState, useEffect, useCallback } from 'react';
import './App.css';

interface HealthResponse {
  data?: {
    ok: boolean;
  };
  error?: {
    code: string;
    message: string;
  };
}

export function App() {
  const [loading, setLoading] = useState<boolean>(true);
  const [healthData, setHealthData] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastChecked, setLastChecked] = useState<string | null>(null);

  const checkHealth = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/health');
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      const data: HealthResponse = await res.json();
      setHealthData(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reach server');
      setHealthData(null);
    } finally {
      setLoading(false);
      setLastChecked(new Date().toLocaleTimeString());
    }
  }, []);

  useEffect(() => {
    checkHealth();
  }, [checkHealth]);

  const isHealthy = healthData?.data?.ok === true;

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="badge-pill">Phase 0 — Project Setup</div>
        <h1 className="app-title">MeetBrief AI</h1>
        <p className="app-subtitle">
          Intelligent meeting minutes and context-aware follow-up assistant
        </p>
      </header>

      <main className="status-card">
        <div className="status-header">
          <div className="status-title-group">
            <span
              className={`status-indicator ${
                loading ? 'status-checking' : isHealthy ? 'status-ok' : 'status-error'
              }`}
            />
            <h2>Backend Health Status</h2>
          </div>
          <span className={`status-pill ${isHealthy ? 'pill-ok' : loading ? 'pill-checking' : 'pill-error'}`}>
            {loading ? 'Checking...' : isHealthy ? 'ONLINE' : 'OFFLINE'}
          </span>
        </div>

        <div className="status-details">
          <div className="detail-row">
            <span className="detail-label">Endpoint</span>
            <code className="detail-value">GET /api/health</code>
          </div>
          <div className="detail-row">
            <span className="detail-label">Proxy</span>
            <code className="detail-value">Vite dev proxy → Express (port 5000)</code>
          </div>
          <div className="detail-row">
            <span className="detail-label">Last Checked</span>
            <span className="detail-value">{lastChecked || 'Never'}</span>
          </div>
        </div>

        <div className="response-box">
          <div className="response-header">
            <span>Response Payload</span>
            {isHealthy && <span className="response-tag">200 OK</span>}
          </div>
          <pre className="response-json">
            {loading
              ? '// Querying /api/health...'
              : error
              ? `// Error:\n${error}`
              : JSON.stringify(healthData, null, 2)}
          </pre>
        </div>

        <button
          type="button"
          className="refresh-btn"
          onClick={checkHealth}
          disabled={loading}
          id="refresh-health-button"
        >
          {loading ? 'Connecting...' : 'Check Connection'}
        </button>
      </main>

      <footer className="architecture-note">
        <p>
          Node.js 26 · React + Vite + TypeScript · Express + Mongoose
        </p>
      </footer>
    </div>
  );
}

export default App;
