# Cómo probar NovaCiel en local

Guía para levantar el backend, verificar las pruebas automáticas y recorrer el flujo de aprobación con un cliente ficticio. Todos los comandos se ejecutan desde la raíz del repositorio y están escritos para PowerShell (en macOS o Linux, usa `cp` en lugar de `Copy-Item` y `export VAR=valor` en lugar de `$env:VAR`).

El sistema todavía no tiene despliegue ni publicación real. Todo corre en local, con un modelo de lenguaje simulado y un cliente de prueba.

## 1. Requisitos previos

| Requisito | Detalle |
| --- | --- |
| Node.js | 22 o superior (proyecto ESM + TypeScript estricto). |
| PostgreSQL | 18, local. Dos bases: `novaciel_db` (desarrollo) y `novaciel_test` (pruebas). |
| FFmpeg y ffprobe | Deben estar en el `PATH`. Se usan para analizar media y renderizar reels. |

Notas:

- La base de pruebas **debe** terminar en `_test`; las pruebas abortan si no es así.
- `novaciel_test` la migra automáticamente el arranque de vitest: no ejecutes `migrate:up` contra ella.
- No se necesita Docker para desarrollo.
- Para los renders de plantillas y subtítulos (Remotion) hace falta un navegador sin pantalla. El script `npm run remotion:browser` está para prepararlo o comprobarlo.

## 2. Variables de entorno (`.env`)

Copia la plantilla y complétala. Nunca se versiona un `.env` con valores reales.

```powershell
Copy-Item .env.example .env
```

| Variable | Valor en desarrollo | Para qué sirve |
| --- | --- | --- |
| `NODE_ENV` | `development` | Habilita el semillero y el proveedor de modelo falso. |
| `PORT` | `3000` | Puerto del backend. |
| `LOG_LEVEL` | `debug` | Nivel de logs. |
| `DATABASE_URL` | `postgresql://USER:PASSWORD@localhost:5432/novaciel_db?sslmode=disable` | Base de desarrollo. |
| `TEST_DATABASE_URL` | `postgresql://USER:PASSWORD@localhost:5432/novaciel_test?sslmode=disable` | Base exclusiva de pruebas. |
| `PUBLIC_BASE_URL` | `http://localhost:5173` | Origen del panel. Es el único `Origin` aceptado en peticiones que cambian algo. |
| `LLM_PROVIDER` | `fake` | Modelo simulado: no hace falta ninguna clave de Anthropic. |
| `STORAGE_DRIVER` | `local` | Guarda los archivos en disco (`LOCAL_STORAGE_DIR`). |
| `LOCAL_STORAGE_SIGNING_SECRET` | cadena aleatoria de 32+ caracteres | Firma las URLs de descarga locales. |
| `SECRETS_KEYS` | `1:<base64>` | Clave AES-256-GCM. Debe decodificar a 32 bytes. |
| `SECRETS_ACTIVE_KEY_VERSION` | `1` | Versión con la que se cifra; debe existir en `SECRETS_KEYS`. |

Revisa también `.env.example` por si hay variables adicionales (por ejemplo, la licencia de Remotion).

Genera los secretos directo al portapapeles, para que no queden en pantalla ni en el historial de la terminal:

```powershell
# clave para SECRETS_KEYS (escribe "SECRETS_KEYS=1:" y pega con Ctrl+V justo después)
node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))" | Set-Clipboard
# LOCAL_STORAGE_SIGNING_SECRET
node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))" | Set-Clipboard
```

Cada valor debe ir en una sola línea, sin comillas ni espacios al final. No reutilices claves de otros entornos.

### `PUBLIC_BASE_URL` y la interfaz

El backend compara el encabezado `Origin` de las peticiones POST y DELETE con `PUBLIC_BASE_URL` (protección CSRF), y la cookie de sesión es `SameSite=Lax`. Para trabajar con la interfaz de Vite debe valer `http://localhost:5173`. Si no coincide, el servidor responde `403` con `forbidden_origin`. Las peticiones sin `Origin` (curl, scripts) se aceptan.

## 3. Puesta en marcha del backend

```powershell
npm install
npm run migrate:up
npm run seed
npm run create-admin -- --email admin@example.com
npm run dev
```

- `migrate:up` lee `.env`, así que debe existir antes.
- `seed` crea datos ficticios (un cliente de prueba y usuarios `@example.test`). Se niega a correr en producción y contra bases `_test`. La segunda ejecución debe informar `Created: 0`.
- `create-admin` crea o actualiza un usuario con el rol `administrador_novaciel`. Pide la contraseña en un prompt oculto, nunca por argumento. Mínimo 12 caracteres.
- `dev` levanta Fastify con recarga en caliente. Comprueba el arranque:

  ```powershell
  Invoke-RestMethod http://localhost:3000/health
  ```

  Debe devolver `status`, `db` y `queue` en `ok`.

## 4. Verificación automática

