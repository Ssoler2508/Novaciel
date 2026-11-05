import type { PiezaProduccion, ProduccionArchivo } from '../../api/pieza.js';
import { usePiezaProduction } from '../../hooks/usePiezaProduction.js';
import { es } from '../../i18n/index.js';
import {
  formatBytes,
  formatDecimal,
  formatMsRange,
  formatNumber,
  formatSecondsFromMs,
  textOrPlaceholder,
} from '../../lib/format.js';
import { Meta } from '../Meta.js';
import { SectionEmpty, SectionError, SectionLoading } from '../SectionStatus.js';

function Media({
  archivo,
  onError,
}: {
  archivo: ProduccionArchivo;
  onError: (url: string) => void;
}) {
  if (!archivo.url.trim()) return <p className="muted">{es.common.notAvailable}</p>;
  const isVideo = archivo.mime.startsWith('video/') || archivo.video !== null;

  if (isVideo) {
    return (
      <video
        className="piece-media"
        src={archivo.url}
        controls
        preload="metadata"
        aria-label={es.pieza.production.videoLabel}
        onError={() => onError(archivo.url)}
      />
    );
  }

  return (
    <img
      className="piece-media"
      src={archivo.url}
      alt={es.pieza.production.imageAlt}
      onError={() => onError(archivo.url)}
    />
  );
}

function FileCard({
  archivo,
  unavailable,
  onFileError,
}: {
  archivo: ProduccionArchivo;
  unavailable: ReadonlySet<string>;
  onFileError: (url: string) => void;
}) {
  const { video } = archivo;

  return (
    <li className="file-card">
      {unavailable.has(archivo.url) ? (
        <p className="error" role="alert">
          {es.pieza.production.fileUnavailable}
        </p>
      ) : (
        <Media archivo={archivo} onError={onFileError} />
      )}

      <dl className="meta-grid">
        <Meta label={es.pieza.production.order} value={formatNumber(archivo.orden)} />
        <Meta label={es.pieza.production.mime} value={textOrPlaceholder(archivo.mime)} />
        <Meta
          label={es.pieza.production.width}
          value={`${formatNumber(archivo.ancho)} px`}
        />
        <Meta
          label={es.pieza.production.height}
          value={`${formatNumber(archivo.alto)} px`}
        />
        <Meta label={es.pieza.production.size} value={formatBytes(archivo.tamano_bytes)} />
        {video !== null && (
          <>
            <Meta
              label={es.pieza.production.duration}
              value={formatSecondsFromMs(video.duracion_ms)}
            />
            <Meta label={es.pieza.production.fps} value={formatDecimal(video.fps)} />
            <Meta
              label={es.pieza.production.videoCodec}
              value={textOrPlaceholder(video.codec_video)}
            />
            <Meta
              label={es.pieza.production.audioCodec}
              value={textOrPlaceholder(video.codec_audio)}
            />
          </>
        )}
      </dl>

      {video !== null && video.fuentes.length > 0 && (
        <div className="piece-subsection">
          <h3>{es.pieza.production.sources}</h3>
          <ul className="source-list">
            {video.fuentes.map((fuente, index) => (
              <li key={`${fuente.escena}-${index}`}>
                {es.pieza.production.scene} {formatNumber(fuente.escena)} ·{' '}
                {formatMsRange(fuente.entrada_ms, fuente.salida_ms)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

function ProductionBody({
  data,
  unavailable,
  onFileError,
}: {
  data: PiezaProduccion;
  unavailable: ReadonlySet<string>;
  onFileError: (url: string) => void;
}) {
  const archivos = [...data.archivos].sort((a, b) => a.orden - b.orden);

  return (
    <>
      {data.plantilla !== null && (
        <dl className="meta-grid">
          <Meta
            label={es.pieza.production.template}
            value={`${data.plantilla.id} · ${formatNumber(data.plantilla.version)}`}
          />
        </dl>
      )}

      {archivos.length === 0 ? (
        <p className="muted">{es.pieza.production.noFiles}</p>
      ) : (
        <ul className="file-list">
          {archivos.map((archivo) => (
            <FileCard
              key={archivo.orden}
              archivo={archivo}
              unavailable={unavailable}
              onFileError={onFileError}
            />
          ))}
        </ul>
      )}
    </>
  );
}

export function PieceProductionSection({
  clienteId,
  piezaId,
}: {
  clienteId: string;
  piezaId: string;
}) {
  const { state, unavailable, onFileError, reload } = usePiezaProduction(clienteId, piezaId);

  return (
    <section className="section piece-section" aria-labelledby="piece-production-title">
      <h2 id="piece-production-title">{es.pieza.production.title}</h2>

      {state.status === 'loading' && <SectionLoading />}
      {state.status === 'empty' && <SectionEmpty message={es.pieza.production.empty} />}
      {state.status === 'error' && (
        <SectionError
          message={state.message}
          retryable={state.retryable}
          onRetry={reload}
        />
      )}
      {state.status === 'ready' && (
        <ProductionBody
          data={state.data}
          unavailable={unavailable}
          onFileError={onFileError}
        />
      )}
    </section>
  );
}
