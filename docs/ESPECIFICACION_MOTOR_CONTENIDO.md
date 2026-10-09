# Motor de Contenido NovaCiel — Especificación de diseño

**Versión 1.0 · 5 de octubre de 2026 · Documento para el desarrollador**

Este documento describe qué se va a construir, cómo se divide, qué reglas no se pueden romper y en qué orden se entrega. Los precios y los límites de las plataformas se tomaron de fuentes públicas en octubre de 2026 y cambian seguido: todo lo que dice **VERIFICAR** es una tarea de la Fase 0, antes de escribir código.

---

## 1. Qué es y para qué sirve

Un sistema que, para cada negocio cliente de NovaCiel:

1. **planea** el contenido de la semana,
2. **produce** cada pieza (video corto, carrusel, post, historia),
3. la pasa por **aprobación de una persona**,
4. la **publica** en las redes del cliente,
5. **mide** el resultado y usa lo que aprende para planear la semana siguiente.

El objetivo del negocio no es "publicar seguido". Es traer visitas, mensajes y clientes. Toda decisión del sistema se mide contra eso.

### Lo que el sistema NO es

- No es un generador de videos de IA. La IA es una herramienta entre varias. La mayoría de las piezas se arman con fotos y videos reales del cliente.
- No publica nada sin aprobación humana. Nunca.
- No inventa datos del negocio (precios, promociones, resultados, testimonios).

### Criterios de éxito

| Criterio | Meta |
|---|---|
| Piezas aprobadas sin cambios a la primera | 70% o más al tercer mes de un cliente |
| Tiempo del aprobador por pieza | 3 minutos o menos |
| Costo variable por cliente | Dentro del presupuesto mensual configurado, todos los meses |
| Piezas publicadas sin aprobación registrada | Cero |
| Datos falsos del negocio en una pieza publicada | Cero |
| Alta de un cliente nuevo (del onboarding completo a la primera semana planeada) | 5 días hábiles o menos |

---

## 2. Principios de diseño (obligatorios)

1. **Media real primero.** El orden para conseguir cada toma es: (a) media real del cliente, (b) media real mejorada o animada con IA, (c) generación con IA. Se baja un escalón solo cuando el anterior no alcanza.
2. **La IA nunca falsifica lo que el cliente vende.** No se genera con IA el producto, el plato, el local, el inmueble, el resultado de un servicio ni una persona real. La IA se usa para tomas de ambiente, transiciones, animación de fotos reales, fondos, piezas de marca y contenido educativo.
3. **Nada se publica sin aprobación.** La aprobación queda registrada con quién, cuándo y qué versión.
4. **Presupuesto primero.** Antes de producir la semana, el sistema estima el costo del plan. Si no cabe en el presupuesto, cambia el plan, no el presupuesto.
5. **Todo dato del negocio sale de una lista verificada.** Precios, horarios, promociones y afirmaciones salen del perfil del cliente. Si el dato no está, la pieza no lo menciona.
6. **Cada proveedor detrás de un adaptador.** Modelos de video, de imagen, de voz, de texto y la API de publicación se pueden cambiar sin tocar el resto. Los precios y los modelos viven en configuración, no en código.
7. **Cada cliente aislado.** Un cliente nunca ve media, datos ni resultados de otro.
8. **El sistema se revisa a sí mismo.** Verifica que cada publicación salió, valida cada pieza antes de mostrarla y avisa cuando algo falla. Si falla, se detiene y avisa; no improvisa.
9. **Nace supervisado.** Al inicio, NovaCiel revisa cada pieza antes de que llegue al cliente. Esa revisión se relaja por tipo de pieza, cuando los números lo justifican.

---

## 3. Vista general

```
ONBOARDING ──> PERFIL DE MARCA ──────────────────────────────┐
                                                             │
BIBLIOTECA DE MEDIA (fotos y videos reales del cliente) ──┐  │
                                                          │  │
INTELIGENCIA (resultados propios + nicho + referentes) ─┐ │  │
                                                        v v  v
                                                   PLANIFICADOR
                                                  (plan semanal)
                                                        │
                                       aprobación del plan (cliente)
                                                        │
                                                        v
                                              DIRECTOR CREATIVO
                                     (guion + lista de tomas por pieza)
                                                        │
                                                        v
        CONTROL DE PRESUPUESTO <──────────────>   PRODUCCIÓN
        (autoriza cada gasto)              (tomas, edición, voz, texto)
                                                        │
                                                        v
                                            CONTROL DE CALIDAD AUTOMÁTICO
                                                        │
                                          revisión NovaCiel (al inicio)
                                                        │
                                          APROBACIÓN del encargado del cliente
                                                        │
                                                        v
                                                   PUBLICACIÓN
                                                        │
                                                        v
                                               MEDICIÓN Y APRENDIZAJE ──> vuelve a INTELIGENCIA
```

### El cerebro y las manos

- **El cerebro es Claude.** Todo lo que requiere criterio lo hace Claude: planear, escribir guiones, describir la media, revisar la calidad y analizar resultados.
  - Tareas rutinarias y de alto volumen (describir media, borradores de guion, textos de publicación, verificaciones): **Claude Haiku 4.5**.
  - Tareas de criterio y bajo volumen (plan semanal, gancho de cada pieza, informe de inteligencia): **Claude Sonnet 5.5**. Opus 5.5 solo si el conjunto de evaluación demuestra que mejora el resultado.
  - El identificador del modelo se fija en configuración. Cambiar de modelo exige correr antes el conjunto de evaluación (sección 18).
  - El Perfil de Marca se envía con caché de instrucciones para bajar el costo.
- **Las manos son los modelos de imagen, video y voz.** Para cada toma se usa **el más barato que cumpla** el nivel de calidad exigido, según el selector de la sección 9.3. No hay un modelo de video fijo.

### Arquitectura recomendada

- **Una sola plataforma multi-cliente**, operada por NovaCiel, con aislamiento estricto por cliente (identificador de cliente en cada tabla, en cada ruta de almacenamiento y en cada consulta).
- **Las cuentas de redes son del cliente.** El cliente las conecta con su propio inicio de sesión (OAuth). NovaCiel nunca guarda contraseñas de redes.
- **Servicio propio con cola de trabajos**, no un flujo visual. El sistema tiene estados, presupuesto y reintentos que necesitan pruebas automáticas. Stack sugerido: TypeScript, PostgreSQL, una cola de trabajos sobre la misma base, almacenamiento de objetos compatible con S3 y un trabajador de render con FFmpeg. El desarrollador puede proponer otro stack si cumple los principios de la sección 2.
- **Avisos** (WhatsApp, correo): el desarrollador propone cómo enviarlos. La lógica del sistema no depende de la herramienta de avisos.

**Decisión tomada (D1):** plataforma central multi-cliente. Como todos los clientes comparten la infraestructura, el sistema debe llevar el costo de cada cliente por separado (sección 13.4).

---

## 4. Módulo 0 — Onboarding y Perfil de Marca

