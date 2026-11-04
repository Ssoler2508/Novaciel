# Notas de entrega: novaciel-core

Para NovaCiel y el Senior. Estado a 2026-11-02: Pasos 0 a 7d, 8 y 9 construidos; Paso 10, Paso 11 y Paso 12 no. Para instalar y ejecutar, ver el [README](../README.md). Tablero: [PLAN.md](PLAN.md). Decisiones: [ADR_INDEX.md](ADR_INDEX.md).

Resultado de la verificación final de esta entrega (Paso 7d, 2026-11-02): 167 archivos de pruebas y 2578 pruebas en verde con `npm test` (15 min) y 160 archivos y 2485 pruebas con `npm run test:fast` (6 min); `npm run typecheck` limpio. `npm run build` y `npm audit` se verificaron por última vez en la limpieza anterior (127 archivos y 2087 pruebas), no en los Pasos 8 ni 7d.

## 1. Qué está construido

| Paso | Qué hace | Real o simulado |
| --- | --- | --- |
| 0, 1, 1b | PostgreSQL local, pool `pg`, migraciones, logger con redacción, cola pg-boss, interfaz `Storage`, Fastify | Real. `S3Storage` existe pero **nunca se probó contra un servidor real**. |
| 2 | Clientes, roles, perfil de marca versionado, hechos verificados, reglas prohibidas, autorizaciones de imagen, auditoría, semilla ficticia | Real. Datos de prueba ficticios. |
| 2b | Contraseñas (scrypt), sesiones en servidor, login/logout, matriz de permisos, cifrado AES-256-GCM, `conexiones_redes` cifradas, `create-admin` | Real. |
| 3 | Control de presupuesto (autorización antes de toda llamada de pago), adaptador de modelo de lenguaje, validación con zod, un reintento y alerta | Adaptador Claude real, **modelo simulado (`fake`) por defecto**. Las alertas solo van al log. |
| 4 | Biblioteca de media: subida, validación de formato y tamaño, ffprobe, etiquetas, derechos, descripción opcional | Real con almacenamiento local. **Visión simulada**: no existe adaptador de visión real. |
| 5 | Planificador semanal y máquina de estados de las piezas | Planificador con modelo simulado por defecto. |
| 6 | Director creativo: brief por pieza, cada dato rastreado a un hecho verificado, sin mencionar IA | Modelo simulado por defecto. |
| 7a | Carruseles con media real y texto encima, hash de cada archivo y hash de la pieza | Real (`@napi-rs/canvas`, fuente Inter). |
| 7b | Reels: cortes y montaje con FFmpeg, verificación de la salida y de los metadatos | Real (FFmpeg del sistema). |
| 7c | Plantillas de texto animado y subtítulos palabra a palabra con Remotion | Real si `REMOTION_LICENCIA` está definida; si no, los reels usan el texto plano de 7b. |
| 7d | Locución sintética de los reels: ElevenLabs detrás de un puerto `VoiceProvider` con versión falsa, precios por unidad (caracteres) en el control de presupuesto, voz por cliente en el perfil (`voz.locucion`, con `voice:configure`), caché de locuciones por cliente, mezcla en la pasada de FFmpeg con ganancia estática a −16 LUFS, subtítulos palabra por palabra con los tiempos reales de la voz y control de calidad de la voz (ADR-08) | Adaptador ElevenLabs escrito y probado con `fetch` simulado, **nunca llamado de verdad**: `voice:smoke` es la primera llamada real. **Voz simulada (`fake`) por defecto en desarrollo**; en producción `VOICE_PROVIDER` debe fijarse (`none` para no usar voz). Sin plantilla de subtítulos (Remotion apagado) el reel sale sin voz y el control de calidad lo avisa. |
| 8 | Control de calidad automático: 43 comprobaciones deterministas (38 del Paso 8 y 5 de la voz del Paso 7d: archivos releídos y re-hasheados, imágenes, reels, formato de los textos, palabras y promesas prohibidas, cifras contra hechos verificados, media usable, horario, marca), informe atado a la producción exacta, trabajo automático tras cada producción y rutas de lectura y reejecución solo para NovaCiel (ADR-07) | Real. **Ninguna comprobación usa un modelo**; las de visión y de tono son deuda. |
| 9 | Aprobación en dos niveles sobre el hash exacto de la pieza, rondas de cambios, escalada, recordatorios, suplente, puerta de publicación (`assertPublicable`) | Real. **Notificador simulado**: solo registra ids y nombres de plantilla. |

