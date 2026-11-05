import type { PiezaView, PlanView } from '../api/planes.js';
import { es } from '../i18n/index.js';
import {
  esEstadoPieza,
  esEstadoPlan,
  etiquetaEstadoPieza,
  etiquetaEstadoPlan,
} from '../i18n/estados.js';
import { formatDateOnly, formatDateTime } from '../lib/dates.js';
import { hrefPieza } from '../router.js';

function textOrPlaceholder(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : es.common.notAvailable;
}

function planEstado(value: string | null): string {
  if (value !== null && esEstadoPlan(value)) return etiquetaEstadoPlan(value);
  return textOrPlaceholder(value);
}

function piezaEstado(value: string | null): string {
  if (value !== null && esEstadoPieza(value)) return etiquetaEstadoPieza(value);
  return textOrPlaceholder(value);
}

// A piece's instant is stored as UTC, but people read it in the plan's zone; the API already sends
// that local wall clock. Fall back to the UTC instant only when the local pair is not usable.
function piezaDateTime(pieza: PiezaView): string {
  const fecha = pieza.fecha_hora_local?.fecha?.trim();
  const hora = pieza.fecha_hora_local?.hora?.trim();
  if (fecha && hora) return `${formatDateOnly(fecha)} · ${hora}`;
  if (pieza.fecha_hora_utc) return formatDateTime(pieza.fecha_hora_utc);
  return es.common.notAvailable;
}

function Meta({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function PiezaRow({ clienteId, pieza }: { clienteId: string; pieza: PiezaView }) {
  const pilar = pieza.pilar?.trim() ?? '';

  return (
    <li>
      <a className="plan-card" href={hrefPieza(clienteId, pieza.id)}>
        <dl className="meta-grid">
          <Meta label={es.planes.network} value={textOrPlaceholder(pieza.red)} />
          <Meta label={es.planes.format} value={textOrPlaceholder(pieza.formato)} />
          {pilar !== '' && <Meta label={es.planes.pillar} value={pilar} />}
          <Meta label={es.planes.datetime} value={piezaDateTime(pieza)} />
          <Meta label={es.planes.estado} value={piezaEstado(pieza.estado)} />
        </dl>
      </a>
    </li>
  );
}

export function PlanReadOnly({
  clienteId,
  plan,
  piezas,
}: {
  clienteId: string;
  plan: PlanView;
  piezas: PiezaView[];
}) {
  return (
    <>
      <section className="section" aria-labelledby="plan-meta-title">
        <h2 id="plan-meta-title">{es.planes.planData}</h2>
        <dl className="meta-grid">
          <Meta
            label={es.planes.week}
            value={
              plan.semana_inicio ? formatDateOnly(plan.semana_inicio) : es.common.notAvailable
            }
          />
          <Meta label={es.planes.estado} value={planEstado(plan.estado)} />
          <Meta label={es.planes.zone} value={textOrPlaceholder(plan.zona_horaria)} />
          <Meta label={es.planes.createdBy} value={textOrPlaceholder(plan.creado_por)} />
          <Meta
            label={es.planes.createdAt}
            value={plan.creado_en ? formatDateTime(plan.creado_en) : es.common.notAvailable}
          />
        </dl>
      </section>

      <section className="section" aria-labelledby="plan-pieces-title">
        <h2 id="plan-pieces-title">{es.planes.piecesTitle}</h2>
        {piezas.length === 0 ? (
          <p className="muted">{es.planes.emptyPieces}</p>
        ) : (
          <ul className="plan-list">
            {piezas.map((pieza) => (
              <PiezaRow key={pieza.id} clienteId={clienteId} pieza={pieza} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