El onboarding es la pieza que más pesa en la calidad. Un perfil pobre produce contenido genérico, sin importar el modelo que se use.

### 4.1 Cómo se captura

- **El onboarding lo llena NovaCiel, no el cliente.** Es una herramienta interna: un formulario web por pasos, que guarda el avance y se puede llenar en varios días.
- NovaCiel obtiene las respuestas en una **sesión guiada** de 60 a 90 minutos con el cliente. La sesión se graba y se transcribe; un modelo de lenguaje propone las respuestas y una persona de NovaCiel las confirma.
- El cliente solo hace tres cosas por su cuenta: subir su material, conectar sus redes y confirmar el perfil final.
- **Carga de archivos**: logo, manual de marca, fotos, videos, menús, catálogos, listas de precios.
- **Las plantillas visuales de cada cliente las arma NovaCiel** durante el alta, a partir del bloque F.
- El sistema calcula un **porcentaje de completitud por bloque**. No se planea la primera semana hasta que los bloques marcados como obligatorios estén al 100%.

### 4.2 El cuestionario completo

Marcados con **(O)** los obligatorios para arrancar.

**Bloque A — El negocio**

1. (O) Nombre comercial, razón social y cómo se escribe exactamente la marca.
2. (O) Qué vende, en una frase, como se lo diría a un cliente.
3. (O) Lista de productos o servicios, con precio, y cuáles se pueden mostrar con precio en redes.
4. (O) Los 3 productos o servicios que más ganancia dejan.
5. (O) Los 3 que más quiere vender ahora y por qué.
6. (O) Ubicación, zonas que atiende, horarios, y si atiende por domicilio, en línea o en sede.
7. (O) Por qué canal quiere que le lleguen los clientes: WhatsApp, llamada, reserva en línea, visita, tienda en línea. Enlace o número exacto.
8. Capacidad: cuántos clientes más puede atender por semana sin dañar el servicio.
9. Temporadas altas y bajas, y fechas clave del año para su negocio.
10. Historia del negocio: cómo empezó, quién lo fundó, hitos.
11. Premios, certificaciones, reseñas, cifras que pueda demostrar.

**Bloque B — Objetivos y medición**

12. (O) Objetivo principal de las redes en los próximos 90 días: más mensajes, más reservas, más visitas a la sede, más ventas en línea, más reconocimiento.
13. (O) Cómo sabe hoy cuántos clientes le llegan por redes. Si no lo sabe, cómo se va a medir desde ahora.
14. Cuántos mensajes o reservas recibe por semana hoy.
15. Qué resultado haría que diga "esto valió la pena" en 3 meses.
16. Qué ha intentado antes en redes y qué pasó.

**Bloque C — El cliente ideal**

17. (O) Quién es su mejor cliente: edad, dónde vive, a qué se dedica, cuánto gasta.
18. (O) Qué problema o deseo lo trae.
19. (O) Las 10 preguntas que más le hacen antes de comprar.
20. (O) Las 5 objeciones o miedos más comunes ("es muy caro", "no confío", "queda lejos").
21. Qué palabras exactas usan los clientes para describir lo que buscan.
22. Qué los hace elegirlo a usted y no a otro.
23. Qué los hace volver, y qué los hace no volver.
24. A quién NO quiere atraer.
25. Hay más de un tipo de cliente. Describir cada uno y cuál es prioritario.

**Bloque D — Voz y personalidad**

26. (O) Tres a cinco adjetivos que describen cómo habla la marca.
27. (O) Tres adjetivos que la marca NUNCA es.
28. (O) Trato: tú, usted o vos. Español neutro, colombiano, de otra región, inglés o bilingüe.
29. (O) Palabras y frases propias que sí usa.
30. (O) Palabras prohibidas.
31. (O) Uso de emojis: sí, poco o nunca. Uso de humor: sí o no, y de qué tipo.
32. Tres ejemplos de textos propios que suenan como la marca.
33. Tres a cinco piezas de otras cuentas que le gustan, y qué le gusta exactamente de cada una.
34. Tres piezas que detesta, y por qué.
35. Cómo se despide o cierra un mensaje. Llamado a la acción preferido.

**Bloque E — Lo que quiere transmitir**

36. (O) Si alguien ve tres videos suyos, qué debe pensar del negocio.
37. (O) Los 3 a 5 temas de los que quiere hablar siempre (pilares).
38. Creencias del negocio: en qué cree que la mayoría de su sector hace mal.
39. Valores que deben notarse sin decirlos.
40. Qué emoción debe dejar cada pieza: confianza, antojo, tranquilidad, aspiración, cercanía.

**Bloque F — Identidad visual**

41. (O) Logo en vectores o PNG transparente, en versión clara y oscura.
42. (O) Paleta de colores con códigos (hex). Color principal, secundarios, color de acento.
43. (O) Tipografías, con el archivo o el nombre exacto. Tipografía para títulos y para texto.
44. Manual de marca, si existe.
45. (O) Estilo de imagen: luminoso u oscuro, cálido o frío, limpio o recargado, natural o producido.
46. (O) Estilo de subtítulos y texto en pantalla: se eligen entre 3 o 4 plantillas que el sistema muestra.
47. Elementos gráficos propios: marcos, texturas, iconos, sello.
48. Cosas que no deben verse nunca: marcas de la competencia, zonas del local, uniformes viejos.
49. Estilo de música: se eligen géneros y energía a partir de muestras.
50. Voz en off: sí o no. Si sí, hombre o mujer, edad aparente, acento. Voz de una persona real del negocio, o voz de la biblioteca.

**Bloque G — Personas en cámara**

51. (O) Quién puede aparecer en cámara: dueño, equipo, clientes.
52. (O) Autorización escrita de uso de imagen de cada persona que aparece. Sin autorización, la persona no aparece.
53. (O) Menores de edad: no se usan, salvo autorización escrita de los padres y decisión expresa de NovaCiel.
54. Quién está dispuesto a grabar clips cortos por pedido, y cuántos por semana.
55. Se autoriza clonar la voz de alguien del negocio. Solo con consentimiento escrito de esa persona.

**Bloque H — Media disponible**

56. (O) Carga inicial: mínimo 50 fotos y 20 clips de video reales. El sistema dice qué falta.
57. Dónde está el resto del material: teléfono, Drive, cuentas actuales.
58. Quién va a subir material nuevo cada semana y cuánto.
59. Fotos y videos con derechos de terceros (fotógrafo, agencia): se pueden usar o no.
60. Material de clientes (reseñas en video, fotos etiquetadas): hay permiso para usarlo.

**Bloque I — Oferta, promociones y afirmaciones**

61. (O) Promociones vigentes, con condiciones y fecha de fin.
62. (O) Qué NUNCA se promete (tiempos, resultados, garantías).
63. (O) Afirmaciones que sí se pueden hacer, y cuál es el respaldo de cada una.
64. (O) Restricciones legales del sector: salud, alimentos, alcohol, finanzas, inmuebles, servicios profesionales.
65. Política de precios en redes: se muestran, se muestran "desde", o no se muestran.
66. Garantías, devoluciones, políticas que se pueden mencionar.
67. Testimonios reales disponibles, con permiso.

