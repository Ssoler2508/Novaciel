import {
  getPiezaBrief,
  type BriefEscena,
  type BriefToma,
  type PiezaBrief,
} from '../../api/pieza.js';
import { useRemoteData } from '../../hooks/useRemoteData.js';
import { es } from '../../i18n/index.js';
import { formatDecimal, formatMsRange, formatNumber, textOrPlaceholder } from '../../lib/format.js';
import { Meta } from '../Meta.js';
import { SectionEmpty, SectionError, SectionLoading } from '../SectionStatus.js';

const FORMATOS: Readonly<Record<string, string>> = es.pieza.brief.formats;

function formatoLabel(value: string): string {
  return FORMATOS[value] ?? textOrPlaceholder(value);
}

function sourceLabel(value: string): string {
  if (value === 'media_real') return es.pieza.brief.sourceReal;
  if (value === 'faltante') return es.pieza.brief.sourceMissing;
  return textOrPlaceholder(value);
}

function factsLabel(count: number): string {
  return `${formatNumber(count)} ${count === 1 ? es.pieza.brief.factOne : es.pieza.brief.factMany}`;
}

function SceneCard({ escena }: { escena: BriefEscena }) {
  return (
    <li className="scene-card">
      <h3>
        {es.pieza.brief.scene} {formatNumber(escena.orden)}
      </h3>
      <dl className="meta-grid">
        <Meta
          label={es.pieza.brief.screenText}
          value={textOrPlaceholder(escena.texto_en_pantalla)}
        />
        {escena.texto_alternativo !== undefined && (
          <Meta
            label={es.pieza.brief.altText}
            value={textOrPlaceholder(escena.texto_alternativo)}
          />
        )}
        {escena.voz_en_off !== undefined && (
          <Meta
            label={es.pieza.brief.voiceOver}
            value={textOrPlaceholder(escena.voz_en_off)}
          />
        )}
        {escena.duracion_s !== undefined && (
          <Meta
            label={es.pieza.brief.sceneDuration}
            value={`${formatDecimal(escena.duracion_s)} s`}
          />
        )}
      </dl>
    </li>
  );
}

function ShotCard({ toma }: { toma: BriefToma }) {
  return (
    <li className="shot-card">
      <h3>
        {es.pieza.brief.shot} {formatNumber(toma.orden)}
      </h3>
      <dl className="meta-grid">
        <Meta label={es.pieza.brief.source} value={sourceLabel(toma.fuente)} />
        {toma.motivo_faltante !== null && (
          <Meta
            label={es.pieza.brief.missingReason}
            value={textOrPlaceholder(toma.motivo_faltante)}
          />
        )}
        {(toma.entrada_ms !== null || toma.salida_ms !== null) && (
          <Meta
            label={es.pieza.brief.range}
            value={formatMsRange(toma.entrada_ms, toma.salida_ms)}
          />
        )}
      </dl>
    </li>
  );
}

function BriefBody({ data }: { data: PiezaBrief }) {
  const contenido = data.contenido;

  return (
    <>
      <dl className="meta-grid">
        <Meta label={es.pieza.brief.format} value={formatoLabel(data.formato)} />
      </dl>
      <p className="muted">{factsLabel(data.hecho_count)}</p>

      <div className="piece-subsection">
        <h3>{es.pieza.brief.hook}</h3>
        <p className="piece-text">{textOrPlaceholder(contenido.gancho)}</p>
      </div>

      <div className="piece-subsection">
        <h3>{es.pieza.brief.scenes}</h3>
        {contenido.escenas.length === 0 ? (
          <p className="muted">{es.pieza.brief.noScenes}</p>
        ) : (
          <ul className="scene-list">
            {contenido.escenas.map((escena) => (
              <SceneCard key={escena.orden} escena={escena} />
            ))}
          </ul>
        )}
      </div>

      <div className="piece-subsection">
        <h3>{es.pieza.brief.shots}</h3>
        {data.tomas.length === 0 ? (
          <p className="muted">{es.pieza.brief.noShots}</p>
        ) : (
          <ul className="shot-list">
            {data.tomas.map((toma) => (
              <ShotCard key={toma.orden} toma={toma} />
            ))}
          </ul>
        )}
      </div>

      <div className="piece-subsection">
        <h3>{es.pieza.brief.publication}</h3>
        <dl className="meta-grid">
          <Meta
            label={es.pieza.brief.publicationText}
            value={
              <p className="piece-text">
                {textOrPlaceholder(contenido.texto_publicacion.texto)}
              </p>
            }
          />
          <Meta
            label={es.pieza.brief.hashtags}
            value={
              contenido.texto_publicacion.hashtags.length === 0 ? (
                es.common.notAvailable
              ) : (
                <ul className="hashtag-list">
                  {contenido.texto_publicacion.hashtags.map((hashtag, index) => (
                    <li key={`${hashtag}-${index}`}>{hashtag}</li>
                  ))}
                </ul>
              )
            }
          />
          {contenido.texto_publicacion.ubicacion !== undefined && (
            <Meta
              label={es.pieza.brief.location}
              value={textOrPlaceholder(contenido.texto_publicacion.ubicacion)}
            />
          )}
        </dl>
      </div>

      <div className="piece-subsection">
        <h3>{es.pieza.brief.cta}</h3>
        <p className="piece-text">{textOrPlaceholder(contenido.llamado_a_accion)}</p>
      </div>

      {(contenido.musica !== undefined ||
        contenido.portada !== undefined ||
        contenido.notas_produccion.trim() !== '') && (
        <div className="piece-subsection">
          <h3>{es.pieza.brief.productionNotes}</h3>
          <dl className="meta-grid">
            {contenido.musica !== undefined && (
              <Meta label={es.pieza.brief.music} value={textOrPlaceholder(contenido.musica)} />
            )}
            {contenido.portada !== undefined && (
              <Meta label={es.pieza.brief.cover} value={textOrPlaceholder(contenido.portada)} />
            )}
            {contenido.notas_produccion.trim() !== '' && (
              <Meta
                label={es.pieza.brief.productionNotes}
                value={
                  <p className="piece-text">
                    {textOrPlaceholder(contenido.notas_produccion)}
                  </p>
                }
              />
            )}
          </dl>
        </div>
      )}
    </>
  );
}

export function PieceBriefSection({
  clienteId,
  piezaId,
}: {
  clienteId: string;
  piezaId: string;
}) {
  const { state, reload } = useRemoteData(
    () => getPiezaBrief(clienteId, piezaId),
    [clienteId, piezaId],
  );

  return (
    <section className="section piece-section" aria-labelledby="piece-brief-title">
      <h2 id="piece-brief-title">{es.pieza.brief.title}</h2>

      {state.status === 'loading' && <SectionLoading />}
      {state.status === 'empty' && <SectionEmpty message={es.pieza.brief.empty} />}
      {state.status === 'error' && (
        <SectionError
          message={state.message}
          retryable={state.retryable}
          onRetry={reload}
        />
      )}
      {state.status === 'ready' && <BriefBody data={state.data} />}
    </section>
  );
}
