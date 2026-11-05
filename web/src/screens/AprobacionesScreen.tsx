import { useCallback, useEffect, useState } from 'react';
import { getPendientes, type Pendientes, type PiezaPendiente, type PlanPendiente } from '../api/aprobaciones.js';
import { ApiError } from '../api/http.js';
import { es } from '../i18n/index.js';
import { esEstadoPieza, etiquetaEstadoPieza } from '../i18n/estados.js';
import { formatDateOnly, formatDateTime } from '../lib/dates.js';
import { hrefRevision } from '../router.js';
import { useSession } from '../session/SessionContext.js';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string; retryable: boolean }
  | { status: 'ready'; data: Pendientes };

interface LoadError {
  message: string;
  retryable: boolean;
}

function loadError(error: unknown): LoadError {
  if (error instanceof ApiError) {
    if (error.status === 403) return { message: es.common.forbidden, retryable: false };
    if (error.status === 404) return { message: es.common.notFound, retryable: false };
    return { message: es.common.loadError, retryable: true };
  }
  return { message: es.common.networkError, retryable: true };
}

function Meta({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function PiezaCard({ pieza }: { pieza: PiezaPendiente }) {
  const estado = esEstadoPieza(pieza.estado) ? etiquetaEstadoPieza(pieza.estado) : pieza.estado;
  return (
    <article className="approval-card">
      <dl className="meta-grid">
        <Meta label={es.aprobaciones.red} value={pieza.red} />
        <Meta label={es.aprobaciones.formato} value={pieza.formato} />
        <Meta label={es.aprobaciones.estado} value={estado} />
        <Meta label={es.aprobaciones.fechaHora} value={formatDateTime(pieza.fecha_hora)} />
        <Meta label={es.aprobaciones.version} value={pieza.version} />
      </dl>
    </article>
  );
}

function PlanCard({ plan }: { plan: PlanPendiente }) {
  return (
    <article className="approval-card">
      <dl className="meta-grid">
        <Meta label={es.aprobaciones.week} value={formatDateOnly(plan.semana_inicio)} />
        <Meta label={es.aprobaciones.piecesCount} value={plan.piezas} />
        <Meta label={es.aprobaciones.firstDeadline} value={formatDateTime(plan.primer_plazo)} />
      </dl>
    </article>
  );
}

export function AprobacionesScreen({ clienteId }: { clienteId: string }) {
  const { expire } = useSession();
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const data = await getPendientes(clienteId);
      setState({ status: 'ready', data });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        expire();
        return;
      }
      setState({ status: 'error', ...loadError(error) });
    }
  }, [clienteId, expire]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="screen screen--wide">
      <div className="approvals">
        <header className="page-header">
          <div>
            <p className="brand">{es.app.name}</p>
            <h1>{es.aprobaciones.title}</h1>
            <p className="muted">{es.aprobaciones.subtitle}</p>
          </div>
          <a className="button button--secondary" href="#/">
            {es.common.backHome}
          </a>
        </header>

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
            <div className="page-actions">
              {state.retryable && (
                <button className="button button--secondary" type="button" onClick={() => void load()}>
                  {es.common.retry}
                </button>
              )}
              <a className="button button--secondary" href="#/">
                {es.common.backHome}
              </a>
            </div>
          </section>
        )}

        {state.status === 'ready' && (
          <>
            {state.data.nivel === 'interno' && <p className="notice">{es.aprobaciones.internalNotice}</p>}

            <section className="section" aria-labelledby="piezas-title">
              <h2 id="piezas-title">{es.aprobaciones.pieces}</h2>
              {state.data.piezas.length === 0 ? (
                <p className="muted">{es.aprobaciones.noPieces}</p>
              ) : (
                <ul className="approval-list">
                  {state.data.piezas.map((pieza) => (
                    <li key={pieza.id}>
                      <a className="card-link" href={hrefRevision(clienteId, pieza.id)}>
                        <PiezaCard pieza={pieza} />
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="section" aria-labelledby="planes-title">
              <h2 id="planes-title">{es.aprobaciones.plans}</h2>
              <p className="muted">{es.aprobaciones.plansReadOnly}</p>
              {state.data.planes.length === 0 ? (
                <p className="muted">{es.aprobaciones.noPlans}</p>
              ) : (
                <ul className="approval-list">
                  {state.data.planes.map((plan) => (
                    <li key={plan.id}>
                      <PlanCard plan={plan} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </main>
  );
}
