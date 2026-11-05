import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../../db/types.js';
import type { App } from '../auth/appType.js';
import { requirePermission } from '../auth/authorize.js';
import { asClienteId } from '../shared/clienteId.js';
import { AlertaNotFoundError, reconocerAlerta } from './alertasService.js';
import {
  CursorInvalidoError,
  MAX_LIMIT,
  DEFAULT_LIMIT,
  pageAlertas,
  SEVERIDADES,
  type AlertaScope,
  type AlertaView,
} from './alertasRepository.js';
import { isCodigoAlerta } from './catalogo.js';

// Persistent alert routes (Step 11, checkpoint C). Alerts hold ids, codes and numbers only.
//
//   GET  /alertas?cliente=&global=&codigo=&severidad=&reconocida=&limite=&antes=       view_alerts_global
//        every alert (global ones included); `cliente` narrows to one client, `global=true` to the global ones
//   GET  /clientes/:clienteId/alertas?codigo=&severidad=&reconocida=&limite=&antes=    view_alerts
//        NovaCiel roles see all of that client's alerts; a client owner sees only aprobacion_vencida
//   POST /clientes/:clienteId/alertas/:alertaId/reconocer                              ack_alerts
//   POST /alertas/:alertaId/reconocer                                                  ack_alerts_global (global alerts only)
//
// Lists are newest first (creado_en DESC, id DESC) with an opaque keyset cursor: `siguiente` of a page goes in
// `antes` of the next one. `limite` is 1 to 100 (default 50). Acknowledging is audited and idempotent. The CSRF
// guard requires Content-Type: application/json on every POST, also when the body is empty.

export interface AlertasRoutesOptions {
  db: Db;
}

type ClientParams = { clienteId: string };
type ClientAlertParams = { clienteId: string; alertaId: string };
type AlertParams = { alertaId: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOVACIEL_ROLES = ['administrador_novaciel', 'operador_novaciel'];

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const filtros = {
  codigo: z.string().refine(isCodigoAlerta, 'unknown alert code').optional(),
  severidad: z.enum(SEVERIDADES).optional(),
  reconocida: bool.optional(),
  limite: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  antes: z.string().min(1).max(200).optional(),
};
const queryGlobal = z.object({ ...filtros, cliente: z.uuid().optional(), global: bool.optional() }).strict();
const queryCliente = z.object(filtros).strict();
const vacio = z.object({}).strict().optional();

const bad = (reply: FastifyReply) => reply.code(400).send({ error: 'invalid_request' });
const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });

/** The alert as the panel sees it. A client role never learns which NovaCiel user acknowledged it. */
function view(a: AlertaView, paraCliente: boolean) {
  return {
    id: a.id,
    cliente_id: a.clienteId,
    codigo: a.codigo,
    severidad: a.severidad,
    parametros: a.parametros,
    creado_en: a.creadoEn.toISOString(),
    reconocida: a.reconocida,
    reconocida_por: paraCliente ? null : a.reconocidaPor,
    reconocida_en: a.reconocidaEn ? a.reconocidaEn.toISOString() : null,
  };
}

const esNovaciel = (req: FastifyRequest) => req.auth!.roles.some((r) => NOVACIEL_ROLES.includes(r.rol));