**Bloque J — Competencia y referentes**

68. (O) Tres a cinco competidores directos, con sus cuentas.
69. (O) Tres a cinco cuentas referentes, del mismo sector o de otro, que quisiera igualar.
70. Qué hace la competencia que funciona y qué hace mal.
71. Temas o formatos que no quiere copiar.

**Bloque K — Redes actuales**

72. (O) Cuentas existentes por plataforma, con usuario exacto.
73. (O) En qué plataformas se va a publicar y cuál es la prioritaria.
74. (O) Tipo de cuenta: empresa o creador. Instagram enlazado a una página de Facebook.
75. Frecuencia actual y qué piezas le han funcionado mejor.
76. Hashtags, etiquetas de ubicación y menciones que usa.
77. Quién responde hoy los comentarios y los mensajes, y en cuánto tiempo.
78. Hace publicidad paga. Con qué presupuesto y quién la maneja.

**Bloque L — Aprobación y operación**

79. (O) Nombre, cargo, WhatsApp y correo de la persona que aprueba.
80. (O) Aprobador suplente.
81. (O) Días y horas en que puede revisar. Compromiso de tiempo de respuesta (se sugiere 24 horas hábiles).
82. (O) Qué pasa si no responde a tiempo. Regla fija del sistema: la pieza NO se publica y se reprograma.
83. (O) Quién aprueba el plan de la semana, si es otra persona.
84. Temas que requieren la aprobación del dueño aunque haya un encargado.
85. Días y horas en que no se debe publicar.
86. Qué hacer ante una crisis o un comentario negativo: a quién se avisa.

**Bloque M — Accesos y cuentas**

87. (O) Conexión de cada red desde el panel, con el inicio de sesión del cliente.
88. (O) Confirmación de que las cuentas están a nombre del dueño del negocio.
89. (O) Segundo administrador nombrado en cada cuenta.
90. (O) Verificación en dos pasos activa.
91. NovaCiel recibe el rol mínimo que permite publicar y leer estadísticas. Nunca el de propietario.

**Bloque N — Calendario del negocio**

92. Fechas propias: aniversario, lanzamientos, eventos, temporadas.
93. Fechas comerciales que sí celebra y las que no.
94. Novedades previstas en los próximos 3 meses.

### 4.3 Lo que sale del onboarding

Un **Perfil de Marca** estructurado y versionado, que todos los agentes leen. Campos mínimos:

- `identidad`: nombre, descripción, historia, diferenciadores.
- `hechos_verificados`: lista de datos que se pueden afirmar (precio, horario, promoción, cifra), cada uno con fecha de vigencia.
- `prohibido`: promesas, temas, palabras y elementos visuales vetados.
- `restricciones_sector`: reglas legales del sector.
- `audiencia`: segmentos, problemas, objeciones, preguntas frecuentes, vocabulario.
- `voz`: adjetivos, trato, idioma, ejemplos buenos y malos.
- `pilares`: temas, con el peso de cada uno.
- `kit_visual`: logo, colores, tipografías, plantilla de subtítulos, estilo de imagen, música, voz.
- `personas`: quién puede aparecer y la referencia a su autorización.
- `objetivo`: objetivo de 90 días, canal de contacto y llamado a la acción.
- `operacion`: aprobadores, ventanas de revisión, plataformas, horarios vetados.
- `plan`: cuotas mensuales por tipo de pieza y presupuesto variable.

Cada cambio del perfil guarda quién lo hizo y cuándo. Un hecho vencido (una promoción que terminó) deja de estar disponible para los agentes de forma automática.

Además, el onboarding produce una **auditoría inicial**: estado de las cuentas, piezas con mejor resultado histórico, y lo mismo para los competidores y referentes del bloque J.

---

## 5. Módulo 1 — Biblioteca de media

**Qué hace:** recibe, ordena y describe todo el material real del cliente, para que los demás módulos lo encuentren.

- **Entrada:** carga desde el panel (teléfono y computador), y una carpeta compartida por cliente. Opcional en fase posterior: envío por WhatsApp.
- **Al recibir cada archivo:**
  - se guarda el original sin modificar;
  - se generan una versión liviana y una miniatura;
  - se extraen los datos técnicos: duración, resolución, orientación, si tiene audio;
  - se transcribe el audio, si hay voz;
  - un modelo con visión lo describe y lo etiqueta: qué se ve, producto o servicio, lugar, personas visibles, calidad (nitidez, luz, estabilidad), momentos útiles con su marca de tiempo;
  - se detectan rostros para exigir la autorización de imagen. Si hay un rostro sin autorización asociada, el archivo queda **bloqueado** hasta que alguien lo resuelva.
- **Calificación de calidad** de 1 a 5. Por debajo de 3 no se usa como toma principal.
- **Control de repetición:** se registra cada uso de cada clip. Un mismo clip no se repite como toma principal en menos de 30 días.
- **Pedidos de material:** cuando el plan necesita una toma que no existe, el sistema crea un pedido concreto para el cliente ("grabe 10 segundos del plato saliendo de la cocina, vertical, con luz de día") con fecha límite. Es la forma más barata de conseguir una toma.

**Decisión de diseño:** para describir video se envían a Claude cuadros muestreados más la transcripción del audio. Así el sistema usa un solo proveedor de lenguaje. Va detrás de un adaptador, por si un modelo que reciba video directamente resulta más barato. **VERIFICAR** el costo por minuto de video recibido.

---

## 6. Módulo 2 — Inteligencia

**Qué hace:** le dice al planificador qué está funcionando, para este cliente y para su nicho.

Tres fuentes:

1. **Resultados propios.** Las estadísticas de cada pieza publicada (sección 12).
2. **Competidores y referentes.** Las cuentas del bloque J más las que NovaCiel agregue por nicho. Se leen datos públicos: piezas recientes, formato, duración, texto, reproducciones, me gusta, comentarios. Fuente: la API oficial de descubrimiento de cuentas de empresa de Instagram (gratuita) y, donde no alcanza, un servicio de extracción de datos públicos con costo por resultado. **VERIFICAR** los términos de uso de cada fuente antes de usarla.
3. **Biblioteca de patrones por nicho.** Lo que NovaCiel aprende en todos los clientes de un mismo nicho (restaurantes, belleza, inmobiliarias, hotelería, salud), guardado como patrones anónimos: tipo de gancho, formato, duración, tema. Nunca se copia media ni texto de un cliente a otro.

**Cómo analiza una pieza ajena que funcionó:** el sistema no copia. Extrae la estructura: gancho de los primeros 3 segundos, formato, ritmo de cortes, duración, tema, llamado a la acción. Y la guarda como un patrón reutilizable.

**Salida:** un **informe semanal por cliente** con:

