import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../../db/types.js';
import type { App } from '../auth/appType.js';
import { requirePermission } from '../auth/authorize.js';
import { esPersonalNovaciel } from '../aprobaciones/actor.js';
import type { EstadoAprobacion } from '../aprobaciones/estadoAprobacion.js';
import { ESTADOS } from '../piezas/estados.js';
import { isValidLocalDate, mondayOf } from '../planificador/fechas.js';
import { toPiezaView, toPlanView } from '../planificador/planesView.js';
import { microToUsd, usdToMicro } from '../presupuesto/money.js';
import { getSwitches } from '../presupuesto/presupuestoAdmin.js';
import { getSpendSummary } from '../presupuesto/presupuestoService.js';
import { asClienteId } from '../shared/clienteId.js';
import {
  conteosPorEstado,
  cabeceraResumen,
  CursorInvalidoError,
  getPlanDeLaSemana,
  historialGasto,
  listPiezasDelPlan,
  pageClientes,
  pagePiezas,
  PIEZAS_DEFAULT_LIMIT,
  PIEZAS_MAX_LIMIT,
  resumenesDeClientes,
  resumenesDePiezas,
  RESUMEN_DEFAULT_LIMIT,
  RESUMEN_MAX_LIMIT,
  RESUMEN_VENTANA_DIAS,
  type PiezaConZona,
  type ResumenPieza,
} from './panelRepository.js';

// Dashboard read routes (Step 11, checkpoint D). Reads only. They never expose more than the existing views to
// the same role: the piece view is toPiezaView, the approval state is the public one of /revision (no sequence
// numbers, no comments, no hashes), and the QC summary is the result only for client roles (reason codes for
// NovaCiel). Spend and the NovaCiel overview are staff only.
//
//   GET /clientes/:clienteId/panel/semana?semana=YYYY-MM-DD            week plan + pieces + counts   read_client_data
//   GET /clientes/:clienteId/panel/piezas?estado=a,b&red=&formato=&desde=&hasta=&limite=&antes=       read_client_data
//   GET /clientes/:clienteId/panel/gasto?meses=6                       spend vs budget by month      view_spend
//   GET /panel/resumen?limite=&antes=                                  NovaCiel overview             view_overview
//
// Pending approvals are NOT repeated here: use GET /clientes/:clienteId/aprobaciones/pendientes (Step 9).
// Results (metrics of published pieces) wait for Step 10 and are not offered.

export interface PanelRoutesOptions {
  db: Db;
}

type Params = { clienteId: string };

const localDate = z.string().refine(isValidLocalDate, 'invalid date');
const semanaQuery = z.object({ semana: localDate.optional() }).strict();
const gastoQuery = z.object({ meses: z.coerce.number().int().min(1).max(12).default(6) }).strict();
const resumenQuery = z
  .object({
    limite: z.coerce.number().int().min(1).max(RESUMEN_MAX_LIMIT).default(RESUMEN_DEFAULT_LIMIT),
    antes: z.string().min(1).max(500).optional(),
  })
  .strict();
const estadosCsv = z
  .string()
  .transform((s) => s.split(','))
  .pipe(z.array(z.enum(ESTADOS)).min(1).max(ESTADOS.length));
const piezasQuery = z
  .object({
    estado: estadosCsv.optional(),
    red: z.enum(['instagram', 'facebook', 'tiktok', 'youtube']).optional(),
    formato: z.enum(['reel', 'carrusel', 'post', 'historia']).optional(),
    desde: z.string().datetime({ offset: true }).optional(),
    hasta: z.string().datetime({ offset: true }).optional(),
    limite: z.coerce.number().int().min(1).max(PIEZAS_MAX_LIMIT).default(PIEZAS_DEFAULT_LIMIT),
    antes: z.string().min(1).max(500).optional(),
  })
  .strict();

const invalid = (reply: FastifyReply) => reply.code(400).send({ error: 'invalid_request' });

