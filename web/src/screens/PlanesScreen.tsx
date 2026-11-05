import { useEffect, useState, type FormEvent } from 'react';
import { listPlanes, type PlanListItem } from '../api/planes.js';
import { ApiError } from '../api/http.js';
import { NovaCielShell } from '../components/NovaCielShell.js';
import { es } from '../i18n/index.js';
import { esEstadoPlan, etiquetaEstadoPlan } from '../i18n/estados.js';
import { formatDateOnly, formatDateTime, isValidLocalDate } from '../lib/dates.js';
import { loadError } from '../lib/loadError.js';
import { hrefPlan, hrefPlanes } from '../router.js';
import { useSession } from '../session/SessionContext.js';

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string; retryable: boolean }
  | { status: 'ready'; data: PlanListItem[] };

function textOrPlaceholder(value: string | null): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : es.common.notAvailable;
}

function Meta({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function PlanRow({ clienteId, plan }: { clienteId: string; plan: PlanListItem }) {
  const estado =
    plan.estado !== null && esEstadoPlan(plan.estado)
      ? etiquetaEstadoPlan(plan.estado)
      : textOrPlaceholder(plan.estado);

  return (
    <li>
      <a className="plan-card" href={hrefPlan(clienteId, plan.id)}>
        <dl className="meta-grid">
          <Meta
            label={es.planes.week}
            value={plan.semana_inicio ? formatDateOnly(plan.semana_inicio) : es.common.notAvailable}
          />
          <Meta label={es.planes.estado} value={estado} />
          <Meta label={es.planes.zone} value={textOrPlaceholder(plan.zona_horaria)} />
          <Meta
            label={es.planes.pieces}
            value={
              plan.piezas === null || plan.piezas === undefined
                ? es.common.notAvailable
                : plan.piezas
            }
          />
          <Meta label={es.planes.createdBy} value={textOrPlaceholder(plan.creado_por)} />
          <Meta
            label={es.planes.createdAt}
            value={plan.creado_en ? formatDateTime(plan.creado_en) : es.common.notAvailable}
          />
        </dl>
      </a>
    </li>
  );
}

export function PlanesScreen({
  clienteId,
  semana,
}: {
  clienteId: string;
  semana: string | null;
}) {
  const { expire } = useSession();
  const [week, setWeek] = useState(semana !== null && isValidLocalDate(semana) ? semana : '');
  const [filterError, setFilterError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    setWeek(semana !== null && isValidLocalDate(semana) ? semana : '');
  }, [semana]);

  useEffect(() => {
    if (semana !== null && !isValidLocalDate(semana)) {
      setFilterError(es.planes.invalidWeek);
      setState({ status: 'idle' });
      return;
    }

    setFilterError(null);
    let cancelled = false;
    setState({ status: 'loading' });

    listPlanes(clienteId, semana).then(
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
  }, [clienteId, semana, reloadToken, expire]);

  function navigate(value: string | null) {
    const next = hrefPlanes(clienteId, value);
    if (window.location.hash === next) setReloadToken((token) => token + 1);
    else window.location.hash = next;
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = week.trim();
    if (value === '') {
      setFilterError(null);
      navigate(null);
      return;
    }
    if (!isValidLocalDate(value)) {
      setFilterError(es.planes.invalidWeek);
      return;
    }
    setFilterError(null);
    navigate(value);
  }

  function onClear() {
    setWeek('');
    setFilterError(null);
    navigate(null);
  }

  return (
    <NovaCielShell title={es.planes.title}>
      <div className="plans">
        <p className="muted">{es.planes.subtitle}</p>

        <form className="filter" onSubmit={onSubmit} noValidate>
          <div className="field">
            <label htmlFor="semana">{es.planes.weekFilter}</label>
            <input
              id="semana"
              name="semana"
              type="date"
              value={week}
              aria-invalid={filterError !== null}
              aria-describedby={filterError !== null ? 'semana-error' : undefined}
              onChange={(event) => {
                setWeek(event.target.value);
                if (filterError !== null) setFilterError(null);
              }}
            />
          </div>
          <div className="page-actions">
            <button className="button" type="submit">
              {es.planes.apply}
            </button>
            <button className="button button--secondary" type="button" onClick={onClear}>
              {es.planes.clear}
            </button>
          </div>
          {filterError !== null && (
            <p id="semana-error" className="error" role="alert">
              {filterError}
            </p>
          )}
        </form>

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
          <section className="section" aria-labelledby="planes-title">
            <h2 id="planes-title">{es.planes.listTitle}</h2>
            {state.data.length === 0 ? (
              <p className="muted">{es.planes.empty}</p>
            ) : (
              <ul className="plan-list">
                {state.data.map((plan) => (
                  <PlanRow key={plan.id} clienteId={clienteId} plan={plan} />
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </NovaCielShell>
  );
}
