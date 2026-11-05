import {
  getPiezaRevision,
  type EstadoAprobacion,
  type HistorialAprobacion,
} from '../../api/pieza.js';
import { useRemoteData } from '../../hooks/useRemoteData.js';
import { es } from '../../i18n/index.js';
import {
  esEstadoPieza,
  etiquetaDecisionPieza,
  etiquetaEstadoAprobacion,
  etiquetaEstadoPieza,
  etiquetaMotivoPieza,
  etiquetaNivelAprobacion,
} from '../../i18n/estados.js';
import { formatDateTime } from '../../lib/dates.js';
import { formatNumber, textOrPlaceholder } from '../../lib/format.js';
import { Meta } from '../Meta.js';
import { SectionEmpty, SectionError, SectionLoading } from '../SectionStatus.js';

function estadoPieza(value: string | null): string {
  if (value !== null && esEstadoPieza(value)) return etiquetaEstadoPieza(value);
  return textOrPlaceholder(value);
}

function estadoAprobacion(value: EstadoAprobacion): string {
  const label = etiquetaEstadoAprobacion(value.estado);
  if (value.estado === 'cambios_pedidos' && typeof value.ronda === 'number') {
    return `${label} (${es.pieza.revision.round} ${value.ronda})`;
  }
  return label;
}

function HistoryItem({ item }: { item: HistorialAprobacion }) {
  const comment = item.comentario?.trim() ? item.comentario : es.common.notAvailable;

  return (
    <li className="history-item">
      <dl className="meta-grid">
        <Meta label={es.pieza.revision.level} value={etiquetaNivelAprobacion(item.nivel)} />
        <Meta label={es.pieza.revision.decision} value={etiquetaDecisionPieza(item.decision)} />
        <Meta
          label={es.pieza.revision.reason}
          value={item.motivo === null ? es.common.notAvailable : etiquetaMotivoPieza(item.motivo)}
        />
        <Meta
          label={es.pieza.revision.second}
          value={
            item.segundo_ms === null
              ? es.common.notAvailable
              : `${formatNumber(item.segundo_ms)} ms`
          }
        />
        <Meta label={es.pieza.revision.version} value={formatNumber(item.version)} />
        <Meta
          label={es.pieza.revision.createdAt}
          value={item.creado_en ? formatDateTime(item.creado_en) : es.common.notAvailable}
        />
      </dl>
      <div>
        <span className="piece-label">{es.pieza.revision.comment}</span>
        <p className="piece-text">{comment}</p>
      </div>
    </li>
  );
}

function RevisionBody({
  piezaEstado,
  fechaHora,
  estado,
  historial,
}: {
  piezaEstado: string;
  fechaHora: string;
  estado: EstadoAprobacion;
  historial: HistorialAprobacion[];
}) {
  return (
    <>
      <dl className="meta-grid">
        <Meta label={es.pieza.revision.estado} value={estadoPieza(piezaEstado)} />
        <Meta
          label={es.pieza.revision.datetime}
          value={fechaHora ? formatDateTime(fechaHora) : es.common.notAvailable}
        />
        <Meta
          label={es.pieza.revision.approval}
          value={estado ? estadoAprobacion(estado) : es.common.notAvailable}
        />
      </dl>

      <div className="piece-subsection">
        <h3>{es.pieza.revision.history}</h3>
        {historial.length === 0 ? (
          <p className="muted">{es.pieza.revision.noHistory}</p>
        ) : (
          <ul className="history-list">
            {historial.map((item, index) => (
              <HistoryItem key={`${item.creado_en}-${item.version}-${index}`} item={item} />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

export function PieceRevisionSection({
  clienteId,
  piezaId,
}: {
  clienteId: string;
  piezaId: string;
}) {
  const { state, reload } = useRemoteData(
    () => getPiezaRevision(clienteId, piezaId),
    [clienteId, piezaId],
  );

  return (
    <section className="section piece-section" aria-labelledby="piece-revision-title">
      <h2 id="piece-revision-title">{es.pieza.revision.title}</h2>

      {state.status === 'loading' && <SectionLoading />}
      {state.status === 'empty' && <SectionEmpty message={es.pieza.revision.empty} />}
      {state.status === 'error' && (
        <SectionError
          message={state.message}
          retryable={state.retryable}
          onRetry={reload}
        />
      )}
      {state.status === 'ready' && (
        <RevisionBody
          piezaEstado={state.data.pieza_estado}
          fechaHora={state.data.fecha_hora}
          estado={state.data.estado_aprobacion}
          historial={state.data.historial ?? []}
        />
      )}
    </section>
  );
}