export async function registerAlertasRoutes(app: App, options: AlertasRoutesOptions): Promise<void> {
  const { db } = options;
  const verGlobal = requirePermission(db, 'view_alerts_global');
  const verCliente = requirePermission(db, 'view_alerts', (req) => (req.params as ClientParams).clienteId);
  const reconocerCliente = requirePermission(db, 'ack_alerts', (req) => (req.params as ClientParams).clienteId);
  const reconocerGlobal = requirePermission(db, 'ack_alerts_global');

  await app.register(async (scope) => {
    scope.addHook('onSend', async (_req, reply) => {
      reply.header('Cache-Control', 'no-store');
    });

    // Only the error name is logged: messages could carry request content.
    scope.setErrorHandler((error, req, reply) => {
      const status = (error as { statusCode?: number }).statusCode;
      if (typeof status === 'number' && status >= 400 && status < 500) return reply.code(status).send({ error: 'invalid_request' });
      if (error instanceof CursorInvalidoError) return reply.code(400).send({ error: 'invalid_request' });
      if (error instanceof AlertaNotFoundError) return reply.code(404).send({ error: 'not_found' });
      req.log.error({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'alerts route failed');
      return reply.code(500).send({ error: 'internal_error' });
    });

    scope.get('/alertas', { preHandler: verGlobal }, async (req, reply) => {
      const q = queryGlobal.safeParse(req.query);
      if (!q.success || (q.data.global && q.data.cliente)) return bad(reply);
      const alcance: AlertaScope = q.data.global ? { tipo: 'global' } : { tipo: 'novaciel', ...(q.data.cliente ? { clienteId: asClienteId(q.data.cliente) } : {}) };
      const page = await pageAlertas(db, alcance, {
        limit: q.data.limite,
        ...(q.data.codigo ? { codigo: q.data.codigo } : {}),
        ...(q.data.severidad ? { severidad: q.data.severidad } : {}),
        ...(q.data.reconocida !== undefined ? { reconocida: q.data.reconocida } : {}),
        ...(q.data.antes ? { antes: q.data.antes } : {}),
      });
      return { limite: q.data.limite, siguiente: page.next, items: page.items.map((a) => view(a, false)) };
    });

    scope.get<{ Params: ClientParams }>('/clientes/:clienteId/alertas', { preHandler: verCliente }, async (req, reply) => {
      const q = queryCliente.safeParse(req.query);
      if (!q.success) return bad(reply);
      const clienteId = asClienteId(req.params.clienteId);
      const staff = esNovaciel(req);
      const alcance: AlertaScope = staff ? { tipo: 'novaciel', clienteId } : { tipo: 'cliente', clienteId };
      const page = await pageAlertas(db, alcance, {
        limit: q.data.limite,
        ...(q.data.codigo ? { codigo: q.data.codigo } : {}),
        ...(q.data.severidad ? { severidad: q.data.severidad } : {}),
        ...(q.data.reconocida !== undefined ? { reconocida: q.data.reconocida } : {}),
        ...(q.data.antes ? { antes: q.data.antes } : {}),
      });
      return { limite: q.data.limite, siguiente: page.next, items: page.items.map((a) => view(a, !staff)) };
    });

    scope.post<{ Params: ClientAlertParams }>('/clientes/:clienteId/alertas/:alertaId/reconocer', { preHandler: reconocerCliente }, async (req, reply) => {
      if (!vacio.safeParse(req.body && Object.keys(req.body as object).length > 0 ? req.body : undefined).success) return bad(reply);
      if (!UUID_RE.test(req.params.alertaId)) return notFound(reply);
      const clienteId = asClienteId(req.params.clienteId);
      const r = await reconocerAlerta(db, { tipo: 'novaciel', clienteId }, req.params.alertaId, req.auth!.user.id);
      return { ...view(r.alerta, false), ya_reconocida: !r.nueva };
    });

    scope.post<{ Params: AlertParams }>('/alertas/:alertaId/reconocer', { preHandler: reconocerGlobal }, async (req, reply) => {
      if (!vacio.safeParse(req.body && Object.keys(req.body as object).length > 0 ? req.body : undefined).success) return bad(reply);
      if (!UUID_RE.test(req.params.alertaId)) return notFound(reply);
      // Only alerts that belong to no client: a client's alert is acknowledged through its client route.
      const r = await reconocerAlerta(db, { tipo: 'global' }, req.params.alertaId, req.auth!.user.id);
      return { ...view(r.alerta, false), ya_reconocida: !r.nueva };
    });
  });
}
