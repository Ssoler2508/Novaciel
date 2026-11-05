import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getRevision,
  postDecision,
  type ArchivoRevision,
  type DecisionInput,
  type EntradaHistorial,
  type EstadoAprobacion,
  type MotivoPieza,
  type Revision,
} from '../api/aprobaciones.js';
import { ApiError } from '../api/http.js';
import { es } from '../i18n/index.js';
import { esEstadoPieza, etiquetaEstadoPieza } from '../i18n/estados.js';
import { formatDateTime } from '../lib/dates.js';
import { hrefAprobaciones } from '../router.js';
import { nivelAprobacion } from '../session/roles.js';
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

const MOTIVOS: readonly MotivoPieza[] = [
  'texto',
  'musica',
  'toma',
  'gancho',
  'dato_equivocado',
  'otro',
];

type PendingDecision =
  | { decision: 'aprobada'; comentario?: string }
  | {
      decision: 'cambios';
      motivo: MotivoPieza;
      segundoMs?: number;
      comentario?: string;
    };

const CONFLICT_MESSAGES: Record<string, string> = {
  estado_invalido: es.decision.errors.estado_invalido,
  plan_no_aprobado: es.decision.errors.plan_no_aprobado,
  plan_descartado: es.decision.errors.plan_descartado,
  sin_produccion: es.decision.errors.sin_produccion,
  transicion_invalida: es.decision.errors.transicion_invalida,
};

function fieldErrorMessages(fields: readonly string[]): string[] {
  const messages = fields.map((field) => {
    switch (field) {
      case 'motivo':
        return es.decision.fieldMotivo;
      case 'segundo_ms':
      case 'segundoMs':
        return es.decision.fieldSegundo;
      case 'hash_visto':
        return es.decision.fieldHash;
      case 'decision':
        return es.decision.fieldDecision;
      case 'nivel':
        return es.decision.fieldNivel;
      case 'comentario':
        return es.decision.fieldComentario;
      default:
        return es.decision.fieldGeneric;
    }
  });
  return [...new Set(messages)];
}

