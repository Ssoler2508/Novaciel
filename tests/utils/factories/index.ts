// Factory conventions (each table checkpoint adds its own):
// - insert with plain SQL into the test database, never through repositories;
// - signature: (db: Db, overrides?: Partial<Row>) => Promise<Row>;
// - generate unique values with uniqueSuffix(); return the inserted row.
export { uniqueSuffix } from './unique.js';
export { createCliente } from './clientes.js';
export { createUsuario } from './usuarios.js';
export { assignRole } from './roles.js';
export { createPerfilMarca, PERFIL_BLOCKS } from './perfilMarca.js';
export { createHechoVerificado } from './hechosVerificados.js';
export { createReglaProhibida } from './reglasProhibidas.js';
export { createAutorizacionImagen } from './autorizacionesImagen.js';
export { createConexionRed } from './conexionesRedes.js';
export { createSesion } from './sesiones.js';
export {
  createTope,
  createAutorizacionGasto,
  createLibroGasto,
  createConfiguracionGastoCliente,
  currentPeriodo,
} from './presupuesto.js';
export { createPrecioModelo } from './precios.js';
export { createMedia, createMediaAutorizacion } from './media.js';
export { createPlanSemanal, createPieza, createPiezaHecho, insertHistorial, moverPieza, DEFAULT_MONDAY } from './planesPiezas.js';
export { createGuion, createToma, createGuionHecho, guionContenido } from './guiones.js';
export { createProduccion, createProduccionArchivo, createProduccionFuente } from './producciones.js';
export { createRevisionCalidad, checkQC } from './revisionesCalidad.js';
export type { RevisionCalidadRow, CheckQC } from './revisionesCalidad.js';
export {
  createAprobableWorld,
  createActores,
  createPiezaAprobable,
  CONTENIDO_PRODUCCION,
  createAprobacion,
  createAprobacionPlan,
  createAprobadoresCliente,
  createUsuarioConRol,
  planHuella,
} from './aprobaciones.js';
export type { PiezaAprobable, Actores } from './aprobaciones.js';
