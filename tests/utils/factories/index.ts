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