- los 5 patrones que mejor rinden en su nicho ahora;
- qué atributos de sus propias piezas se asocian con mejor resultado;
- oportunidades: temas con demanda que la cuenta no ha cubierto;
- fechas próximas del calendario del negocio.

**Costo:** el análisis externo corre una vez por semana por nicho, no por cliente, y se comparte entre los clientes de ese nicho.

---

## 7. Módulo 3 — Planificador

**Qué hace:** produce el plan de la semana siguiente.

**Entradas:** Perfil de Marca, informe de inteligencia, inventario de la biblioteca, cuotas del plan, presupuesto disponible del mes, calendario del negocio.

**Reglas:**

1. **Mezcla 70/20/10.** 70% de las piezas en formatos y temas ya probados para ese cliente o su nicho, 20% en variaciones de lo probado, 10% en experimentos. Un cliente nuevo arranca con los patrones del nicho.
2. **Cada pieza tiene un trabajo.** Atraer gente nueva, generar confianza o pedir la acción. El plan equilibra los tres según el objetivo de 90 días.
3. **Cada pieza declara su fuente de tomas** antes de producirse: solo media real, media real con animación de IA, o generación con IA. El plan respeta la cuota de cada tipo.
4. **Estimación de costo.** El planificador calcula el costo de la semana con la tabla de precios vigente. Si supera el presupuesto semanal, sustituye piezas caras por baratas hasta que quepa.
5. **Verifica que el material existe.** Si una pieza depende de un clip que no está en la biblioteca, o crea un pedido de material o cambia la pieza.
6. **No repite.** Revisa los últimos 60 días para no repetir tema y gancho.

**Salida:** un calendario con, por cada pieza: fecha y hora, plataforma, formato, pilar, trabajo de la pieza, idea en una frase, gancho propuesto, fuente de tomas, costo estimado, y por qué se propone.

**Aprobación del plan:** el aprobador recibe el plan y puede aceptar, quitar o cambiar piezas. Sin plan aprobado no se produce nada. Así no se gasta en piezas que el cliente iba a rechazar.

**Modelo:** el plan semanal usa un modelo de lenguaje de gama alta, porque corre una vez por semana por cliente y es la decisión que más pesa.

---

## 8. Módulo 4 — Director creativo

**Qué hace:** convierte cada línea del plan aprobado en un **guion técnico** que producción puede ejecutar sin interpretar.

Contenido del guion técnico:

- **Gancho:** lo que se ve y lo que se lee en los primeros 3 segundos. Sin logo, sin saludo, sin introducción.
- **Estructura:** gancho, desarrollo, cierre con el llamado a la acción.
- **Lista de tomas.** Para cada una: duración, qué se ve, y la fuente exacta:
  - `media_real`: identificador del archivo y marca de tiempo de entrada y salida;
  - `animacion_ia`: identificador de la foto real y descripción del movimiento;
  - `generacion_ia`: descripción de la toma, imágenes de referencia y motivo por el que no se resolvió con media real.
- **Texto en pantalla**, toma por toma.
- **Voz en off**, si aplica.
- **Música:** estilo y energía.
- **Texto de la publicación** por plataforma, con hashtags y ubicación.
- **Portada.**
- **Hechos usados:** lista de los `hechos_verificados` que la pieza menciona. Un dato que no esté en la lista no puede aparecer.

**Duración objetivo:** 15 a 30 segundos por defecto. Más larga solo si el patrón del nicho lo respalda.

**Modelo:** un modelo de lenguaje económico para el borrador, y una pasada de revisión con el modelo de gama alta solo para el gancho.

---

## 9. Módulo 5 — Producción

Es el módulo más caro y el que más se rompe. Se divide en cinco partes.

### 9.1 Resolución de tomas

Para cada toma del guion, en este orden:

1. **Media real.** Corte del clip indicado, estabilización, corrección de color con el estilo del cliente, encuadre vertical.
2. **Animación de una foto real.** Movimiento de cámara sobre la foto, sin IA (paneo, acercamiento, paralaje). Costo cero.
3. **Animación con IA de una foto real.** Imagen a video. Se usa cuando el movimiento simple no alcanza.
4. **Generación con IA.** Siempre en dos pasos, sección 9.2.

### 9.2 Generación con IA en dos pasos

1. **Imagen clave primero.** Se genera la imagen fija de la toma con un modelo de imagen (centavos de dólar). El control de calidad automático la revisa. Solo si pasa, se sigue.
2. **Video después.** Con la imagen aprobada como primer cuadro, se genera el clip.

Esto evita pagar video por una toma cuyo encuadre ya estaba mal. Es la regla de ahorro más importante del sistema.

**Límites por toma:** clips de 5 segundos por defecto. Máximo 2 intentos de video por toma. Al segundo fallo, la toma cae al nivel anterior (animación simple o media real) y se registra el fallo.

### 9.3 Selector de modelos

El sistema no depende de un solo modelo. Mantiene una **tabla de modelos** en configuración:

| Campo | Ejemplo |
|---|---|
| Modelo y proveedor | Kling 3.0 por el proveedor A |
| Tipo | imagen a video |
| Precio | por segundo, por resolución, con o sin audio |
| Duración máxima | 15 s |
| Puntaje por tipo de toma | comida 4, producto 5, personas 3, espacios 4, texto en imagen 2 |
| Tasa de rechazo observada | 18% |
| Estado | activo, en prueba, retirado |

**Regla de selección:** para cada toma, se elige el modelo de **menor costo esperado** entre los que tienen puntaje suficiente para ese tipo de toma. El costo esperado es el precio dividido por la tasa de aprobación observada. Un modelo barato que falla la mitad de las veces no es barato.

**Cómo se llenan los puntajes:** con un banco de pruebas propio. Un conjunto fijo de 20 a 30 tomas representativas por nicho, que se corre contra cada modelo candidato y que una persona de NovaCiel califica. Se repite cuando sale un modelo nuevo o cambia un precio. Después, la tasa de rechazo real de producción actualiza la tabla.

**Proveedores.** Hay agregadores que dan acceso a muchos modelos con una sola cuenta y pago por uso. Los dos candidatos:

- **Higgsfield API:** más de 50 modelos de video e imagen (familias Kling, Seedance, Wan, MiniMax, LTX, entre otras), pago por uso con recarga de saldo, kits para Python y TypeScript, avisos por webhook, y no cobra las solicitudes fallidas. Su catálogo publicado no muestra los modelos Veo. No ofrece un selector automático de modelo: el selector es lógica nuestra.
- **fal.ai:** catálogo más amplio, incluye Veo.

Se construye un adaptador común y se conectan los dos. El selector elige por precio y puntaje, sin importar de qué proveedor viene el modelo.

**Precios de referencia, octubre de 2026 (VERIFICAR todos; las fuentes no coinciden entre sí):**

