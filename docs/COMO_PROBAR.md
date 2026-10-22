# Cómo probar NovaCiel en local

Guía para calibrar el entorno y verificar la ejecución local del backend y de la futura interfaz web (`web/`).
Todos los comandos se ejecutan desde la raíz del repositorio.

## 1. Requisitos previos

| Requisito | Detalle |
| --- | --- |
| Node.js | 20 o superior (el proyecto es ESM + TypeScript estricto). |
| PostgreSQL | 18, local en Windows. Dos bases: `novaciel_db` para desarrollo y `novaciel_test` para pruebas. |
| FFmpeg y ffprobe | Deben estar en el `PATH`. Se usan para analizar media y renderizar Reels. |

Notas:

- La base de pruebas **debe** terminar en `_test`; las pruebas abortan si no es así.
- `novaciel_test` la migra automáticamente el `globalSetup` de vitest: no ejecutes `migrate:up` contra ella.
- Si no tienes FFmpeg instalado, las pruebas que lo necesitan fallan. Para saltarlas a propósito:

  ```powershell
  $env:NOVACIEL_SKIP_FFMPEG_TESTS = "1"
  npm test
  ```

  Vitest las marcará como omitidas. Esto no sustituye a una ejecución completa antes de cerrar un paso.
- No hay Docker en el equipo de desarrollo; el `docker-compose.yml` es solo para Linux/CI/producción.

## 2. Configuración de variables de entorno (`.env`)

Copia la plantilla y complétala. Nunca se versiona un `.env` con valores reales.

```powershell
Copy-Item .env.example .env
```

Variables clave:

| Variable | Valor en desarrollo | Para qué sirve |
| --- | --- | --- |
| `NODE_ENV` | `development` | Habilita el semillero y el proveedor LLM falso. |
| `PORT` | `3000` | Puerto predeterminado del backend. |
| `DATABASE_URL` | `postgresql://USER:PASSWORD@localhost:5432/novaciel_db?sslmode=disable` | Base de desarrollo. |
| `TEST_DATABASE_URL` | `postgresql://USER:PASSWORD@localhost:5432/novaciel_test?sslmode=disable` | Base exclusiva de pruebas. |
| `PUBLIC_BASE_URL` | `http://localhost:5173` | Origen público del panel; también es el único `Origin` aceptado en peticiones mutantes. |
| `STORAGE_DRIVER` | `local` | Guarda los archivos en disco (`LOCAL_STORAGE_DIR`). |
| `LOCAL_STORAGE_SIGNING_SECRET` | cadena aleatoria de 32+ caracteres | Firma las URLs de descarga locales. |
| `SECRETS_KEYS` | `1:<base64>` | Claves AES-256-GCM para credenciales guardadas. Cada clave debe decodificar a 32 bytes. |
| `SECRETS_ACTIVE_KEY_VERSION` | `1` | Versión con la que se cifran los valores nuevos; debe existir en `SECRETS_KEYS`. |

Genera los secretos con las instrucciones de `.env.example`:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"    # LOCAL_STORAGE_SIGNING_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))" # clave para SECRETS_KEYS
```

### `PUBLIC_BASE_URL` con Vite

Para desarrollo con Vite, `PUBLIC_BASE_URL` debe apuntar a `http://localhost:5173`, no al puerto del backend.
Es obligatorio: el backend compara el encabezado `Origin` de las peticiones mutantes (POST/DELETE) contra
este valor como protección CSRF, y las cookies de sesión usan `SameSite=Lax`. Si el navegador envía un
`Origin` distinto (por ejemplo `http://localhost:5173` cuando `PUBLIC_BASE_URL` quedó en
`http://localhost:3000`), el servidor responde `403` con `{ "error": "forbidden_origin" }`.

Si la variable queda vacía, el backend asume `http://localhost:<PORT>`. Las peticiones sin `Origin`
(herramientas de línea de comandos, curl) se aceptan; las que llevan un `Origin` incorrecto no.

## 3. Inicialización y ejecución del backend

```powershell
npm install                        # dependencias
npm run migrate:up                 # aplica las migraciones de desarrollo
npm run seed                       # datos ficticios de desarrollo
npm run create-admin -- --email admin@example.com
npm run dev                        # tsx watch src/index.ts en el puerto 3000
```