Resumen de lo que es simulado o local: modelo de lenguaje `fake` por defecto, voz `fake` por defecto, visión `fake`, notificador `fake`/log, almacenamiento local en disco, **no hay publicación en ninguna red**.

## 2. Reglas innegociables y dónde se aplica cada una

| # | Regla | Dónde se aplica |
| --- | --- | --- |
| 1 | Nada se publica sin aprobación humana del archivo exacto | Guarda en la base de datos `historial_estados_pieza_aprobacion` (migración 1800): ninguna pieza entra en `aprobada` ni `programada` sin las dos aprobaciones del hash vigente. `src/modules/aprobaciones/publicable.ts` (`assertPublicable`). Hash: `docs/HASH_PIEZA_NP1.md`. Desde el Paso 8 también exigen un informe de control de calidad aprobado de la producción vigente (`assertPublicable` y la misma guarda; ADR-07). |
| 2 | Todo dato del negocio sale de `hechos_verificados` vigentes | `src/modules/hechos` (los vencidos no se devuelven); fichas de hechos en `src/modules/directorCreativo/tokens.ts` y esquema del brief. |
| 3 | Toda tabla de cliente lleva `cliente_id` y toda consulta lo filtra | Repositorios de `src/modules/*`; prueba transversal `src/modules/isolation.test.ts`. |
| 4 | Todo proveedor externo detrás de un adaptador con versión falsa | `src/lib/ai`, `src/lib/media` (almacenamiento, ffprobe, FFmpeg), `src/lib/notificaciones`, puerto `CapaTextoAnimado` (`src/modules/produccion/capaTexto.ts`). Modelos y precios en configuración. |
| 5 | Ninguna llamada de pago sin autorización de presupuesto | `authorize` en `src/modules/presupuesto/presupuestoService.ts`. |
| 6 | Media real primero; la IA nunca genera el producto, el local ni personas reales | `src/modules/media` (derechos y autorizaciones de imagen), `src/modules/directorCreativo/detectors.ts`. |
| 7 | Credenciales cifradas, nunca en código, logs ni commits; datos de prueba ficticios | `src/lib/crypto/secrets.ts`, `getSecretForUse` en `src/modules/conexionesRedes`, redacción en `src/lib/logger`. Historial de git revisado en esta limpieza: sin secretos. |
| 8 | Salida del modelo validada con zod; un reintento y luego alerta | `src/modules/ai/generateStructured.ts`. |
| 9 | Lo que se lee de fuera son datos, nunca instrucciones | `src/modules/ai/wrapExternalData.ts`, usado por el planificador y el director creativo. |

## 3. Qué NO está construido

- **Controles de calidad con modelo** (consistencia visual de marca, tono de voz, ortografía, defectos de tomas con IA) y los técnicos que la espec. 10 pide y no se decidieron en código (volumen de audio normalizado solo existe para los reels con locución; cuadros negros o congelados, medición de zonas seguras, licencia de música). Ver ADR-07, sección 8.
- **Paso 10, publicación.** Debe llamar a `assertPublicable` **con la pieza bloqueada** (o volver a comprobar justo antes de enviar), recalcular y verificar el hash antes de enviar y, si cambia `fecha_hora`, **reprogramar los recordatorios y también el aviso de vencimiento** (`vencimiento`, que se programa justo a la hora límite y levanta la alerta `aprobacion_vencida`). Tampoco existe aún el intermediario de publicación ni la recolección de métricas.
- **Paso 11, tablero y alertas reales.** Las alertas ya se guardan (tabla `alertas`, rutas de lista y reconocimiento, catálogo en PLAN.md) y los avisos pasan por el Notificador simulado (solo ids y nombres de plantilla). Faltan las vistas del tablero (punto D) y las rutas de gestión de aprobadores.
- **Paso 12, prueba de punta a punta** de la semana completa.
- **Interfaz web** (`web/`): la mantiene otra herramienta y está fuera de estas notas; las rutas de plan, pieza y aprobación mantienen su forma porque la interfaz depende de ellas.

