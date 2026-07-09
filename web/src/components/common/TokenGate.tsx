import { useState } from 'react';
import { login } from '../../api/rest.js';

/** First-run token entry. Casper needs the shared secret to reach the server. */
export function TokenGate({ onReady }: { onReady: () => void }) {
  const [token, setTok] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const submit = async () => {
    setChecking(true);
    setError(null);
    try {
      // Exchange the shared secret for an httpOnly session cookie.
      await login(token.trim());
      onReady();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="gate">
      <img className="gate-logo" src="/logo.svg" alt="" />
      <h1 className="gate-title">Casper</h1>
      <p className="gate-sub">Enter your access token to continue.</p>
      <input
        className="gate-input"
        type="password"
        value={token}
        placeholder="access token"
        onChange={(e) => setTok(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
      />
      {error && <p className="gate-error">{error}</p>}
      <button className="btn-primary gate-btn" onClick={submit} disabled={checking}>
        {checking ? 'Checking…' : 'Continue'}
      </button>
    </div>
  );
}
