import { useEffect, useState } from 'react';
import { ApiError } from '../api/http.js';
import { getPlanRevision, type PlanRevision } from '../api/planes.js';
import { NovaCielShell } from '../components/NovaCielShell.js';
import { PlanReadOnly } from '../components/PlanReadOnly.js';
import { es } from '../i18n/index.js';
import { loadError } from '../lib/loadError.js';
import { hrefPlan, hrefPlanes } from '../router.js';
import { useSession } from '../session/SessionContext.js';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string; retryable: boolean }
  | { status: 'ready'; data: PlanRevision };

export function PlanRevisionScreen({
  clienteId,
  planId,
}: {
  clienteId: string;
  planId: string;
}) {
  const { expire } = useSession();
  const [reloadToken, setReloadToken] = useState(0);
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });

    getPlanRevision(clienteId, planId).then(
      (data) => {
        if (!cancelled) setState({ status: 'ready', data });
      },
      (error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 401) {
          expire();
          return;
        }
        setState({ status: 'error', ...loadError(error) });
      },
    );

    return () => {
      cancelled = true;
    };
  }, [clienteId, planId, reloadToken, expire]);

  return (
    <NovaCielShell title={es.planes.revisionTitle}>
      <div className="plans">
        <div className="page-actions">
          <a className="button button--secondary" href={hrefPlanes(clienteId)}>
            {es.planes.backToList}
          </a>
          <a className="button button--secondary" href={hrefPlan(clienteId, planId)}>
            {es.planes.backToPlan}
          </a>
        </div>

        <p className="muted">{es.planes.subtitle}</p>

        {state.status === 'loading' && (
          <p className="muted" role="status">
            {es.common.loading}
          </p>
        )}

        {state.status === 'error' && (
          <section className="section" aria-live="polite">
            <p className="error" role="alert">
              {state.message}
            </p>
            {state.retryable && (
              <div className="page-actions">
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={() => setReloadToken((token) => token + 1)}
                >
                  {es.common.retry}
                </button>
              </div>
            )}
          </section>
        )}

        {state.status === 'ready' && (
          <PlanReadOnly
            clienteId={clienteId}
            plan={state.data.plan}
            piezas={state.data.piezas}
          />
        )}
      </div>
    </NovaCielShell>
  );
}