## 4. Deuda conocida consolidada

Fuentes: PLAN.md, ADR-05, ADR-06, ADR-07 y esta limpieza.

**Seguridad y cuentas (Paso 2b)**
1. Sin restablecimiento de contraseña por correo, sin segundo factor y sin límite de intentos por IP.
2. Sin script de re-cifrado para rotar `SECRETS_KEYS` (las claves viejas deben seguir en la lista).

**Almacenamiento**
3. `S3Storage` nunca se probó contra un servidor real.

**Aprobaciones (ADR-05)**
4. `assertPublicable` comprueba pero **no bloquea**: entre la comprobación y el envío algo puede cambiar. El Paso 10 debe llamarlo con la pieza bloqueada.
5. El Paso 10 debe reprogramar los recordatorios **y el aviso de vencimiento** al cambiar `fecha_hora`; los trabajos ya en cola llevan el plazo viejo y no hacen nada. Sin reprogramar el vencimiento, una pieza movida que nadie aprueba no genera la alerta `aprobacion_vencida`.
6. La regla "sin aprobación a la hora programada: reprogramar y avisar a NovaCiel" (espec. 11.3) pertenece a la publicación.
7. No hay rutas para `reabrirPieza` ni para cambiar aprobadores del cliente (hoy solo scripts de desarrollo).
8. La revisión interna no se retira nunca (espec. 11.1 prevé retirarla tras 4 semanas por cliente o 20 piezas del mismo tipo sin cambios).
9. El plazo de un plan se toma como la hora más temprana de sus piezas (la especificación no lo define).

**Remotion (ADR-06)**
10. Los fotogramas posteriores a la última palabra son idénticos y podrían enlazarse en vez de guardarse.
11. Se abre un navegador por escena; podría compartirse entre las escenas de un reel.
12. Los paquetes de Remotion en caché (`.data/remotion`) no se limpian.
13. Hay que quedarse en Remotion 4.0.x: la licencia cambia en 5.0.

**Estructura**
14. Los `index.ts` de `produccion`, `planificador`, `directorCreativo` y `aprobaciones` re-exportan mucha más API de la que se usa fuera del módulo. No se tocó para no retirar API pública sin necesidad.
15. `maxOutputTokensFor` y `singletonKey*` existen con la misma forma en varios módulos (firmas y prefijos distintos; no se unificaron).

**Pruebas**
16. `src/modules/conexionesRedes/conexionesRedesRepository.test.ts` ("create stores no plaintext…") falló una vez en `npm run test:fast` bajo carga y pasó en tres ejecuciones posteriores. Se trata como intermitente; conviene vigilarlo.
17. La suite completa tarda entre 16 y 24 minutos en el portátil de desarrollo.

**Dependencias**
18. `@anthropic-ai/sdk` está en 0.131; la versión 1.x es un salto mayor que no se evaluó. Varias dependencias usan rangos `^`; `package-lock.json` fija lo instalado.

**Control de calidad (ADR-07)**
19. Faltan los controles con modelo y los técnicos de la espec. 10 listados en la sección 3.
20. Las advertencias (`programacion_proxima`, `marca_colores_respaldo`) no se muestran todavía al cliente (Paso 11) ni hay controles propios por cliente.
21. `verifyReelOutput` se detiene en el primer fallo: un reel con varios defectos muestra uno por ejecución, y las familias posteriores no se reportan hasta corregirlo (ADR-07, sección 6).
22. `programacion_proxima` y `marca_fuente_no_permitida` solo tienen pruebas unitarias; ninguna prueba del servicio los produce (ADR-07, sección 7).
23. Los valores de la casa del catálogo marcados VERIFY (tamaños máximos, topes de texto, parámetros de codificación, opacidad del velo) siguen sin comprobarse contra la documentación de las redes (pregunta 6).

