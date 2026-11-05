import type { Logger } from 'pino';
import type { Db } from '../../db/types.js';
import { logger as defaultLogger } from '../../lib/logger/index.js';
import type { Notifier, Plantilla } from '../../lib/notificaciones/types.js';
import { asClienteId, type ClienteId } from '../shared/clienteId.js';
import { CATALOGO, type CodigoAlerta } from './catalogo.js';
import { listAprobadoresValidos, listDuenosCliente, listPersonalNovaciel } from './destinatarios.js';

// The writer of the persistent alerts (Step 11). It validates the parameters against the code's zod schema,
// inserts with ON CONFLICT (clave_dedupe) DO NOTHING and calls the Notifier ONLY when the row was really
// inserted (so a repeated trigger never notifies twice). A Notifier failure keeps the alert and logs only
// the error name. Alerts are never cleared by the system: only an acknowledgement closes them.
//
// Call it AFTER the transaction of the event has committed: a notice must never announce something that
// was rolled back.

export interface AlertasDeps {
  db: Db;
  notifier: Notifier;
  logger?: Logger;
}

/** What the services receive: the writer's dependencies plus the budget thresholds from the config. */
export interface AlertasRuntime extends AlertasDeps {
  /** Budget thresholds in percent (subset of 50, 80, 100; config ALERT_BUDGET_THRESHOLDS). */
  umbrales: readonly number[];
}

export interface RaiseAlertInput {
  /** Required for client alerts, null for global ones. */
  clienteId: ClienteId | string | null;
  parametros: Record<string, unknown>;
}

export interface RaiseAlertResult {
  /** False when an alert with the same dedupe key already existed (nothing is notified then). */
  creada: boolean;
  alertaId: string | null;
}

const errorName = (error: unknown) => (error instanceof Error ? error.name : 'UnknownError');

export async function raiseAlert(deps: AlertasDeps, codigo: CodigoAlerta, input: RaiseAlertInput): Promise<RaiseAlertResult> {
  const log = deps.logger ?? defaultLogger;
  const def = CATALOGO[codigo];
  const clienteId = input.clienteId === null ? null : asClienteId(input.clienteId);
  if (def.ambito === 'cliente' && clienteId === null) throw new Error(`Alert ${codigo} needs a client`);
  if (def.ambito === 'global' && clienteId !== null) throw new Error(`Alert ${codigo} is global and takes no client`);
  const parametros = def.parametros.parse(input.parametros);
  const clave = def.clave(clienteId, parametros);

  const { rows } = await deps.db.query<{ id: string }>(
    `INSERT INTO alertas (cliente_id, codigo, severidad, parametros, clave_dedupe)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (clave_dedupe) DO NOTHING
     RETURNING id`,
    [clienteId, codigo, def.severidad, JSON.stringify(parametros), clave],
  );
  const alertaId = rows[0]?.id ?? null;
  if (alertaId === null) return { creada: false, alertaId: null };
  log.info({ alertaId, codigo, clienteId, severidad: def.severidad }, 'alert raised');

  try {
    const destinos: { usuarioId: string; plantilla: Plantilla }[] = [];
    if (def.notifica.novaciel) {
      for (const usuarioId of await listPersonalNovaciel(deps.db)) destinos.push({ usuarioId, plantilla: 'alerta_novaciel' });
    }
    const extra = def.notifica.cliente;
    if (extra && clienteId !== null) {
      const ids = extra.quienes === 'duenos' ? await listDuenosCliente(deps.db, clienteId) : await listAprobadoresValidos(deps.db, clienteId);
      for (const usuarioId of ids) destinos.push({ usuarioId, plantilla: extra.plantilla });
    }
    for (const destino of destinos) {
      try {
        await deps.notifier.enviar({
          clienteId,
          destinatarioUsuarioId: destino.usuarioId,
          plantilla: destino.plantilla,
          referencia: { tipo: 'alerta', id: alertaId },
        });
      } catch (error) {
        log.warn({ alertaId, codigo, destinatarioUsuarioId: destino.usuarioId, errorName: errorName(error) }, 'alert notice failed; the alert is kept');
      }
    }
  } catch (error) {
    log.warn({ alertaId, codigo, errorName: errorName(error) }, 'alert recipients could not be resolved; the alert is kept');
  }
  return { creada: true, alertaId };
}

/**
 * For the hooks inside other flows: a problem raising an alert must never break the work that triggered it.
 * Without `deps` (tests and scripts that do not wire alerts) it does nothing. Logs only the error name.
 */
export async function raiseAlertBestEffort(deps: AlertasDeps | undefined, codigo: CodigoAlerta, input: RaiseAlertInput): Promise<void> {
  if (!deps) return;
  try {
    await raiseAlert(deps, codigo, input);
  } catch (error) {
    (deps.logger ?? defaultLogger).error({ codigo, errorName: errorName(error) }, 'alert could not be raised');
  }
}