| Modelo | Precio aproximado | Nota |
|---|---|---|
| Kling 3.0 | USD 0,084 a 0,112 por segundo sin audio | Buen movimiento a partir de una foto |
| Kling 2.5 / 2.6 | USD 0,042 a 0,07 por segundo | Opción económica |
| Seedance 2.5 | USD 0,07 a 0,23 por segundo según la fuente | Consistencia con imágenes de referencia |
| Wan 3.0 | USD 0,083 a 0,20 por segundo | Clips largos |
| Veo 3.1 Lite / Fast / Standard | USD 0,05 / 0,10 a 0,15 / 0,40 por segundo | Audio nativo |
| Imagen (Nano Banana 2, Seedream 5.0) | USD 0,035 a 0,04 por imagen | Admiten imágenes de referencia |
| Imagen de gama alta (Nano Banana Pro) | USD 0,08 por imagen | Solo para portadas y tomas clave |
| Voz (ElevenLabs) | USD 0,05 a 0,10 por 1.000 caracteres | Español disponible |

La API de video Sora 2 fue retirada el 24 de septiembre de 2026 según la fuente consultada. No se incluye.

### 9.4 Edición y render

- **Motor:** FFmpeg para cortes, color, audio y exportación. Para texto animado, subtítulos y plantillas de marca, un motor de composición por código (Remotion es el candidato) que corre en el servidor propio. **VERIFICAR** la licencia de Remotion: es gratuita para empresas de hasta 3 personas; por encima tiene un cobro por render con mínimo mensual.
- **Plantillas por cliente.** El kit visual del onboarding se convierte en 3 o 4 plantillas: estilo de subtítulos, títulos, cierre, portada. Las plantillas las arma NovaCiel durante el alta del cliente. Aquí se decide que el contenido no se vea genérico: tipografía, color y ritmo propios en cada pieza.
- **Subtítulos:** transcripción con marcas de tiempo por palabra, corrección ortográfica, y resaltado según la plantilla. Siempre activos, porque la mayoría de la gente ve sin sonido.
- **Zonas seguras:** ningún texto en las franjas que tapan los botones de cada plataforma.
- **Ritmo:** corte o cambio visual cada 2 a 4 segundos, ajustable por plantilla.
- **Salida:** vertical 1080 × 1920, MP4 H.264, audio AAC, más las variantes que pida cada plataforma. Portada aparte.

### 9.5 Audio

- **Voz en off:** síntesis con la voz definida en el onboarding, o audio real del cliente.
- **Música: se arranca solo con fuentes gratuitas.** No se contrata una biblioteca paga hasta demostrar que las gratuitas no alcanzan.
  - Fuentes candidatas: la colección de sonidos de Meta (gratuita, con licencia para Instagram y Facebook), la biblioteca comercial de TikTok (gratuita, con licencia para TikTok), bibliotecas de uso libre con permiso comercial, música generada con IA, y audio original del cliente.
  - **Una licencia gratuita casi siempre vale para una sola plataforma.** Una pista de la colección de Meta no se puede publicar en TikTok. Por eso el sistema mantiene un **catálogo de música** donde cada pista registra su fuente, su licencia y las plataformas donde se puede usar. Producción solo elige pistas válidas para la plataforma de destino, y el control de calidad lo verifica.
  - **VERIFICAR** en la Fase 0, leyendo los términos de cada fuente: si las pistas se pueden descargar e incrustar en un video publicado por API, si exigen dar crédito, y si la música generada con IA incluye derechos comerciales en el plan que se use.
  - **La música va incrustada en el archivo.**
- **Límite de plataforma:** las API de publicación no permiten usar los audios en tendencia de Instagram ni de TikTok. Además, las cuentas de empresa no pueden usar el catálogo musical general. Para las piezas donde un audio en tendencia importa, existe el **modo de publicación manual** (sección 11).

### 9.6 Otros formatos

- **Carrusel:** 5 a 10 láminas armadas con la plantilla del cliente, fotos reales y texto. Es el formato más barato y debe usarse.
- **Post de imagen** e **historia:** misma lógica.

---

## 10. Módulo 6 — Control de calidad automático

Ninguna pieza llega a un humano sin pasar esta revisión. Cada verificación da pasa, no pasa o advertencia, con el motivo.

**Técnicas**

- Resolución, duración, formato y peso dentro de lo que acepta cada plataforma.
- Audio presente y con volumen normalizado.
- Texto dentro de las zonas seguras.
- Sin cuadros negros ni congelados.

**De marca**

- Colores y tipografías corresponden al kit del cliente.
- Logo correcto y sin deformar.
- Ortografía de todo el texto en pantalla y de la publicación.
- Tono acorde a la voz del perfil. No contiene palabras prohibidas.

**De veracidad**

- Todo precio, horario, promoción o cifra coincide con un hecho verificado y vigente.
- No hay promesas de la lista de prohibidos.
- Cumple las restricciones del sector.

**De las tomas con IA**

- Sin defectos visibles: manos, rostros, texto deformado, objetos que se derriten.
- Ningún producto, plato, local o persona real fue generado con IA.
- Si la toma muestra una escena realista generada o alterada con IA, la pieza queda marcada para llevar la etiqueta de contenido con IA al publicarse.

**De derechos**

- Toda persona visible tiene autorización vigente.
- La música tiene licencia registrada.

Si una verificación de veracidad, de derechos o del uso prohibido de IA no pasa, la pieza **se bloquea** y vuelve a producción. No se le muestra al cliente.

**Implementación:** las técnicas, con código. Las demás, con un modelo con visión que revisa cuadros muestreados y el texto, contra el Perfil de Marca. El revisor es un agente distinto del que creó la pieza.

---

## 11. Módulos 7 y 8 — Aprobación y publicación

### 11.1 Los dos niveles de revisión

1. **Revisión de NovaCiel.** Obligatoria en todas las piezas durante las primeras 4 semanas de cada cliente. Después se retira por tipo de pieza, cuando ese tipo lleva 20 piezas seguidas aprobadas sin cambios.
2. **Aprobación del encargado del cliente.** Obligatoria siempre, sin excepción y sin fecha de retiro.

### 11.2 La experiencia del aprobador

- Recibe un aviso por WhatsApp o correo con un enlace. El enlace abre el panel en el teléfono, sin instalar nada.
- Ve la pieza tal como se verá publicada, con el texto, la fecha y la plataforma.
- Tiene tres botones: **Aprobar**, **Pedir cambio**, **Rechazar**.
- "Pedir cambio" ofrece motivos de un toque (el texto, la música, una toma, el gancho, un dato equivocado) y un campo libre. Puede señalar el segundo exacto del video.
- "Rechazar" pide el motivo. El motivo alimenta el aprendizaje.
- Puede aprobar varias piezas de una vez.
- Meta: 3 minutos o menos por pieza.

### 11.3 Reglas

