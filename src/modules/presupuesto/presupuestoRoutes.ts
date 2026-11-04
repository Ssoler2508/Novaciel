import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Db } from '../../db/types.js';
import type { App } from '../auth/appType.js';
import { requirePermission } from '../auth/authorize.js';
import {
  listPrices,
  PermissionDeniedError,
  PRICE_LIST_DEFAULT_LIMIT,
  PRICE_LIST_MAX_LIMIT,
  PriceExistsError,
  PriceRetroactiveError,
  setModelPrice,
  setUnitPrice,
  type ModelPrice,
  type UnitPrice,
} from '../precios/preciosRepository.js';
import { asClienteId } from '../shared/clienteId.js';
import { microToUsd, usdToMicro } from './money.js';
import {
  ClientNotFoundError,
  getSwitches,
  LEDGER_DEFAULT_LIMIT,
  LEDGER_MAX_LIMIT,
  listLedger,
  PastPeriodError,
  setClientSpendSwitch,
  setGlobalSpendSwitch,
  setMonthlyCeiling,
} from './presupuestoAdmin.js';
import { getSpendSummary } from './presupuestoService.js';

// Budget and price routes (Step 11, checkpoint B). Money travels as USD decimal strings with up to six
// decimals ("12.5", never a float, never negative). Reads of a client's spend need `view_spend`
// (NovaCiel staff); the client roles see neither spend nor ceiling. Writes are administrator only
// (`manage_budget` for ceilings and switches, `manage_prices` for prices) and audited by the repositories.
//
//   GET  /clientes/:clienteId/presupuesto?periodo=YYYY-MM-01           summary + switches            view_spend
//   GET  /clientes/:clienteId/presupuesto/libro?periodo=&limite=&antes=  ledger, newest first      view_spend
//   PUT  /clientes/:clienteId/presupuesto/techo        {periodo, monto}                            manage_budget
//   PUT  /clientes/:clienteId/presupuesto/interruptor  {habilitado}                                manage_budget
//   PUT  /presupuesto/interruptor-global               {habilitado}                                manage_budget
//   GET  /precios?limite=&desde=                                                                   view_prices
//   POST /precios                                                                                  manage_prices
//
// The ledger shows purpose, provider, model, unit, quantities, cost and result: never prompts or content.
// The CSRF guard requires Content-Type: application/json on every PUT and POST.

export interface PresupuestoRoutesOptions {
  db: Db;
}

type ClientParams = { clienteId: string };

const MONEY = z.string().regex(/^\d{1,12}(\.\d{1,6})?$/, 'money must be a non-negative USD decimal with up to six decimals');
const PERIODO = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-01$/);
const TEXT = z.string().trim().min(1).max(100);

const techoBody = z.object({ periodo: PERIODO, monto: MONEY }).strict();
const interruptorBody = z.object({ habilitado: z.boolean() }).strict();

const common = {
  proveedor: TEXT,
  modelo: TEXT,
  vigente_desde: z.string().datetime({ offset: true }).optional(),
  nota: z.string().trim().min(1).max(500).optional(),
};
const precioTokensBody = z
  .object({ ...common, unidad: z.literal('tokens').optional(), entrada_por_millon: MONEY, salida_por_millon: MONEY })
  .strict();
const precioUnidadBody = z
  .object({
    ...common,
    unidad: z.enum(['caracteres', 'segundos', 'imagenes']),
    precio_por_bloque: MONEY,
    tamano_bloque: z.number().int().min(1).max(1_000_000_000),
  })
  .strict();

const libroQuery = z
  .object({
    periodo: PERIODO.optional(),
    limite: z.coerce.number().int().min(1).max(LEDGER_MAX_LIMIT).default(LEDGER_DEFAULT_LIMIT),
    antes: z.string().regex(/^\d{1,18}$/).optional(),
  })
  .strict();
const preciosQuery = z
  .object({
    limite: z.coerce.number().int().min(1).max(PRICE_LIST_MAX_LIMIT).default(PRICE_LIST_DEFAULT_LIMIT),
    desde: z.coerce.number().int().min(0).max(1_000_000).default(0),
  })
  .strict();
const resumenQuery = z.object({ periodo: PERIODO.optional() }).strict();

const bad = (reply: FastifyReply) => reply.code(400).send({ error: 'invalid_request' });