Detalles:

- `npm run migrate:up` lee `.env` mediante `--env-file=.env`, así que el archivo debe existir antes.
- `npm run seed` se niega a correr con `NODE_ENV=production` y contra una base cuyo nombre termine en `_test`.
  Si ffprobe no está disponible, omite los media y lo informa; el resto del semillero continúa.
- `npm run create-admin -- --email <correo>` crea o actualiza el usuario y le asigna el rol
  `administrador_novaciel`. La contraseña se pide en un prompt interactivo oculto (o se lee de stdin);
  nunca se pasa por argumento ni por variable de entorno, y no se imprime. Rechaza bases `*_test`.
- `npm run dev` levanta Fastify con recarga en caliente. Comprueba el arranque con:

  ```powershell
  Invoke-RestMethod http://localhost:3000/health
  ```

  Respuesta esperada: `status`, `db` y `queue` en `ok` (si la base o la cola fallan, responde `503`).
- Para detener el servidor: `Ctrl+C` (cierre ordenado de Fastify, pg-boss y el pool).

## 4. Interfaz web (`web/`) y proxy de Vite

La interfaz es la aplicación de Vite que vivirá en `web/` (todavía no está en el repositorio). Se sirve en
`http://localhost:5173` y no habla con el backend por CORS: reenvía las rutas de API (`/auth/*`, `/clientes/*`,
`/files/*`, etc.) mediante el proxy de desarrollo de Vite hacia el backend.

El destino del proxy es el puerto real del backend: `http://localhost:3000` con la configuración
predeterminada, o `http://localhost:3001` si en tu entorno el backend corre en otro puerto. Debe coincidir
con `PORT` y con `PUBLIC_BASE_URL`.

Configuración esperada en `web/vite.config.ts` cuando exista la interfaz:

```ts
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/auth': 'http://localhost:3000',
      '/clientes': 'http://localhost:3000',
      '/files': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
    },
  },
});
```

Al trabajar con la interfaz, ejecuta en dos terminales:

```powershell
npm run dev                 # terminal 1: backend en 3000
npm run dev --prefix web    # terminal 2: Vite en 5173 (cuando exista web/)
```

Verificación: abre `http://localhost:5173`, inicia sesión con el administrador creado y confirma en las
herramientas del navegador que las peticiones salen hacia `5173` (proxy) y que las mutantes no devuelven
`403 forbidden_origin`.

## 5. Verificación y ejecuciones de pruebas

| Comando | Qué hace |
| --- | --- |
| `npm test` | Suite completa: incluye los renders reales con FFmpeg (`*.render.test.ts`). Es la que cierra un checkpoint. |
| `npm run test:fast` | Igual que la anterior pero excluye `*.render.test.ts`. Sirve para iterar; no reemplaza a `npm test`. |
| `npm run typecheck` | `tsc --noEmit` sobre todo el proyecto. |

Notas sobre las pruebas:

- Usan exclusivamente `TEST_DATABASE_URL`; la base de desarrollo no se toca. El propio arranque de vitest
  aplica las migraciones pendientes en la base de pruebas.
- Los archivos se ejecutan de uno en uno porque comparten base y pueden truncar tablas.
- `npm test` y `npm run test:fast` no necesitan el backend levantado.
- Antes de cerrar un paso: `npm run typecheck` limpio y `npm test` en verde (o `NOVACIEL_SKIP_FFMPEG_TESTS=1`
  solo si la máquina no tiene FFmpeg y se documenta el motivo).

## 6. Lista de verificación rápida

1. `node --version` y `psql --version` responden; existen `novaciel_db` y `novaciel_test`.
2. `.env` creado desde `.env.example`, con `PUBLIC_BASE_URL=http://localhost:5173`, secretos generados y
   `PORT=3000`.
3. `npm run migrate:up` y `npm run seed` terminan sin error.
4. `npm run create-admin -- --email <correo>` crea el administrador y pide la contraseña de forma oculta.
5. `npm run dev` arranca y `GET /health` devuelve `status: ok`.
6. `npm run typecheck` limpio y `npm test` en verde.
