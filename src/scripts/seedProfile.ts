import {
  isFilled,
  PERFIL_JSON_BLOCKS,
  readPath,
  REQUIRED_FIELDS,
  type PerfilJsonBlock,
} from '../modules/perfilMarca/completeness.js';

// Fictional brand profile content for the seed's client. Covers every required field.
export const SEED_IDIOMA = 'es';

export const SEED_PROFILE: Record<PerfilJsonBlock, Record<string, unknown>> = {
  identidad: {
    nombre_comercial: 'Cafetería Aurora',
    razon_social: 'Cafetería Aurora Ficticia SAS',
    escritura_marca: 'Cafetería Aurora',
    descripcion: 'Café de especialidad colombiano y repostería artesanal, servido en un local acogedor.',
    productos: [
      { nombre: 'Café americano', mostrar_precio: true },
      { nombre: 'Capuchino', mostrar_precio: true },
      { nombre: 'Torta de zanahoria', mostrar_precio: false },
    ],
    productos_rentables: ['Capuchino', 'Torta de zanahoria', 'Granos tostados para llevar'],
    productos_a_impulsar: [
      { nombre: 'Capuchino', razon: 'Mayor margen y se vende bien con la promoción de los martes.' },
      { nombre: 'Granos tostados para llevar', razon: 'Fideliza clientes y no depende del local.' },
      { nombre: 'Torta de zanahoria', razon: 'Producto estrella en fotos.' },
    ],
    ubicacion: 'Calle 10 # 5-20, Medellín (dirección ficticia)',
    zonas: ['El Poblado', 'Laureles'],
    modalidades_atencion: ['sede', 'domicilio'],
  },
  restricciones_sector: {
    sector: 'alimentos',
    tiene_restricciones: true,
    restricciones: ['No afirmar propiedades medicinales del café.', 'Informar alérgenos cuando se mencionen postres.'],
  },
  audiencia: {
    segmentos: [{ descripcion: 'Profesionales de 25 a 40 años que trabajan cerca y buscan un café de calidad.' }],
    problemas: ['No encuentran un lugar tranquilo con buen café para trabajar o reunirse.'],
    preguntas_frecuentes: ['¿Tienen WiFi?', '¿Abren los domingos?', '¿Hacen domicilios?'],
    objeciones: ['Es más caro que una cadena', 'Queda lejos de mi oficina'],
  },
  voz: {
    adjetivos: ['cercana', 'cálida', 'curiosa'],
    adjetivos_nunca: ['arrogante', 'fría', 'agresiva'],
    trato: 'tú',
    frases_propias: ['¡Pásate por tu café de hoy!', 'Hecho con calma.'],
    emojis: 'poco',
    usa_humor: true,
  },
  pilares: {
    temas: [
      { nombre: 'Origen del café', peso: 40 },
      { nombre: 'Repostería artesanal', peso: 30 },
      { nombre: 'Vida del barrio', peso: 30 },
    ],
    percepcion_deseada: 'Un lugar de barrio donde el café se prepara con cuidado y todos se sienten bienvenidos.',
  },
  kit_visual: {
    aparecen_personas: true,
    logo_claro: 'marca/seed-logo-claro.png',
    logo_oscuro: 'marca/seed-logo-oscuro.png',
    colores: { principal: '#6F4E37', secundarios: ['#F5E6D3', '#2B2B2B'], acento: '#E07A1F' },
    tipografia_titulos: 'Playfair Display',
    tipografia_texto: 'Inter',
    estilo_imagen: { luminosidad: 'luminoso', temperatura: 'cálido', limpieza: 'limpio', produccion: 'natural' },
    plantilla_subtitulos: 'plantilla-2',
  },
  objetivo: {
    objetivo_90_dias: 'mas_visitas_a_la_sede',
    medicion_actual: 'Se le pregunta a cada cliente nuevo cómo nos conoció y se anota en una libreta.',
    canal_contacto: 'whatsapp',
    contacto_destino: 'https://wa.me/570000000000',
  },
  operacion: {
    aprobador: {
      nombre: 'Dueña Aurora Ficticia',
      cargo: 'Dueña',
      whatsapp: '+570000000000',
      correo: 'dueno.aurora@example.test',
    },
    aprobador_suplente: { nombre: 'Gerente Ficticio', correo: 'gerente.aurora@example.test' },
    dias_revision: ['lunes', 'miércoles', 'viernes'],
    horas_revision: '09:00-12:00',
    tiempo_respuesta_horas: 24,
    plan_aprobado_por: 'Dueña Aurora Ficticia',
    plataformas: [{ plataforma: 'instagram', usuario: 'cafeteria.aurora.ficticia' }],
    plataforma_prioritaria: 'instagram',
    tipo_cuenta: 'empresa',
    zona_horaria: 'America/New_York',
  },
  plan: {},
};

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let current = target;
  for (const key of keys.slice(0, -1)) {
    const next = current[key];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) current[key] = {};
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]!] = value;
}

/**
 * Fills only the required fields that are missing in `existing`, with the seed's values; everything
 * already filled (possibly edited by hand) is kept. Returns the blocks that changed, or {} if none.
 */
export function fillMissingProfileBlocks(
  existing: Partial<Record<PerfilJsonBlock, Record<string, unknown>>>,
): Partial<Record<PerfilJsonBlock, Record<string, unknown>>> {
  const changed: Partial<Record<PerfilJsonBlock, Record<string, unknown>>> = {};
  for (const block of PERFIL_JSON_BLOCKS) {
    const current = structuredClone(existing[block] ?? {});
    let touched = false;
    for (const requirement of REQUIRED_FIELDS[block]) {
      // Conditional requirements follow the profile as it is (including blocks already filled here).
      const profileNow = { ...existing, ...changed, [block]: current };
      if (requirement.when && readPath(profileNow, requirement.when.path) !== requirement.when.equals) continue;
      if (isFilled(readPath(current, requirement.path), requirement)) continue;
      setPath(current, requirement.path, structuredClone(readPath(SEED_PROFILE[block], requirement.path)));
      touched = true;
    }
    if (touched) changed[block] = current;
  }
  return changed;
}