- **Sin aprobación no se publica.** Si llega la hora programada sin aprobación, la pieza se reprograma y se avisa a NovaCiel.
- Recordatorios a las 24 y a las 4 horas antes de la hora programada. Después, aviso al aprobador suplente.
- Máximo 2 rondas de cambios por pieza. A la tercera, la pieza pasa a una persona de NovaCiel.
- Cualquier cambio después de la aprobación la anula y la pieza se aprueba de nuevo.
- Cada aprobación guarda: quién, cuándo, desde qué dispositivo y la huella del archivo exacto aprobado. Lo que se publica es ese archivo.

### 11.4 Publicación

- **Vía recomendada para arrancar:** un servicio intermediario de publicación, detrás de un adaptador. Motivo: publicar directo en TikTok exige que la aplicación pase una auditoría de TikTok; sin ella, todo lo publicado queda en privado y limitado a 5 usuarios por día. Los intermediarios ya tienen sus aplicaciones aprobadas en cada red. Candidatos y precio de entrada publicado: Upload-Post (USD 24 al mes), Zernio (USD 6 por cuenta al mes), Ayrshare (USD 149 al mes), Postiz (código abierto, instalable en servidor propio, pero exige registrar aplicaciones propias en cada red). **VERIFICAR** en la Fase 0: límite de perfiles por plan, conexión de cuentas con marca propia, y datos de estadísticas que devuelve.
- **Segunda etapa:** conexión directa con Meta (Instagram y Facebook) si el costo del intermediario lo justifica.
- **Plataformas:** Instagram (Reels, carrusel, historia) y Facebook primero. TikTok y YouTube Shorts después.
- **Límites conocidos de Instagram por API:** solo cuentas de empresa o creador enlazadas a una página de Facebook; máximo 100 publicaciones por API cada 24 horas por cuenta; Reels de hasta 90 segundos. **VERIFICAR** contra la documentación oficial.
- **Etiqueta de contenido con IA:** las piezas marcadas por el control de calidad se publican con la etiqueta de IA de cada plataforma. Meta exige declarar el video realista creado o alterado con IA, y TikTok lo detecta y lo etiqueta por su cuenta si no se declara. **VERIFICAR** si cada API permite activar la etiqueta; si no, esas piezas van por publicación manual.
- **Verificación posterior:** tras publicar, el sistema confirma que la pieza está visible y guarda el enlace. Si falla, reintenta 2 veces con espera y luego avisa. Nunca publica dos veces la misma pieza: cada publicación lleva una clave única.

### 11.5 Modo de publicación manual

Para las piezas que necesitan audio en tendencia, una etiqueta que la API no permite o una función que solo existe en la aplicación: el sistema le envía al encargado el archivo final, el texto listo para copiar, la sugerencia de audio y la hora. El encargado publica y pega el enlace en el panel. La pieza entra a medición igual que las demás.

---

## 12. Módulo 9 — Medición y aprendizaje

### 12.1 Qué se mide

Por pieza, a las 24 horas, a los 3 días, a los 7 días y a los 28 días:

- alcance y reproducciones;
- tiempo promedio de reproducción y porcentaje de retención;
- compartidos y envíos por mensaje;
- guardados, comentarios, me gusta;
- visitas al perfil, toques en el enlace o en el botón de contacto;
- seguidores ganados.

**Límite conocido:** una de las fuentes indica que las estadísticas de Reels por API solo están disponibles para cuentas de 1.000 seguidores o más. **VERIFICAR.** Si se confirma, para cuentas más pequeñas el encargado sube una captura de las estadísticas y el sistema la lee.

### 12.2 El resultado de negocio

Reproducciones no son clientes. Para conectar contenido con resultado:

- cada plataforma usa un enlace con seguimiento propio;
- si el cliente tiene el agente de WhatsApp de NovaCiel, se registra el origen de cada conversación;
- si no, el encargado reporta cada semana cuántos mensajes o reservas llegaron por redes.

### 12.3 Cómo aprende

Cada pieza se guarda con sus **atributos**: pilar, trabajo de la pieza, formato, tipo de gancho, duración, fuente de tomas, modelo usado, plantilla, día y hora, si lleva voz, si aparece una persona.

Cada semana el sistema calcula, por cliente y por nicho, qué atributos se asocian con mejor resultado. La métrica principal son los **envíos y compartidos por alcance** y la **retención**, que son las señales que más pesan en la distribución a gente nueva. Me gusta y seguidores son secundarios.

Con muestras pequeñas no se concluye nada: un atributo necesita un mínimo de 8 piezas antes de influir en el plan.

También aprende de las personas:

- cada motivo de cambio o de rechazo se convierte en una regla candidata del Perfil de Marca ("no usar música electrónica"). NovaCiel la confirma antes de que quede fija;
- la tasa de rechazo por modelo actualiza la tabla del selector.

### 12.4 Reporte mensual al cliente

Una página: qué se publicó, qué funcionó y por qué, cuántos mensajes o reservas trajo, qué se cambia el mes siguiente, y el uso del plan frente a las cuotas.

---

## 13. Módulo 10 — Control de presupuesto

El costo variable por cliente tiene un techo mensual que NovaCiel configura según lo cotizado. El sistema no lo puede superar.

### 13.1 Cómo funciona

- **Libro de gastos.** Cada llamada con costo (modelo de texto, imagen, video, voz, extracción de datos, publicación) se registra con cliente, pieza, toma, proveedor y valor.
- **Autorización previa.** Antes de cada llamada cara, producción le pide permiso al control de presupuesto, que reserva el monto. Si no hay saldo, la llamada no sale.
- **Tres niveles de tope:** mensual por cliente, por pieza según su tipo, y por toma (máximo 2 intentos de video).
- **Aviso al 80%** del tope mensual, a NovaCiel.
- **Al llegar al tope, el sistema se degrada, no se apaga:**
  1. se detiene la generación de video con IA;
  2. las piezas pendientes se rehacen solo con media real y animación simple;
  3. si tampoco alcanza, se pasa a carruseles y posts;
  4. se avisa a NovaCiel y al cliente.
- **Interruptor general** por cliente y por todo el sistema, para detener producción y publicación de inmediato sin tocar código.
- **Saldo de los proveedores prepagados:** alerta cuando queden menos de 2 semanas de consumo.

### 13.2 Costo objetivo por unidad

Techos de diseño. Si una pieza va a superarlos, se replantea.

| Unidad | Composición | Techo (USD) |
|---|---|---|
| Video con media real, sin IA | guion y selección de clips, voz, render | 0,15 |
| Video con media real y 1 toma animada con IA | más 5 s de video, hasta 2 intentos | 1,00 |
| Video con media real y hasta 3 tomas con IA | | 2,60 |
| Video desde cero de 30 s | guion, 12 imágenes clave, 6 tomas de 5 s, voz | 9,00 |
| Carrusel o post | mezcla de fotos reales e imágenes | 0,20 |
| Plan semanal e informe de inteligencia | por cliente, por semana | 2,50 |
| Descripción de media nueva | por minuto de video recibido | VERIFICAR |