/** The approval state without the internal sequence numbers (same as the review route). */
const estadoPublico = (e: EstadoAprobacion | null): { estado: string; ronda?: number } | null =>
  e === null ? null : e.estado === 'cambios_pedidos' ? { estado: e.estado, ronda: e.ronda } : { estado: e.estado };

/** A piece as the dashboard lists it: the existing piece view plus the approval and QC summary. */
function itemDePieza(pieza: PiezaConZona, resumen: ResumenPieza | undefined, esNovaciel: boolean) {
  const qc = resumen?.qc ?? null;
  return {
    ...toPiezaView(pieza, pieza.zona_horaria),
    estado_aprobacion: estadoPublico(resumen?.aprobacion ?? null),
    control_calidad: qc
      ? {
          resultado: qc.resultado,
          version: qc.version,
          creado_en: qc.creado_en.toISOString(),
          ...(esNovaciel ? { codigos_fallo: qc.codigos_fallo, codigos_advertencia: qc.codigos_advertencia } : {}),
        }
      : null,
  };
}

export async function registerPanelRoutes(app: App, options: PanelRoutesOptions): Promise<void> {
  const { db } = options;
  const lectura = requirePermission(db, 'read_client_data', (req) => (req.params as Params).clienteId);
  const verGasto = requirePermission(db, 'view_spend', (req) => (req.params as Params).clienteId);
  const verResumen = requirePermission(db, 'view_overview');
  const esNovacielDe = (req: FastifyRequest) => esPersonalNovaciel({ usuarioId: req.auth!.user.id, roles: req.auth!.roles });

  await app.register(async (scope) => {
    scope.addHook('onSend', async (_req, reply) => {
      reply.header('Cache-Control', 'no-store');
    });

    // Only the error name is logged: messages could carry request content.
    scope.setErrorHandler((error, req, reply) => {
      if (error instanceof CursorInvalidoError) return reply.code(400).send({ error: 'invalid_request' });
      const status = (error as { statusCode?: number }).statusCode;
      if (typeof status === 'number' && status >= 400 && status < 500) return reply.code(status).send({ error: 'invalid_request' });
      req.log.error({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'panel route failed');
      return reply.code(500).send({ error: 'internal_error' });
    });

    // ---- The plan of a week with its pieces ----
    scope.get<{ Params: Params }>('/clientes/:clienteId/panel/semana', { preHandler: lectura }, async (req, reply) => {
      const query = semanaQuery.safeParse(req.query);
      if (!query.success) return invalid(reply);
      const clienteId = asClienteId(req.params.clienteId);
      const semana = query.data.semana ? mondayOf(query.data.semana) : undefined;
      const plan = await getPlanDeLaSemana(db, clienteId, semana);
      if (!plan) return { semana_inicio: semana ?? null, plan: null, piezas: [], conteos: {} };
      const piezas = await listPiezasDelPlan(db, clienteId, plan.id);
      const resumenes = await resumenesDePiezas(db, clienteId, piezas.map((p) => p.id));
      const esNovaciel = esNovacielDe(req);
      const conteos: Record<string, number> = {};
      for (const p of piezas) conteos[p.estado] = (conteos[p.estado] ?? 0) + 1;
      return {
        semana_inicio: plan.semana_inicio,
        plan: toPlanView(plan),
        piezas: piezas.map((p) => itemDePieza(p, resumenes.get(p.id), esNovaciel)),
        conteos,
      };
    });

    // ---- Pieces by state ----
    scope.get<{ Params: Params }>('/clientes/:clienteId/panel/piezas', { preHandler: lectura }, async (req, reply) => {
      const query = piezasQuery.safeParse(req.query);
      if (!query.success) return invalid(reply);
      const q = query.data;
      const clienteId = asClienteId(req.params.clienteId);
      // Sequential on purpose: `db` may be a single transaction client.
      const page = await pagePiezas(db, clienteId, {
        ...(q.estado ? { estados: q.estado } : {}),
        ...(q.red ? { red: q.red } : {}),
        ...(q.formato ? { formato: q.formato } : {}),
        ...(q.desde ? { desde: new Date(q.desde) } : {}),
        ...(q.hasta ? { hasta: new Date(q.hasta) } : {}),
        limit: q.limite,
        ...(q.antes ? { antes: q.antes } : {}),
      });
      const conteos = await conteosPorEstado(db, clienteId);
      const resumenes = await resumenesDePiezas(db, clienteId, page.items.map((p) => p.id));
      const esNovaciel = esNovacielDe(req);
      return {
        limite: q.limite,
        siguiente: page.next,
        conteos,
        items: page.items.map((p) => itemDePieza(p, resumenes.get(p.id), esNovaciel)),
      };
    });

    // ---- Spend against the ceiling, by month ----
    scope.get<{ Params: Params }>('/clientes/:clienteId/panel/gasto', { preHandler: verGasto }, async (req, reply) => {
      const query = gastoQuery.safeParse(req.query);
      if (!query.success) return invalid(reply);
      const clienteId = asClienteId(req.params.clienteId);
      const actual = await getSpendSummary(db, clienteId);
      const switches = await getSwitches(db, clienteId);
      const meses = await historialGasto(db, clienteId, query.data.meses);
      return {
        periodo: actual.periodo,
        interruptor_global: switches.global,
        interruptor_cliente: switches.cliente,
        meses: meses.map((m) => {
          // The current month counts reservations too (same figures as the budget summary); past months are settled spend.
          if (m.periodo === actual.periodo) {
            return {
              periodo: m.periodo,
              gastado: microToUsd(actual.spent),
              reservado: microToUsd(actual.reserved),
              techo: actual.ceiling === null ? null : microToUsd(actual.ceiling),
              porcentaje: actual.percentUsed,
            };
          }
          const techo = m.techo === null ? null : usdToMicro(m.techo);
          const gastado = usdToMicro(m.gastado);
          return {
            periodo: m.periodo,
            gastado: microToUsd(gastado),
            reservado: null,
            techo: techo === null ? null : microToUsd(techo),
            porcentaje: techo === null ? null : techo === 0n ? 100 : Number((gastado * 10_000n) / techo) / 100,
          };
        }),
      };
    });

    // ---- NovaCiel overview across clients (staff only; no client content) ----
    scope.get('/panel/resumen', { preHandler: verResumen }, async (req, reply) => {
      const query = resumenQuery.safeParse(req.query);
      if (!query.success) return invalid(reply);
      const cabecera = await cabeceraResumen(db);
      const page = await pageClientes(db, { limit: query.data.limite, ...(query.data.antes ? { antes: query.data.antes } : {}) });
      const resumenes = await resumenesDeClientes(db, page.items.map((c) => c.id), cabecera.periodo);
      return {
        periodo: cabecera.periodo,
        ventana_dias: RESUMEN_VENTANA_DIAS,
        interruptor_global: cabecera.interruptor_global,
        alertas_globales_abiertas: cabecera.alertas_globales_abiertas,
        alertas_globales_criticas: cabecera.alertas_globales_criticas,
        limite: query.data.limite,
        siguiente: page.next,
        clientes: page.items.map((c) => {
          const r = resumenes.get(c.id)!;
          return {
            id: c.id,
            nombre_comercial: c.nombre_comercial,
            estado: c.estado,
            conteos: r.conteos,
            pendientes: r.pendientes,
            alertas_abiertas: r.alertas_abiertas,
            presupuesto: {
              periodo: r.presupuesto.periodo,
              techo: r.presupuesto.techo === null ? null : microToUsd(r.presupuesto.techo),
              usado: microToUsd(r.presupuesto.usado),
              porcentaje: r.presupuesto.porcentaje,
              interruptor_cliente: r.presupuesto.interruptor_cliente,
            },
          };
        }),
      };
    });
  });
}
