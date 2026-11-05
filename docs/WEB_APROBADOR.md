# Web del aprobador del cliente

Vista web para que el dueño o aprobador de un cliente revise las piezas pendientes y decida sobre la
versión exacta que está viendo. Es una tarea de `web/` y `docs/`: el backend no se modifica.

## Cómo levantarlo

1. Backend en `3001`, con el origen de la web como `PUBLIC_BASE_URL`:

   ```powershell
   $env:PUBLIC_BASE_URL = 'http://localhost:5173'
   npm run dev
   ```

   Ese valor debe coincidir con el origen de Vite. El guard CSRF responde `403 forbidden_origin` si
   el `Origin` de un POST no coincide.

2. Web en `5173`:

   ```powershell
   cd web
   npm run dev
   ```

   Vite proxifica `/auth`, `/clientes` y `/files` a `http://localhost:3001` sin cambiar el `Origin`.
   Las URLs firmadas de `/files` también pasan por el proxy.

3. Usuario y cliente ficticios:

   - usuario: `aprobador.aurora@example.test`
   - cliente: `2c16efda-d567-4756-895a-978a60ab454b`

   El seed no fija contraseñas. Para probar a mano, fija una (la pide de forma oculta y no se guarda
   en el repositorio):

   ```powershell
   npm run password:set-dev -- --email aprobador.aurora@example.test
   ```

4. Abre `http://localhost:5173/#/clientes/<cliente>/aprobaciones`.

## Qué hace

- **Lista de pendientes:** piezas que esperan al nivel del usuario, con red, versión, estado y fecha.
  Cada fila enlaza al detalle.
- **Detalle de la pieza:** texto, hashtags, textos alternativos, ubicación, archivos con URL firmada,
  estado de aprobación, historial y control de calidad.
- **Historial:** los comentarios solo se muestran para decisiones de nivel `cliente`; los comentarios
  internos de NovaCiel no se exponen en esta vista.
- **Decisión:** los controles solo aparecen si `/auth/me` confirma un rol de aprobación de cliente
  (`dueno_cliente` o `aprobador_cliente`) para ese cliente y la pieza está en
  `esperando_aprobacion`. Un usuario de NovaCiel no ve los controles.
- **Confirma antes de enviar:** se muestra la versión exacta y se puede cancelar. Mientras el POST
  está en vuelo se deshabilitan todos los controles de decisión.
- **Cuerpos enviados:**
  - aprobar: `{ nivel: 'cliente', decision: 'aprobada', hash_visto, comentario? }`
  - pedir cambios: `{ nivel: 'cliente', decision: 'cambios', hash_visto, motivo, segundo_ms?, comentario? }`
  - `motivo` es obligatorio para cambios; `segundo_ms` es opcional y, si se escribe, debe ser un
    entero mayor o igual que 0. Nunca se envía vacío ni `NaN`.
  - No se envía `rechazada` desde esta vista.
- **Después del 200:** se actualiza `pieza_estado` y `estado_aprobacion` con la respuesta, se
  refresca la revisión y se oculta el formulario. No se inventa texto para `rondas_de_cambios` ni
  `escalada`.
- **Errores:** 401 cierra la sesión; 400 muestra los campos inválidos; 403 y 404 no se reintentan;
  409 `hash_desactualizado` descarta la decisión pendiente, refresca y pide revisar de nuevo sin
  reenviar; otros 409 se muestran en español y refrescan. Un error de red no se reintenta solo.
  Estos caminos están implementados, pero no se probaron manualmente.

## Verificación

### Automática

En `web/`:

- `npm run typecheck`: sin errores.
- `npm run build`: correcto, 30 módulos, sin errores.

### HTTP real

Comprobaciones contra el backend en `127.0.0.1:3001`:

| Petición | Resultado observado |
| --- | --- |
| `GET /health` | `200` con `status: ok` |
| `GET /files/a.jpg` (sin `expires` ni `sig`) | `400 invalid_request` |
| `GET /files/..%2Fsecret?expires=1&sig=x` | `400 invalid_key` |
| `GET /files/media/a.jpg?expires=1&sig=x` | `403 forbidden` |
| `GET /files/...` con firma válida y `expires` pasado | `403 forbidden` |
| `GET /files/...` con firma válida, `expires` futuro y objeto inexistente | `404 not_found` |
| `GET .../aprobaciones/pendientes` sin sesión | `401 unauthorized` |
| `GET /auth/me` sin sesión | `401 unauthorized` |
| `POST /auth/login` con `Origin` ajeno | `403 forbidden_origin` |
| `POST /auth/login` con `Origin` correcto y credenciales falsas | `401 invalid_credentials` |
| `GET http://localhost:5173/` | `200` con el HTML de Vite |
| `GET http://localhost:5173/auth/me` | `401 unauthorized`, proxificado al backend |
| `GET http://localhost:5173/files/a.jpg` | `400 invalid_request`, proxificado al backend |
| `GET http://localhost:5173/.../aprobaciones/pendientes` | `401 unauthorized`, proxificado al backend |

Las dos firmas de `/files` se generaron con el almacenamiento local para una clave inexistente, sin
imprimir el secreto. El `403` de `/files` no distingue entre firma inválida y firma expirada; la
pantalla tampoco puede distinguirlas.

En este equipo Vite escucha en `::1`: usa `http://localhost:5173`, no `http://127.0.0.1:5173`.

### Manual en navegador

Resultados de la prueba manual del checkpoint C.

**VERIFICADO (confirmado por el usuario):**

- Aprobar: la decisión se completó correctamente.
- Pedir cambios: la decisión se completó correctamente.
- Un solo POST por decisión: no se observó un envío duplicado.
- Tras el 200 no quedan botones de decisión visibles.
- Un usuario de NovaCiel no ve los botones de decisión.

**NO VERIFICADO (no probado):**

- `409 hash_desactualizado`: descartar la decisión, refrescar y no reenviar automáticamente.
- Refresco de URLs firmadas al expirar un archivo, y fallback a “archivo no disponible” si vuelve a
  fallar.
- `401` al expirar la sesión, `400` con errores de campo, `403`, `404`, otros `409` y error de red.
- Texto y versión del paso de confirmación, y deshabilitado visual de los controles durante el POST.
- Cancelar en la confirmación.
- Validación local de `motivo` obligatorio y de `segundo_ms` (entero mayor o igual que 0; vacío no
  se envía).
- Texto del mensaje de éxito y actualización visible de `pieza_estado`/`estado_aprobacion` tras el
  200.

## Limitaciones conocidas

- Está implementado que el detalle refresque una vez las URLs firmadas cuando un archivo falla y
  que, si vuelve a fallar, muestre “archivo no disponible”. No se verificó manualmente. No hay
  reintento manual por archivo.
- Los errores 400 se traducen para `motivo`, `segundo_ms`/`segundoMs`, `hash_visto`, `decision`,
  `nivel` y `comentario`; cualquier otro campo cae en un mensaje genérico.
- `rondas_de_cambios`, `escalada` y el estado interno de la pieza no se muestran en esta vista.
- La vista es solo de cliente: no incluye la aprobación interna de NovaCiel ni la aprobación del
  plan.