**Voz en off (ADR-08, Paso 7d)**
24. ~~El prompt del director creativo sigue escribiendo `texto_en_pantalla` y `voz_en_off` como dos campos separados~~ **Resuelto en chore/deuda-01:** para un reel de un cliente con voz habilitada (`BriefContext.conVoz`), `voz_en_off` es el texto principal de cada escena (hablado y subtitulado) y es obligatorio; `texto_en_pantalla` sigue siendo obligatorio pero es un título corto de respaldo (tope de la casa `TITULO_RESPALDO_MAX` = 40 caracteres, VERIFY) que solo se dibuja si la voz se omite en producción. Sin voz y en los demás formatos el prompt y el esquema no cambian.
25. La cota mínima de duración antes de pagar usa 24 caracteres por segundo (VERIFY): una voz demasiado larga, pero no por tanto, se descubre después de pagarla (queda en caché).
26. Los valores de sonoridad (−16 LUFS ± 2 LU, pico −0,5 dBTP, techo del limitador −1 dBFS, silencio −50 LUFS) son valores de la casa por verificar con las redes.
27. ~~"Voz omitida" vive en la auditoría de la producción~~ **Resuelto en chore/deuda-01:** columna `producciones.voz_omitida_motivo` (inmutable, lista cerrada de motivos); el control de calidad la lee y, para las producciones anteriores (NULL), usa la fila de auditoría como respaldo y lo registra como `origen: auditoria`.
28. `voice:smoke` y la primera llamada real de ElevenLabs siguen sin hacerse: hasta entonces están por verificar la cabecera `xi-api-key`, la cabecera `request-id` y que la cantidad facturada coincida con los caracteres enviados (ADR-08).
29. La voz solo existe en reels. Voces clonadas, varias voces por reel, emoción por escena, música y efectos son deuda (spec 9.5 y 16).
30. **Vista de costos del panel (spec 13.4) y exportación:** el Paso 11 solo da, por cliente, el gasto frente al tope y el historial por mes (`/panel/gasto`). Quedan como deuda: costo total, directo y compartido (el reparto de costos compartidos y `costos_compartidos`); costo por tipo de pieza y costo promedio por pieza publicada; costo por proveedor y por modelo; gasto en intentos fallidos y en piezas rechazadas; uso frente a las cuotas del plan; la exportación a hoja de cálculo por cliente y por mes; y el cierre mensual (`cierres_mensuales`, el día 1 se congela el mes anterior). El libro de gastos ya guarda proveedor, modelo, propósito y resultado, así que el desglose se puede añadir con rutas nuevas de solo lectura sin cambiar las existentes.

## 5. Preguntas abiertas para NovaCiel

