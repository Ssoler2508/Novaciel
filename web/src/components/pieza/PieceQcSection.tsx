import {
  getPiezaControlCalidad,
  type PiezaControlCalidad,
  type QcCheck,
  type QcInforme,
} from '../../api/pieza.js';
import { useRemoteData } from '../../hooks/useRemoteData.js';
import { es } from '../../i18n/index.js';
import {
  etiquetaCheckQc,
  etiquetaResultadoQc,
  etiquetaSeveridadQc,
} from '../../i18n/estados.js';
import { etiquetaCodigoQc } from '../../i18n/qc.js';
import { formatDateTime } from '../../lib/dates.js';
import { formatNumber, textOrPlaceholder } from '../../lib/format.js';
import { Meta } from '../Meta.js';
import { SectionEmpty, SectionError, SectionLoading } from '../SectionStatus.js';

function CheckCard({ check }: { check: QcCheck }) {
  return (
    <li className="check-card">
      <h3>{etiquetaCodigoQc(check.codigo)}</h3>
      <dl className="meta-grid">
        <Meta label={es.pieza.qc.result} value={etiquetaCheckQc(check.resultado)} />
        <Meta label={es.pieza.qc.severity} value={etiquetaSeveridadQc(check.severidad)} />
        <Meta label={es.pieza.qc.reason} value={textOrPlaceholder(check.motivo)} />
      </dl>
    </li>
  );
}

function Codes({ title, codes }: { title: string; codes: string[] }) {
  return (
    <div className="piece-subsection">
      <h3>{title}</h3>
      {codes.length === 0 ? (
        <p className="muted">{es.common.notAvailable}</p>
      ) : (
        <ul className="code-list">
          {codes.map((codigo, index) => (
            <li key={`${codigo}-${index}`}>{etiquetaCodigoQc(codigo)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Report({ informe }: { informe: QcInforme | null }) {
  if (informe === null) return <p className="muted">{es.pieza.qc.noReport}</p>;
  if (informe.checks.length === 0) return <p className="muted">{es.pieza.qc.noChecks}</p>;

  return (
    <ul className="check-list">
      {informe.checks.map((check, index) => (
        <CheckCard key={`${check.codigo}-${index}`} check={check} />
      ))}
    </ul>
  );
}

function QcBody({ data }: { data: PiezaControlCalidad }) {
  const informe = data.informe;

  return (
    <>
      <dl className="meta-grid">
        <Meta
          label={es.pieza.qc.result}
          value={informe === null ? es.common.notAvailable : etiquetaResultadoQc(informe.resultado)}
        />
        <Meta label={es.pieza.qc.current} value={data.vigente ? es.pieza.qc.yes : es.pieza.qc.no} />
        <Meta
          label={es.pieza.qc.version}
          value={informe === null ? es.common.notAvailable : formatNumber(informe.version)}
        />
        <Meta
          label={es.pieza.qc.createdAt}
          value={
            informe?.creado_en ? formatDateTime(informe.creado_en) : es.common.notAvailable
          }
        />
      </dl>

      <div className="piece-subsection">
        <h3>{es.pieza.qc.report}</h3>
        <Report informe={informe} />
      </div>

      <Codes title={es.pieza.qc.failureCodes} codes={informe?.codigos_fallo ?? []} />
      <Codes title={es.pieza.qc.warningCodes} codes={informe?.codigos_advertencia ?? []} />
    </>
  );
}

export function PieceQcSection({
  clienteId,
  piezaId,
}: {
  clienteId: string;
  piezaId: string;
}) {
  const { state, reload } = useRemoteData(
    () => getPiezaControlCalidad(clienteId, piezaId),
    [clienteId, piezaId],
  );

  return (
    <section className="section piece-section" aria-labelledby="piece-qc-title">
      <h2 id="piece-qc-title">{es.pieza.qc.title}</h2>

      {state.status === 'loading' && <SectionLoading />}
      {state.status === 'empty' && <SectionEmpty message={es.pieza.qc.empty} />}
      {state.status === 'error' && (
        <SectionError
          message={state.message}
          retryable={state.retryable}
          onRetry={reload}
        />
      )}
      {state.status === 'ready' && <QcBody data={state.data} />}
    </section>
  );
}