function priceView(p: ModelPrice | UnitPrice) {
  const base = { id: p.id, proveedor: p.provider, modelo: p.model, vigente_desde: p.vigenteDesde.toISOString(), nota: p.nota };
  if ('unit' in p) {
    return { ...base, unidad: p.unit, precio_por_bloque: microToUsd(p.pricePerBlock), tamano_bloque: Number(p.blockSize) };
  }
  return { ...base, unidad: 'tokens', entrada_por_millon: microToUsd(p.inputPerMillion), salida_por_millon: microToUsd(p.outputPerMillion) };
}

export async function registerPresupuestoRoutes(app: App, options: PresupuestoRoutesOptions): Promise<void> {
  const { db } = options;
  const verGasto = requirePermission(db, 'view_spend', (req) => (req.params as ClientParams).clienteId);
  const gestionarPresupuesto = requirePermission(db, 'manage_budget');
  const verPrecios = requirePermission(db, 'view_prices');
  const gestionarPrecios = requirePermission(db, 'manage_prices');

  await app.register(async (scope) => {
    scope.addHook('onSend', async (_req, reply) => {
      reply.header('Cache-Control', 'no-store');
    });

    // Only the error name is logged: messages could carry request content.
    scope.setErrorHandler((error, req, reply) => {
      const status = (error as { statusCode?: number }).statusCode;
      if (typeof status === 'number' && status >= 400 && status < 500) return reply.code(status).send({ error: 'invalid_request' });
      if (error instanceof PermissionDeniedError) return reply.code(403).send({ error: 'forbidden' });
      if (error instanceof ClientNotFoundError) return reply.code(404).send({ error: 'not_found' });
      if (error instanceof PastPeriodError) return reply.code(400).send({ error: 'periodo_pasado' });
      if (error instanceof PriceRetroactiveError) return reply.code(400).send({ error: 'precio_retroactivo' });
      if (error instanceof PriceExistsError) return reply.code(409).send({ error: 'precio_existe' });
      req.log.error({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'budget route failed');
      return reply.code(500).send({ error: 'internal_error' });
    });

    const actorOf = (req: { auth?: { user: { id: string } } }) => ({ tipo: 'usuario', usuarioId: req.auth!.user.id }) as const;

    scope.get<{ Params: ClientParams }>('/clientes/:clienteId/presupuesto', { preHandler: verGasto }, async (req, reply) => {
      const q = resumenQuery.safeParse(req.query);
      if (!q.success) return bad(reply);
      const clienteId = asClienteId(req.params.clienteId);
      const [s, sw] = await Promise.all([getSpendSummary(db, clienteId, q.data.periodo), getSwitches(db, clienteId)]);
      return {
        periodo: s.periodo,
        techo: s.ceiling === null ? null : microToUsd(s.ceiling),
        gastado: microToUsd(s.spent),
        reservado: microToUsd(s.reserved),
        restante: s.remaining === null ? null : microToUsd(s.remaining),
        porcentaje: s.percentUsed,
        techo_mensual_defecto: sw.techoMensualDefecto === null ? null : microToUsd(sw.techoMensualDefecto),
        interruptor_global: sw.global,
        interruptor_cliente: sw.cliente,
      };
    });

    scope.get<{ Params: ClientParams }>('/clientes/:clienteId/presupuesto/libro', { preHandler: verGasto }, async (req, reply) => {
      const q = libroQuery.safeParse(req.query);
      if (!q.success) return bad(reply);
      const clienteId = asClienteId(req.params.clienteId);
      const periodo = q.data.periodo ?? (await getSpendSummary(db, clienteId)).periodo;
      const page = await listLedger(db, clienteId, { periodo, limit: q.data.limite, ...(q.data.antes ? { before: q.data.antes } : {}) });
      return {
        periodo,
        limite: q.data.limite,
        siguiente: page.next,
        items: page.items.map((e) => ({
          id: e.id,
          proposito: e.proposito,
          proveedor: e.proveedor,
          modelo: e.modelo,
          unidad: e.unidad,
          unidades_entrada: e.unidadesEntrada,
          unidades_salida: e.unidadesSalida,
          costo: e.costoReal,
          resultado: e.resultado,
          creado_en: e.creadoEn.toISOString(),
        })),
      };
    });

    scope.put<{ Params: ClientParams }>('/clientes/:clienteId/presupuesto/techo', { preHandler: gestionarPresupuesto }, async (req, reply) => {
      const body = techoBody.safeParse(req.body);
      if (!body.success) return bad(reply);
      let clienteId;
      try {
        clienteId = asClienteId(req.params.clienteId);
      } catch {
        return reply.code(404).send({ error: 'not_found' });
      }
      const change = await setMonthlyCeiling(db, clienteId, { periodo: body.data.periodo, monto: usdToMicro(body.data.monto) }, actorOf(req));
      return {
        periodo: change.periodo,
        techo_anterior: change.antes === null ? null : microToUsd(change.antes),
        techo: microToUsd(change.despues),
        por_debajo_del_gasto: change.porDebajoDelGasto,
      };
    });

    scope.put<{ Params: ClientParams }>('/clientes/:clienteId/presupuesto/interruptor', { preHandler: gestionarPresupuesto }, async (req, reply) => {
      const body = interruptorBody.safeParse(req.body);
      if (!body.success) return bad(reply);
      let clienteId;
      try {
        clienteId = asClienteId(req.params.clienteId);
      } catch {
        return reply.code(404).send({ error: 'not_found' });
      }
      const change = await setClientSpendSwitch(db, clienteId, body.data.habilitado, actorOf(req));
      return { interruptor_cliente: change.despues, anterior: change.antes };
    });

    scope.put('/presupuesto/interruptor-global', { preHandler: gestionarPresupuesto }, async (req, reply) => {
      const body = interruptorBody.safeParse(req.body);
      if (!body.success) return bad(reply);
      const change = await setGlobalSpendSwitch(db, body.data.habilitado, actorOf(req));
      return { interruptor_global: change.despues, anterior: change.antes };
    });

    scope.get('/precios', { preHandler: verPrecios }, async (req, reply) => {
      const q = preciosQuery.safeParse(req.query);
      if (!q.success) return bad(reply);
      const { items, total } = await listPrices(db, { limit: q.data.limite, offset: q.data.desde });
      return {
        total,
        limite: q.data.limite,
        desde: q.data.desde,
        items: items.map((p) => ({
          id: p.id,
          proveedor: p.proveedor,
          modelo: p.modelo,
          unidad: p.unidad,
          entrada_por_millon: p.precioEntradaPorMillon,
          salida_por_millon: p.precioSalidaPorMillon,
          precio_por_bloque: p.precioPorBloque,
          tamano_bloque: p.tamanoBloque === null ? null : Number(p.tamanoBloque),
          vigente_desde: p.vigenteDesde.toISOString(),
          nota: p.nota,
          estado: p.estado,
        })),
      };
    });

    scope.post('/precios', { preHandler: gestionarPrecios }, async (req, reply) => {
      const unidad = (req.body as { unidad?: unknown } | null)?.unidad;
      const actor = actorOf(req);
      if (unidad === undefined || unidad === 'tokens') {
        const body = precioTokensBody.safeParse(req.body);
        if (!body.success) return bad(reply);
        const price = await setModelPrice(
          db,
          {
            provider: body.data.proveedor,
            model: body.data.modelo,
            inputPerMillion: usdToMicro(body.data.entrada_por_millon),
            outputPerMillion: usdToMicro(body.data.salida_por_millon),
            ...(body.data.vigente_desde ? { vigenteDesde: new Date(body.data.vigente_desde) } : {}),
            ...(body.data.nota ? { nota: body.data.nota } : {}),
          },
          actor,
        );
        return reply.code(201).send(priceView(price));
      }
      const body = precioUnidadBody.safeParse(req.body);
      if (!body.success) return bad(reply);
      const price = await setUnitPrice(
        db,
        {
          provider: body.data.proveedor,
          model: body.data.modelo,
          unit: body.data.unidad,
          pricePerBlock: usdToMicro(body.data.precio_por_bloque),
          blockSize: body.data.tamano_bloque,
          ...(body.data.vigente_desde ? { vigenteDesde: new Date(body.data.vigente_desde) } : {}),
          ...(body.data.nota ? { nota: body.data.nota } : {}),
        },
        actor,
      );
      return reply.code(201).send(priceView(price));
    });
  });
}