1. **Tres transiciones nuevas a `con_cambios`:** la espec. 15 no las prevé desde `aprobada`, `programada` ni `revision_novaciel` (ADR-05, secciones 1, 5 y checkpoint C; la tercera es del Paso 8: la decisión interna "cambios" ya no puede darse desde `en_control_calidad`, así que necesita salida desde `revision_novaciel`). ¿Se confirman?
2. **Turno del suplente:** la espec. 11.3 solo dice "después de los recordatorios". Se usa 2 h antes de la hora programada, configurable (`suplenteHoras`).
3. **Plazo del plan semanal:** se usa la hora más temprana de sus piezas. ¿Es correcto?
4. **Remotion y el contratista:** NovaCiel es de 3 personas con cuenta gratuita. ¿El desarrollador, que es contratista independiente, cuenta como persona (3 o 4)? Decide entre la licencia gratuita y la de empresa antes del uso en producción. Si la respuesta es "cuenta", comprar la licencia de empresa y usar `REMOTION_LICENCIA=empresa`.
5. **Idioma `ambos`:** ¿qué debe hacer el sistema para un cliente que necesite español e inglés? ¿Algún cliente necesitará inglés?
6. **Valores de la casa marcados VERIFY:** calidad y velocidad de x264, tasa de bits máxima y buffer, y fotogramas por segundo constantes (`reelFfmpegArgs.ts`, `reelTimeline.ts`), y los tamaños que la especificación no da (`dimensiones.ts`).
7. **Clave de Anthropic del sistema y presupuesto de prueba:** ¿quién crea la clave y cuál es el presupuesto? ¿Se permite la cuenta Pro compartida o se usa un plan de equipo?
8. **Proveedor de voz:** el Paso 7d usa ElevenLabs (ADR-08). **Pendiente de NovaCiel:** qué plan se contrata y si sus términos permiten el uso comercial de la voz sintética (la página de precios no lo dice para TTS); qué etiqueta de contenido con IA exigen Meta y TikTok para audio sintético; si algún día se ofrecerá clonar la voz del dueño de un cliente (exige consentimiento escrito, deuda conocida). **Intermediario de publicación** (después de la Fase 0).
9. **Producción:** versión de PostgreSQL y sistema operativo (hoy 18 en local y 16 en el compose), y servicio de almacenamiento compatible con S3.
10. **Columnas de `clientes` y `usuarios`, claves JSON del perfil y campos obligatorios por bloque** (ADR-04, propuestas pendientes del Senior).
11. ¿Cuándo se retira la revisión interna (ver deuda 8)?
12. ¿Los precios y datos del cliente ficticio deben ser en USD y de EE. UU.? ¿Basta "fecha de fin obligatoria + revocación" como consentimiento de imagen en EE. UU.?
13. ¿"El sistema en español" incluye código, comentarios y commits o solo nombres de dominio e interfaz? Hoy el código está en inglés.

14. **Qué ve el cliente del control de calidad:** hoy solo el resultado, la versión y la fecha; los códigos y las advertencias son de NovaCiel. ¿Se confirma, o el cliente debe ver los motivos de un rechazo?
15. **Piezas anteriores al Paso 8:** las que estaban en `en_control_calidad` se controlan con `npm run qc:run`; las rechazadas por `media_no_usable` (media de prueba ya borrada) hay que producirlas de nuevo. ¿Basta así, o se limpian los datos de desarrollo?
16. **Gasto y techo para el dueño del cliente (Paso 11):** hoy el dueño no ve ni el gasto ni el techo (solo el administrador y el operador de NovaCiel tienen `view_spend`). Al llegar al 100 % del techo recibe un aviso con plantilla y sin cifras (espec. 13.1). ¿Debe ver su propio gasto y techo, en solo lectura? Pendiente del Senior.

La Fase 0 (verificaciones previas: precios de modelos de imagen y video, intermediarios de publicación, límites de estadísticas, términos de música libre, requisitos legales de EE. UU., etc.) sigue abierta salvo la licencia de Remotion.

## 6. Acción de seguridad pendiente

**La `ANTHROPIC_API_KEY` antigua que se expuso al inicio del proyecto debe rotarse y quitarse del `.env`.** La hace el desarrollador a mano: nunca en código. Comprobado en esta limpieza: esa clave no aparece en el repositorio ni en su historial; solo puede estar en el `.env` local. La clave del sistema es otra variable (`NOVACIEL_ANTHROPIC_API_KEY`) y se escribe a mano en `.env`.

## 7. Documentos relacionados

- [README](../README.md) — instalación, ejecución y pruebas.
- [COMO_PROBAR.md](COMO_PROBAR.md) — guía paso a paso para recorrer el flujo con el cliente ficticio.
- [ADR_INDEX.md](ADR_INDEX.md) — decisiones de arquitectura.
- [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) — licencias de terceros.
