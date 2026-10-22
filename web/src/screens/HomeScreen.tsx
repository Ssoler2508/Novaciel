import { useState } from 'react';
import type { Session } from '../api/auth.js';
import { es } from '../i18n/index.js';
import { useSession } from '../session/SessionContext.js';

// Provisional home screen: it only shows what /auth/me returned. Role codes are rendered as they
// arrive; no role-specific view is built yet.
export function HomeScreen({ user }: { user: Session }) {
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
    <main className="screen">
      <section className="card" aria-labelledby="home-title">
        <p className="brand">{es.app.name}</p>
        <h1 id="home-title">{es.home.title}</h1>

        <dl className="details">
          <div>
            <dt>{es.home.name}</dt>
            <dd>{user.nombre}</dd>
          </div>
          <div>
            <dt>{es.home.email}</dt>
            <dd>{user.email}</dd>
          </div>
          <div>
            <dt>{es.home.roles}</dt>
            <dd>
              {user.roles.length === 0 ? (
                <span className="muted">{es.home.noRoles}</span>
              ) : (
                <ul className="roles">
                  {user.roles.map((role, index) => (
                    <li key={`${role.rol}-${role.clienteId ?? 'global'}-${index}`}>
                      <span>{role.rol}</span>
                      <span className="muted">{role.clienteId ?? es.home.noClient}</span>
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </div>
        </dl>

        {error !== null && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        <button className="button" type="button" onClick={onLogout} disabled={submitting}>
          {submitting ? es.auth.loggingOut : es.auth.logout}
        </button>
      </section>
    </main>
  );
}