**Plan de referencia para dimensionar** (los planes reales los configura NovaCiel por cliente): 20 videos con media real, 4 videos desde cero, 12 carruseles o posts al mes. Costo variable esperado: cerca de USD 70 a 90 al mes, antes del colchón de 25% para reintentos y alzas de precio.

### 13.3 Las palancas de ahorro, en orden de impacto

1. Media real primero. Un video con media real cuesta 60 veces menos que uno desde cero.
2. Imagen clave antes del video.
3. Aprobar el plan antes de producir.
4. Clips de 5 segundos y máximo 2 intentos.
5. Modelo de menor costo esperado por tipo de toma, no el más famoso.
6. Pedirle al cliente la toma que falta, antes de generarla.
7. Modelo de lenguaje económico para lo rutinario, el de gama alta solo para el plan semanal y el gancho.
8. Caché del Perfil de Marca en las llamadas al modelo de lenguaje.
9. Análisis de nicho compartido entre los clientes del mismo nicho.
10. Producir en 720p cuando el modelo cobra por resolución y escalar al final, si la calidad lo resiste. **VERIFICAR** con el banco de pruebas.

### 13.4 Costo por cliente

Cada gasto se atribuye a un cliente. No hay gasto sin dueño.

- **Costos directos:** toda llamada del libro de gastos lleva el cliente, la pieza y la toma.
- **Costos compartidos** (servidor, almacenamiento, intermediario de publicación, biblioteca de música, análisis de nicho): se reparten cada mes entre los clientes activos con una regla configurable. Por defecto: almacenamiento según el espacio que usa cada cliente, intermediario según sus cuentas conectadas, análisis de nicho por partes iguales entre los clientes de ese nicho, y el resto por partes iguales.
- **Vista de costos en el panel de NovaCiel**, por cliente y por mes:
  - costo total, directo y compartido;
  - costo por tipo de pieza y costo promedio por pieza publicada;
  - costo por proveedor y por modelo;
  - gasto en intentos fallidos y en piezas rechazadas;
  - uso frente al tope y frente a las cuotas del plan;
  - comparación con los meses anteriores.
- **Exportación** a hoja de cálculo, por cliente y por mes.
- **Cierre mensual:** el día 1 se congela el mes anterior. Un mes cerrado no se modifica.

---

## 14. Panel de administración

**Vistas de NovaCiel**

- Lista de clientes con estado: en onboarding, activo, en pausa.
- Por cliente: Perfil de Marca, biblioteca, plan, piezas por estado, gasto frente al tope, resultados.
- Cola de revisión de NovaCiel.
- Tabla de modelos y precios, con el banco de pruebas.
- Alertas: fallos de publicación, topes, cuentas desconectadas, aprobaciones vencidas.
- Interruptores.

**Vistas del cliente**

- Subir material y ver pedidos de material pendientes.
- Aprobar el plan y las piezas.
- Calendario de lo publicado y lo programado.
- Resultados y reporte mensual.
- Editar los datos del negocio que cambian: promociones, horarios, precios. Un cambio aquí actualiza los hechos verificados.

### Roles

| Rol | Puede |
|---|---|
| Administrador NovaCiel | Todo, incluidos precios, topes e interruptores |
| Operador NovaCiel | Revisar piezas, editar perfiles, ver gasto. No cambia topes |
| Dueño del cliente | Todo lo de su negocio, nombrar aprobadores |
| Aprobador del cliente | Aprobar plan y piezas, subir material |
| Colaborador del cliente | Solo subir material |

Los permisos se asignan por rol, nunca persona por persona. Cada rol se prueba con una cuenta de ese rol.

---

## 15. Modelo de datos (tablas principales)

Todas llevan `cliente_id`, excepto las de configuración global.

- `clientes`, `usuarios`, `roles`
- `perfil_marca` (versionado), `hechos_verificados`, `reglas_prohibidas`
- `autorizaciones_imagen` (persona, documento, vigencia)
- `media` (archivo, datos técnicos, descripción, etiquetas, calidad, estado, autorizaciones asociadas), `media_usos`
- `pedidos_material`
- `nichos`, `patrones_nicho`, `cuentas_referentes`, `piezas_referentes`
- `planes_semanales`, `piezas` (con sus atributos), `guiones`, `tomas`
- `generaciones` (toma, modelo, proveedor, intento, costo, resultado)
- `revisiones_calidad`
- `aprobaciones` (quién, cuándo, huella del archivo, decisión, motivo)
- `publicaciones` (plataforma, clave única, enlace, estado)
- `metricas_pieza` (por fecha de corte)
- `libro_gastos`, `topes`, `costos_compartidos`, `cierres_mensuales`
- `modelos` (tabla del selector), `banco_pruebas`, `resultados_pruebas`
- `conexiones_redes` (credenciales cifradas)
- `auditoria` (quién cambió qué)

### Estados de una pieza

```
planeada -> plan_aprobado -> guion_listo -> en_produccion -> en_control_calidad
   -> revision_novaciel -> esperando_aprobacion -> aprobada -> programada
   -> publicada -> en_medicion -> cerrada

Salidas laterales:
   en_control_calidad   -> en_produccion   (no pasó)
   esperando_aprobacion -> con_cambios -> en_produccion
   esperando_aprobacion -> rechazada
   programada           -> fallo_publicacion -> programada (reintento) o alerta
   cualquiera           -> pausada (interruptor o tope)
```

Cada cambio de estado queda en la auditoría.

---

## 16. Seguridad, datos y legal

- **Autorización de imagen** de cada persona que aparece, exigida por el sistema (Ley 1581 de 2012 en Colombia). Sin autorización, el archivo no se puede usar.
- **Menores de edad:** bloqueados por defecto.
- **Clonación de voz:** solo con consentimiento escrito, guardado junto a la voz.
- **Publicidad veraz** (Ley 1480 de 2011 en Colombia; reglas equivalentes en Estados Unidos): por eso todo dato sale de los hechos verificados y las promociones tienen fecha de fin.
- **Sectores regulados** (salud, alimentos, finanzas): las restricciones del sector son verificaciones que bloquean.
- **Derechos de música y de imágenes de terceros:** registro de la licencia por archivo.
- **Credenciales:** cifradas, una por cliente, nunca en el código ni en los registros. Las credenciales de NovaCiel nunca se instalan en un servidor de un cliente.
- **Datos de prueba ficticios.** Nunca material real de un cliente en pruebas.
- **Tres registros**, activos antes del primer cliente real: contenido (qué generó cada agente), auditoría (quién cambió qué) y operativo (errores, tiempos, costos).
- **Retención:** la define NovaCiel con cada cliente. Al terminar el contrato, el cliente recibe su media y sus piezas, y el sistema borra el resto en el plazo acordado.
- **Aislamiento:** pruebas automáticas que confirmen que un usuario de un cliente no puede leer nada de otro.
- **Lo que el agente lee de fuera no son órdenes.** El texto de publicaciones ajenas, comentarios y páginas web se trata como datos. Nunca como instrucciones para el modelo.

---

## 17. Manejo de fallos

