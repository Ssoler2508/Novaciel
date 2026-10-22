import { useState, type FormEvent } from 'react';
import { ApiError } from '../api/http.js';
import { es } from '../i18n/index.js';
import { useSession } from '../session/SessionContext.js';

export function LoginScreen() {
  const { login } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      // The password never stays in state after a failed attempt, and is never logged.
      setPassword('');
      if (err instanceof ApiError) {
        if (err.status === 401) setError(es.auth.invalidCredentials);
        else if (err.status === 403) setError(es.auth.forbidden);
        else setError(es.auth.error);
      } else {
        setError(es.auth.networkError);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="screen">
      <section className="card" aria-labelledby="login-title">
        <p className="brand">{es.app.name}</p>
        <h1 id="login-title">{es.auth.title}</h1>
        <form className="form" onSubmit={onSubmit}>
          <div className="field">
            <label htmlFor="email">{es.auth.email}</label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              disabled={submitting}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="password">{es.auth.password}</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              disabled={submitting}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>

          {error !== null && (
            <p className="error" role="alert">
              {error}
            </p>
          )}

          <button className="button" type="submit" disabled={submitting}>
            {submitting ? es.auth.submitting : es.auth.submit}
          </button>
        </form>
      </section>
    </main>
  );
}