function conflictMessage(code: string | null): string {
  if (code === null || !Object.prototype.hasOwnProperty.call(CONFLICT_MESSAGES, code)) {
    return es.decision.errors.other;
  }
  return CONFLICT_MESSAGES[code]!;
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
  const { state: session, expire } = useSession();
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [refreshToken, setRefreshToken] = useState(0);
  const [unavailable, setUnavailable] = useState<ReadonlySet<number>>(() => new Set());
  const refreshUsed = useRef(false);
  const refreshPending = useRef(false);
  const [motivo, setMotivo] = useState<MotivoPieza | ''>('');
  const [segundo, setSegundo] = useState('');
  const [comentario, setComentario] = useState('');
  const [pendingDecision, setPendingDecision] = useState<PendingDecision | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<string[]>([]);

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

  const canDecide =
    session.status === 'authenticated' && nivelAprobacion(session.user.roles, clienteId) === 'cliente';
  const showDecision =
    canDecide &&
    state.status === 'ready' &&
    state.revision.pieza_estado === 'esperando_aprobacion' &&
    success === null;

  function onApprove() {
    if (submitting || state.status !== 'ready') return;
    setDecisionError(null);
    setFieldErrors([]);
    const cleaned = comentario.trim() === '' ? undefined : comentario;
    setPendingDecision({
      decision: 'aprobada',
      ...(cleaned !== undefined ? { comentario: cleaned } : {}),
    });
  }

  function onRequestChanges() {
    if (submitting || state.status !== 'ready') return;
    setDecisionError(null);
    setFieldErrors([]);
    if (motivo === '') {
      setFieldErrors([es.decision.motivoRequired]);
      return;
    }
    const trimmedSecond = segundo.trim();
    let segundoMs: number | undefined;
    if (trimmedSecond !== '') {
      const value = Number(trimmedSecond);
      if (!Number.isInteger(value) || value < 0) {
        setFieldErrors([es.decision.segundoInvalid]);
        return;
      }
      segundoMs = value;
    }
    const cleaned = comentario.trim() === '' ? undefined : comentario;
    setPendingDecision({
      decision: 'cambios',
      motivo,
      ...(segundoMs !== undefined ? { segundoMs } : {}),
      ...(cleaned !== undefined ? { comentario: cleaned } : {}),
    });
  }

  async function onConfirm() {
    if (submittingRef.current || pendingDecision === null || state.status !== 'ready') return;
    submittingRef.current = true;
    const revision = state.revision;
    const pending = pendingDecision;
    const body: DecisionInput =
      pending.decision === 'aprobada'
        ? {
            nivel: 'cliente',
            decision: 'aprobada',
            hash_visto: revision.hash_pieza,
            ...(pending.comentario !== undefined ? { comentario: pending.comentario } : {}),
          }
        : {
            nivel: 'cliente',
            decision: 'cambios',
            hash_visto: revision.hash_pieza,
            motivo: pending.motivo,
            ...(pending.segundoMs !== undefined ? { segundo_ms: pending.segundoMs } : {}),
            ...(pending.comentario !== undefined ? { comentario: pending.comentario } : {}),
          };

    setSubmitting(true);
    setDecisionError(null);
    setFieldErrors([]);
    try {
      const result = await postDecision(clienteId, piezaId, body);
      setPendingDecision(null);
      setSuccess(
        pending.decision === 'aprobada'
          ? es.decision.successApproved(revision.version)
          : es.decision.successChanges(revision.version),
      );
      setMotivo('');
      setSegundo('');
      setComentario('');
      // Show the state the backend confirmed right away; the refetch brings the full revision.
      setState((current): LoadState =>
        current.status === 'ready'
          ? {
              status: 'ready',
              revision: {
                ...current.revision,
                pieza_estado: result.pieza_estado,
                estado_aprobacion: result.estado_aprobacion,
              },
            }
          : current,
      );
      void load(true);
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 401) {
          expire();
          return;
        }
        setPendingDecision(null);
        if (error.status === 400) {
          setFieldErrors(
            error.fields.length > 0
              ? fieldErrorMessages(error.fields)
              : [es.decision.invalidRequest],
          );
        } else if (error.status === 403) {
          setDecisionError(es.decision.forbidden);
        } else if (error.status === 404) {
          setDecisionError(es.decision.notFound);
        } else if (error.status === 409) {
          setDecisionError(
            error.code === 'hash_desactualizado'
              ? es.decision.errors.hash
              : conflictMessage(error.code),
          );
          setMotivo('');
          setSegundo('');
          setComentario('');
          void load(true);
        } else {
          setDecisionError(es.decision.generic);
        }
      } else {
        setPendingDecision(null);
        setDecisionError(es.decision.network);
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

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

        {success !== null && (
          <p className="notice" role="status">
            {success}
          </p>
        )}

        {decisionError !== null && (
          <p className="error" role="alert">
            {decisionError}
          </p>
        )}

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

            {showDecision && (
              <section className="section decision" aria-labelledby="decision-title">
                <h2 id="decision-title">{es.decision.title}</h2>

                {pendingDecision === null ? (
                  <>
                    <p className="muted">{es.decision.intro}</p>

                    {fieldErrors.length > 0 && (
                      <ul className="field-errors" role="alert">
                        {fieldErrors.map((message) => (
                          <li key={message}>{message}</li>
                        ))}
                      </ul>
                    )}

                    <div className="field">
                      <label htmlFor="decision-comment">{es.decision.comentario}</label>
                      <textarea
                        id="decision-comment"
                        name="comentario"
                        rows={3}
                        value={comentario}
                        disabled={submitting}
                        onChange={(event) => setComentario(event.target.value)}
                      />
                    </div>

                    <div className="page-actions">
                      <button
                        className="button"
                        type="button"
                        onClick={onApprove}
                        disabled={submitting}
                      >
                        {es.decision.approve}
                      </button>
                    </div>

                    <fieldset className="changes-fieldset" disabled={submitting}>
                      <legend>{es.decision.changesTitle}</legend>

                      <div className="field">
                        <label htmlFor="decision-motivo">{es.decision.motivo}</label>
                        <select
                          id="decision-motivo"
                          name="motivo"
                          value={motivo}
                          disabled={submitting}
                          onChange={(event) => setMotivo(event.target.value as MotivoPieza | '')}
                        >
                          <option value="">{es.decision.motivoPlaceholder}</option>
                          {MOTIVOS.map((value) => (
                            <option key={value} value={value}>
                              {es.aprobacion.motivos[value]}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="field">
                        <label htmlFor="decision-segundo">{es.decision.segundo}</label>
                        <input
                          id="decision-segundo"
                          name="segundo"
                          type="number"
                          min="0"
                          step="1"
                          inputMode="numeric"
                          value={segundo}
                          disabled={submitting}
                          onChange={(event) => setSegundo(event.target.value)}
                        />
                      </div>

                      <div className="page-actions">
                        <button
                          className="button"
                          type="button"
                          onClick={onRequestChanges}
                          disabled={submitting}
                        >
                          {es.decision.requestChanges}
                        </button>
                      </div>
                    </fieldset>
                  </>
                ) : (
                  <div className="confirmation">
                    <h3>{es.decision.confirmTitle}</h3>
                    <p>
                      {pendingDecision.decision === 'aprobada'
                        ? es.decision.confirmApprove(state.revision.version)
                        : es.decision.confirmChanges(state.revision.version)}
                    </p>

                    {pendingDecision.decision === 'cambios' && (
                      <dl className="meta-grid">
                        <Meta
                          label={es.decision.motivo}
                          value={es.aprobacion.motivos[pendingDecision.motivo]}
                        />
                        {pendingDecision.segundoMs !== undefined && (
                          <Meta label={es.decision.segundo} value={pendingDecision.segundoMs} />
                        )}
                      </dl>
                    )}

                    {pendingDecision.comentario !== undefined && (
                      <div className="confirmation-comment">
                        <p className="muted">{es.decision.comentario}</p>
                        <p className="pre-wrap">{pendingDecision.comentario}</p>
                      </div>
                    )}

                    <div className="page-actions">
                      <button
                        className="button"
                        type="button"
                        onClick={() => void onConfirm()}
                        disabled={submitting}
                      >
                        {submitting
                          ? es.decision.sending
                          : pendingDecision.decision === 'aprobada'
                            ? es.decision.confirmApproveAction
                            : es.decision.confirmChangesAction}
                      </button>
                      <button
                        className="button button--secondary"
                        type="button"
                        onClick={() => setPendingDecision(null)}
                        disabled={submitting}
                      >
                        {es.decision.cancel}
                      </button>
                    </div>
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}
