import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getRevision,
  type ArchivoRevision,
  type EntradaHistorial,
  type EstadoAprobacion,
  type Revision,
} from '../api/aprobaciones.js';
import { ApiError } from '../api/http.js';
import { es } from '../i18n/index.js';
import { esEstadoPieza, etiquetaEstadoPieza } from '../i18n/estados.js';
import { formatDateTime } from '../lib/dates.js';
import { hrefAprobaciones } from '../router.js';
import { useSession } from '../session/SessionContext.js';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string; retryable: boolean }
  | { status: 'ready'; revision: Revision };

interface LoadError {
  message: string;
  retryable: boolean;
}

function loadError(error: unknown): LoadError {
  if (error instanceof ApiError) {
    if (error.status === 400) return { message: es.common.invalidRequest, retryable: false };
    if (error.status === 403) return { message: es.common.forbidden, retryable: false };
    if (error.status === 404) return { message: es.common.notFound, retryable: false };
    return { message: es.common.loadError, retryable: true };
  }
  return { message: es.common.networkError, retryable: true };
}

function estadoPiezaTexto(estado: string): string {
  return esEstadoPieza(estado) ? etiquetaEstadoPieza(estado) : estado;
}

function estadoAprobacionTexto(estado: EstadoAprobacion): string {
  const label = es.aprobacion.estados[estado.estado];
  if (estado.estado === 'cambios_pedidos' && estado.ronda !== undefined) {
    return `${label} · ${es.aprobacion.ronda} ${estado.ronda}`;
  }
  return label;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatFps(fps: number): string {
  return String(Math.round(fps * 100) / 100);
}

function Meta({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function MediaView({
  archivo,
  unavailable,
  onError,
}: {
  archivo: ArchivoRevision;
  unavailable: boolean;
  onError: () => void;
}) {
  const isVideo = archivo.video !== null || archivo.mime.startsWith('video/');

  if (unavailable) {
    return <p className="error">{es.revision.fileUnavailable}</p>;
  }

  return (
    <figure className="media-card">
      {isVideo ? (
        <video
          className="media"
          controls
          playsInline
          preload="metadata"
          src={archivo.url}
          onError={onError}
        />
      ) : (
        <img className="media" src={archivo.url} alt={es.revision.imageAlt} onError={onError} />
      )}
      {isVideo && archivo.video !== null && (
        <figcaption className="muted">
          {es.revision.duration}: {formatDuration(archivo.video.duracion_ms)} · {es.revision.fps}:{' '}
          {formatFps(archivo.video.fps)}
        </figcaption>
      )}
    </figure>
  );
}

function HistoryItem({ entry }: { entry: EntradaHistorial }) {
  return (
    <li className="history-item">
      <div className="history-head">
        <strong>{es.aprobacion.decisiones[entry.decision]}</strong>
        <span className="muted">{formatDateTime(entry.creado_en)}</span>
      </div>
      <p className="muted">
        {es.revision.version} {entry.version}
        {entry.propia ? ` · ${es.revision.ownDecision}` : ''}
      </p>
      {entry.motivo !== null && <p>{es.aprobacion.motivos[entry.motivo]}</p>}
      {entry.nivel === 'cliente' && entry.comentario !== null && (
        <p className="pre-wrap">{entry.comentario}</p>
      )}
    </li>
  );
}

export function RevisionScreen({ clienteId, piezaId }: { clienteId: string; piezaId: string }) {
  const { expire } = useSession();
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [refreshToken, setRefreshToken] = useState(0);
  const [unavailable, setUnavailable] = useState<ReadonlySet<number>>(() => new Set());
  const refreshUsed = useRef(false);
  const refreshPending = useRef(false);

  const load = useCallback(
    async (quiet: boolean): Promise<void> => {
      if (!quiet) setState({ status: 'loading' });
      try {
        const revision = await getRevision(clienteId, piezaId);
        setState({ status: 'ready', revision });
        setRefreshToken((token) => token + 1);
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          expire();
          return;
        }
        setState({ status: 'error', ...loadError(error) });
      }
    },
    [clienteId, piezaId, expire],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  // New signed URLs get a fresh chance: a file marked unavailable is tried again.
  useEffect(() => {
    setUnavailable(new Set());
  }, [refreshToken]);

  const handleFileError = useCallback(
    (orden: number) => {
      if (refreshPending.current) return;
      if (!refreshUsed.current) {
        refreshUsed.current = true;
        refreshPending.current = true;
        void load(true).finally(() => {
          refreshPending.current = false;
        });
        return;
      }
      setUnavailable((current) => {
        if (current.has(orden)) return current;
        const next = new Set(current);
        next.add(orden);
        return next;
      });
    },
    [load],
  );

  // Refresh once per expiry, only while this screen is mounted. Navigating away clears the timer.
  useEffect(() => {
    if (state.status !== 'ready') return;
    const expirations = state.revision.archivos
      .map((archivo) => archivo.url_expira_en_s)
      .filter((seconds) => Number.isFinite(seconds) && seconds > 0);
    if (expirations.length === 0) return;
    const timer = window.setTimeout(
      () => {
        void load(true);
      },
      Math.max(1, Math.min(...expirations)) * 1000,
    );
    return () => window.clearTimeout(timer);
  }, [state, load]);

  const retry = useCallback(() => {
    refreshUsed.current = false;
    refreshPending.current = false;
    setUnavailable(new Set());
    void load(false);
  }, [load]);

  return (
    <main className="screen screen--wide">
      <div className="approvals">
        <header className="page-header">
          <div>
            <p className="brand">{es.app.name}</p>
            <h1>{es.revision.title}</h1>
          </div>
          <a className="button button--secondary" href={hrefAprobaciones(clienteId)}>
            {es.revision.backToApprovals}
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
                <button className="button button--secondary" type="button" onClick={retry}>
                  {es.common.retry}
                </button>
              )}
              <a className="button button--secondary" href={hrefAprobaciones(clienteId)}>
                {es.revision.backToApprovals}
              </a>
            </div>
          </section>
        )}

        {state.status === 'ready' && (
          <>
            <dl className="meta-grid">
              <Meta label={es.revision.red} value={state.revision.red} />
              <Meta label={es.revision.version} value={state.revision.version} />
              <Meta label={es.revision.state} value={estadoPiezaTexto(state.revision.pieza_estado)} />
              <Meta label={es.revision.fechaHora} value={formatDateTime(state.revision.fecha_hora)} />
              <Meta
                label={es.revision.approvalState}
                value={estadoAprobacionTexto(state.revision.estado_aprobacion)}
              />
            </dl>

            <section className="section" aria-labelledby="texto-title">
              <h2 id="texto-title">{es.revision.publicationText}</h2>
              <p className="pre-wrap">{state.revision.texto_publicacion || es.common.empty}</p>
            </section>

            <section className="section" aria-labelledby="hashtags-title">
              <h2 id="hashtags-title">{es.revision.hashtags}</h2>
              {state.revision.hashtags.length === 0 ? (
                <p className="muted">{es.revision.noHashtags}</p>
              ) : (
                <ul className="chips">
                  {state.revision.hashtags.map((hashtag, index) => (
                    <li key={`${hashtag}-${index}`}>{hashtag}</li>
                  ))}
                </ul>
              )}
            </section>

            <section className="section" aria-labelledby="alt-title">
              <h2 id="alt-title">{es.revision.altTexts}</h2>
              {state.revision.textos_alternativos.length === 0 ? (
                <p className="muted">{es.revision.noAltTexts}</p>
              ) : (
                <ul className="plain-list">
                  {state.revision.textos_alternativos.map((texto, index) => (
                    <li key={`${texto}-${index}`}>{texto}</li>
                  ))}
                </ul>
              )}
            </section>

            <section className="section" aria-labelledby="location-title">
              <h2 id="location-title">{es.revision.location}</h2>
              {state.revision.ubicacion === null || state.revision.ubicacion.trim() === '' ? (
                <p className="muted">{es.revision.noLocation}</p>
              ) : (
                <p>{state.revision.ubicacion}</p>
              )}
            </section>

            <section className="section" aria-labelledby="files-title">
              <h2 id="files-title">{es.revision.files}</h2>
              {state.revision.archivos.length === 0 ? (
                <p className="muted">{es.revision.noFiles}</p>
              ) : (
                <ul className="media-list">
                  {state.revision.archivos.map((archivo) => (
                    <li key={archivo.orden}>
                      <MediaView
                        archivo={archivo}
                        unavailable={unavailable.has(archivo.orden)}
                        onError={() => handleFileError(archivo.orden)}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="section" aria-labelledby="history-title">
              <h2 id="history-title">{es.revision.history}</h2>
              {state.revision.historial.length === 0 ? (
                <p className="muted">{es.revision.noHistory}</p>
              ) : (
                <ul className="history-list">
                  {state.revision.historial.map((entry, index) => (
                    <HistoryItem key={`${entry.creado_en}-${index}`} entry={entry} />
                  ))}
                </ul>
              )}
            </section>

            {state.revision.control_calidad !== null && (
              <section className="section" aria-labelledby="qc-title">
                <h2 id="qc-title">{es.controlCalidad.title}</h2>
                <dl className="meta-grid">
                  <Meta
                    label={es.controlCalidad.resultado}
                    value={es.controlCalidad.resultados[state.revision.control_calidad.resultado]}
                  />
                  <Meta
                    label={es.controlCalidad.version}
                    value={state.revision.control_calidad.version}
                  />
                  <Meta
                    label={es.controlCalidad.creado}
                    value={formatDateTime(state.revision.control_calidad.creado_en)}
                  />
                </dl>
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}