| Comando | Qué hace |
| --- | --- |
| `npm test` | Suite completa, con los renders reales de FFmpeg. Tarda unos 9 minutos. |
| `npm run test:fast` | Igual, pero sin los archivos `*.render.test.ts`. Unos 5 minutos. |
| `npm run typecheck` | Comprueba los tipos del proyecto y de la parte de Remotion. |

- Usan solo `TEST_DATABASE_URL`; la base de desarrollo no se toca.
- Los archivos se ejecutan de uno en uno porque comparten base.
- No necesitan el backend levantado.
- Lo más sencillo para verificar el sistema es `npm run typecheck` y `npm test`. No hacen falta fotos ni clips.

## 5. Recorrer el flujo con el cliente de prueba

Requiere el backend levantado (`npm run dev`) y media propia. Fija la contraseña de los dos usuarios ficticios (la pide oculta):

```powershell
npm run password:set-dev -- --email admin.novaciel@example.test
npm run password:set-dev -- --email aprobador.aurora@example.test
```

Obtén el identificador del cliente de prueba y guárdalo:

```powershell
psql -U <usuario> -d novaciel_db -t -A -c "SELECT id FROM clientes WHERE nombre_comercial LIKE 'Cafeter%Aurora%' ORDER BY creado_en LIMIT 1;"
$C = '<pega-el-id>'
```

**Media necesaria.** Las fotos del seed miden 640×480 y se rechazan. Usa archivos propios, sin personas:

- **Carrusel:** 5 fotos de al menos 720×900 px.
- **Reel:** 3 clips distintos, de al menos 7 s, verticales de al menos 720×1280 o 4K apaisado. Un 1920×1080 apaisado se rechaza.

```powershell
npm run media:upload -- --cliente $C --file "C:\ruta\foto1.jpg" --tags prueba --aparece-gente false
```

**Recorrido.** Los argumentos exactos de `plan:approve` y `piece:approve` están en el encabezado de cada script en `src/scripts/`.

```powershell
npm run plan:generate -- --cliente $C --semana 2026-12-07      # un lunes libre
npm run plan:approve  -- --cliente $C --plan <PLAN_ID>          # propuesto por NovaCiel, aprobado por el cliente ficticio
npm run brief:generate -- --cliente $C --plan <PLAN_ID>
npm run piece:produce  -- --cliente $C --pieza <PIEZA_ID>       # imprime la ruta de cada archivo
npm run piece:approve  -- --cliente $C --pieza <PIEZA_ID>       # aprobación interna y del cliente
npm run piece:publicable -- --cliente $C --pieza <PIEZA_ID>     # PUBLICABLE solo con las dos aprobaciones
```

**Reglas que conviene comprobar:**

- Un rol de NovaCiel que intenta aprobar como cliente recibe `403`.
- Aprobar con un hash distinto del actual da `409`.
- `npm run piece:reopen -- --cliente $C --pieza <PIEZA_ID> --motivo "prueba"` y luego `piece:produce ... --reproducir` crean una versión nueva. Las aprobaciones anteriores dejan de contar y `piece:publicable` responde NOT PUBLICABLE.

Para ver el registro de aprobaciones:

```powershell
psql -U <usuario> -d novaciel_db -c "select seq, nivel, decision, version, left(encode(hash_pieza,'hex'),16) as hash from aprobaciones where pieza_id='<PIEZA_ID>' order by seq;"
```

## 6. Interfaz web (`web/`)

La interfaz es una aplicación de Vite en `web/` con su propio `package.json`. Por ahora incluye el diccionario de textos en español y el login con sesión. Las pantallas de aprobación están todavía por construir.

Se sirve en `http://localhost:5173` y reenvía `/auth/*` y `/clientes/*` al backend mediante el proxy de desarrollo de Vite (`web/vite.config.ts`, destino `http://localhost:3000`). El proxy no reescribe la cabecera `Origin`, porque el backend la comprueba. Si tu backend corre en otro puerto, ajusta ese destino y que coincida con `PORT`.

```powershell
npm run dev                         # terminal 1: backend, puerto 3000
npm install --prefix web
npm run dev --prefix web            # terminal 2: Vite, puerto 5173
```

Abre `http://localhost:5173` e inicia sesión con un usuario con contraseña (`password:set-dev` o `create-admin`). Comprueba:

- Con una contraseña incorrecta, aparece un mensaje genérico.
- Con la correcta, se ve el inicio con nombre, correo y roles.
- Al recargar, la sesión se mantiene, y "Cerrar sesión" vuelve al login.

Si con la contraseña correcta aparece `403 forbidden_origin`, revisa que `PUBLIC_BASE_URL` sea `http://localhost:5173`.

## 7. Lista de verificación rápida

1. `node --version` y `psql --version` responden; existen `novaciel_db` y `novaciel_test`.
2. `.env` creado desde `.env.example`, con claves nuevas y `PUBLIC_BASE_URL=http://localhost:5173`.
3. `npm run migrate:up` y `npm run seed` terminan sin error.
4. `npm run dev` arranca y `GET /health` devuelve `status: ok`.
5. `npm run typecheck` limpio y `npm test` en verde.