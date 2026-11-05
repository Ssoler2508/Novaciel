import { NovaCielShell } from '../components/NovaCielShell.js';
import { PieceBriefSection } from '../components/pieza/PieceBriefSection.js';
import { PieceProductionSection } from '../components/pieza/PieceProductionSection.js';
import { PieceQcSection } from '../components/pieza/PieceQcSection.js';
import { PieceRevisionSection } from '../components/pieza/PieceRevisionSection.js';
import { es } from '../i18n/index.js';
import { hrefPlanes } from '../router.js';

export function PiezaScreen({
  clienteId,
  piezaId,
}: {
  clienteId: string;
  piezaId: string;
}) {
  return (
    <NovaCielShell title={es.pieza.title}>
      <div className="piece">
        <div className="page-actions">
          <a className="button button--secondary" href={hrefPlanes(clienteId)}>
            {es.pieza.backToPlans}
          </a>
        </div>
        <p className="muted">{es.pieza.subtitle}</p>

        <div className="piece-sections">
          <PieceRevisionSection clienteId={clienteId} piezaId={piezaId} />
          <PieceProductionSection clienteId={clienteId} piezaId={piezaId} />
          <PieceBriefSection clienteId={clienteId} piezaId={piezaId} />
          <PieceQcSection clienteId={clienteId} piezaId={piezaId} />
        </div>
      </div>
    </NovaCielShell>
  );
}
