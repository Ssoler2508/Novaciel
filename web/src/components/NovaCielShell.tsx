import { useState, type ReactNode } from 'react';
import { es } from '../i18n/index.js';
import { useSession } from '../session/SessionContext.js';

export function NovaCielShell({ title, children }: { title: string; children: ReactNode }) {
  const { logout } = useSession();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onLogout() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await logout();
    } catch {
      setError(es.common.error);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="brand">{es.app.name}</p>
          <h1>{title}</h1>
        </div>
        <nav className="app-nav" aria-label={es.interna.navigation}>
          <a className="button button--secondary" href="#/">
            {es.common.backHome}
          </a>
          <button className="button button--secondary" type="button" onClick={onLogout} disabled={submitting}>
            {submitting ? es.auth.loggingOut : es.auth.logout}
          </button>
        </nav>
      </header>
      <main className="app-main">
        {error !== null && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {children}
      </main>
    </div>
  );
}