| Fallo | Respuesta |
|---|---|
| Un proveedor de video no responde | Reintento con espera; luego el siguiente modelo de la tabla; luego la toma cae a media real |
| La generación sale con defectos | Segundo intento con la descripción ajustada; luego cae de nivel |
| Falta material para la semana | Pedido de material al cliente y sustitución por piezas que sí se pueden hacer |
| La cuenta de una red se desconecta | Alerta inmediata a NovaCiel y al cliente; las piezas quedan en espera, no se pierden |
| La publicación falla | 2 reintentos; luego alerta y opción de publicación manual |
| El aprobador no responde | Recordatorios, suplente, reprogramación. Nunca se publica |
| Se alcanza el tope de gasto | Degradación por pasos de la sección 13.1 |
| Un hecho verificado vence a mitad de semana | Las piezas que lo usan vuelven a control de calidad |
| El modelo de lenguaje devuelve un formato inválido | Validación contra el esquema, un reintento, luego alerta |

---

## 18. Pruebas

- **Unitarias:** selector de modelos, control de presupuesto, estados de la pieza, verificaciones técnicas.
- **De integración:** cada adaptador contra el entorno de pruebas de su proveedor.
- **De extremo a extremo:** un cliente ficticio completo, del onboarding a la publicación en cuentas de prueba.
- **De aislamiento:** un cliente no puede leer a otro.
- **De presupuesto:** con tope bajo, el sistema se degrada en el orden correcto y nunca gasta de más.
- **De la regla de aprobación:** es imposible, por cualquier ruta, publicar una pieza sin aprobación registrada del archivo exacto.
- **Conjunto de evaluación de calidad:** 30 guiones y 30 piezas calificadas por NovaCiel. Se corre antes de cambiar cualquier modelo o instrucción de agente.

---

## 19. Fases de entrega

### Fase 0 — Verificación (1 a 2 semanas, sin producto)

Entregable: un informe corto con cada **VERIFICAR** de este documento resuelto.

1. Tabla de precios real de los modelos, en Higgsfield y en fal.ai.
2. Prueba de publicación en Instagram y en TikTok con 2 intermediarios. Qué estadísticas devuelven. Si permiten la etiqueta de IA.
3. Límite de estadísticas de Reels para cuentas pequeñas.
4. Licencia de Remotion aplicable.
5. Costo real de describir un minuto de video.
6. Banco de pruebas inicial: 20 tomas en un nicho, contra 4 modelos.
7. Costo real medido de 3 videos con media real y 1 desde cero, contra los techos de la sección 13.2.
8. Términos de uso de cada fuente gratuita de música, y en qué plataformas vale cada una.

### Fase 1 — Núcleo con media real (un cliente piloto)

- Onboarding completo y Perfil de Marca.
- Biblioteca de media con descripción automática y autorizaciones.
- Planificador con aprobación del plan.
- Director creativo.
- Producción solo con media real y animación simple. Plantillas, subtítulos, voz, música.
- Control de calidad automático.
- Aprobación en dos niveles.
- Publicación en Instagram y Facebook, más el modo manual.
- Control de presupuesto y libro de gastos.
- Panel básico.

**Criterio de aceptación:** un cliente piloto publica 4 semanas seguidas, con cero piezas sin aprobación, cero datos falsos, y costo dentro del techo.

### Fase 2 — IA generativa y aprendizaje

- Generación en dos pasos y selector de modelos, con los dos proveedores.
- Medición automática y cálculo de atributos.
- Inteligencia de nicho y referentes.
- TikTok y YouTube Shorts.
- Mezcla 70/20/10 basada en datos.

**Criterio de aceptación:** 3 clientes activos; el selector elige modelo por costo esperado; el plan cita resultados reales para justificar cada pieza.

### Fase 3 — Escala

- Alta de un cliente en 5 días hábiles.
- Reporte mensual automático.
- Biblioteca de patrones por nicho.
- Retiro gradual de la revisión de NovaCiel por tipo de pieza.
- Envío de material por WhatsApp.

---

## 20. Decisiones de NovaCiel

| # | Decisión | Recomendación |
|---|---|---|
| D1 | Plataforma central multi-cliente o instalación por cliente | **Decidido: central**, con costo por cliente (sección 13.4) |
| D2 | Intermediario de publicación | **El desarrollador investiga y prueba** en la Fase 0 y presenta la comparación; NovaCiel elige |
| D3 | Modelos | **Decidido:** Claude como cerebro; para imagen, video y voz, el más barato que cumpla, por el selector. El desarrollador presenta la tabla de precios real en la Fase 0 |
| D4 | Música | **Decidido:** solo fuentes gratuitas al inicio, con catálogo de licencias por plataforma. Una biblioteca paga solo si se demuestra que hace falta |
| D5 | Cliente piloto | **Decidido:** se construye y se prueba todo el sistema con un cliente ficticio. El piloto real se elige después, entre tres clientes candidatos de NovaCiel |
| D6 | Onboarding y plantillas visuales | **Decidido:** los llena y las arma NovaCiel |
| D7 | Retención de media al terminar un contrato | **Decidido:** se acuerda con cada cliente; el plazo es un campo configurable por cliente |

---

## Fuentes consultadas (octubre de 2026)

- Higgsfield API: https://higgsfield.ai/blog/higgsfield-api
- Ranking y precios de modelos de video: https://www.teamday.ai/blog/best-ai-video-models-2026
- Comparación de precios de video: https://devtk.ai/en/blog/ai-video-generation-pricing-2026/
- fal.ai, Kling imagen a video: https://fal.ai/models/fal-ai/kling-video/o3/standard/image-to-video
- Comparación de API de publicación: https://www.upload-post.com/best-social-media-apis/
- Publicación de Reels por API: https://postproxy.dev/blog/instagram-reels-api-publishing-guide/
- Referencia oficial de Instagram: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media/
- API de publicación de TikTok y auditoría: https://www.postzen.dev/blog/tiktok-api
- Etiquetas de contenido con IA: https://www.auditsocials.com/blog/cross-platform-ai-content-labeling-requirements-2026-meta-google-tiktok-youtube-comparison
- Música en cuentas de empresa: https://www.foximusic.com/blog/instagram-reels-music-copyright-legal-guide/
- Señales de distribución de Instagram: https://www.dataslayer.ai/blog/instagram-algorithm-2025-complete-guide-for-marketers
- Retención en TikTok: https://www.socialync.io/blog/tiktok-viral-retention-rate-2026
- Cuestionarios de onboarding de agencias: https://skedsocial.com/blog/social-media-client-onboarding-process-checklist-questionnaire y https://www.sendible.com/insights/social-media-questionnaire
- Motores de edición por código: https://www.wireflow.ai/blog/best-remotion-alternatives-in-2026
- Precios de ElevenLabs: https://elevenlabs.io/pricing/api
- Precios de modelos de imagen: https://www.teamday.ai/blog/ai-api-pricing-comparison-2026
