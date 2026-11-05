// Single source of every user-facing string in the web interface (Spanish).
// Screens must read their copy from here (directly or through the helpers in ./estados.js);
// never write literal interface text inside a component.
export const es = {
  app: {
    name: 'NovaCiel',
    tagline: 'Motor de contenido para redes sociales',
  },

  common: {
    loading: 'Cargando…',
    retry: 'Reintentar',
    confirm: 'Confirmar',
    cancel: 'Cancelar',
    save: 'Guardar',
    close: 'Cerrar',
    search: 'Buscar',
    delete: 'Eliminar',
    empty: 'No hay datos para mostrar.',
    backHome: 'Volver al inicio',
    forbidden: 'No tienes permiso para ver esta información.',
    notFound: 'No encontramos esta información.',
    unauthorized: 'Tu sesión expiró. Inicia sesión de nuevo.',
    invalidRequest: 'La solicitud no es válida.',
    loadError: 'No se pudo cargar la información. Inténtalo de nuevo.',
    networkError: 'No se pudo conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.',
    error: 'Ocurrió un error. Inténtalo de nuevo.',
  },

  auth: {
    title: 'Iniciar sesión',
    email: 'Correo electrónico',
    password: 'Contraseña',
    submit: 'Entrar',
    submitting: 'Entrando…',
    logout: 'Cerrar sesión',
    loggingOut: 'Cerrando sesión…',
    invalidCredentials: 'Correo o contraseña incorrectos.',
    forbidden: 'El servidor rechazó la solicitud. Recarga la página e inténtalo de nuevo.',
    networkError: 'No se pudo conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.',
    error: 'No se pudo iniciar sesión. Inténtalo de nuevo.',
  },

  home: {
    title: 'Inicio',
    name: 'Nombre',
    email: 'Correo electrónico',
    roles: 'Roles',
    noRoles: 'Sin roles asignados.',
    noClient: 'Sin cliente',
  },

  aprobaciones: {
    title: 'Aprobaciones pendientes',
    subtitle: 'Revisa lo que espera la decisión del cliente.',
    open: 'Ver aprobaciones pendientes',
    pieces: 'Piezas',
    plans: 'Planes',
    noPieces: 'No hay piezas pendientes de aprobación.',
    noPlans: 'No hay planes pendientes de aprobación.',
    plansReadOnly:
      'Los planes se muestran solo como referencia. La aprobación de planes todavía no está disponible.',
    internalNotice:
      'Esta es la vista de aprobación interna de NovaCiel. Las decisiones del cliente no se registran desde aquí.',
    red: 'Red',
    formato: 'Formato',
    estado: 'Estado',
    fechaHora: 'Fecha y hora',
    version: 'Versión',
    week: 'Semana',
    piecesCount: 'Piezas',
    firstDeadline: 'Primer plazo',
  },

  revision: {
    title: 'Detalle de la pieza',
    backToApprovals: 'Volver a pendientes',
    red: 'Red',
    version: 'Versión',
    state: 'Estado',
    approvalState: 'Estado de aprobación',
    fechaHora: 'Fecha y hora',
    publicationText: 'Texto de publicación',
    hashtags: 'Hashtags',
    altTexts: 'Textos alternativos',
    location: 'Ubicación',
    noLocation: 'Sin ubicación.',
    noHashtags: 'Sin hashtags.',
    noAltTexts: 'Sin textos alternativos.',
    files: 'Archivos',
    noFiles: 'No hay archivos.',
    imageAlt: 'Archivo de la pieza',
    duration: 'Duración',
    fps: 'FPS',
    fileUnavailable: 'Archivo no disponible.',
    history: 'Historial',
    noHistory: 'Sin historial de aprobación.',
    ownDecision: 'Tu decisión',
  },

  aprobacion: {
    estados: {
      pendiente_interno: 'Pendiente de revisión interna',
      pendiente_cliente: 'Pendiente de aprobación del cliente',
      cambios_pedidos: 'Cambios pedidos',
      rechazada: 'Rechazada',
      aprobada: 'Aprobada',
    },
    decisiones: {
      aprobada: 'Aprobada',
      cambios: 'Cambios pedidos',
      rechazada: 'Rechazada',
    },
    motivos: {
      texto: 'Texto',
      musica: 'Música',
      toma: 'Toma',
      gancho: 'Gancho',
      dato_equivocado: 'Dato equivocado',
      otro: 'Otro',
    },
    ronda: 'Ronda',
  },

  controlCalidad: {
    title: 'Control de calidad',
    resultado: 'Resultado',
    version: 'Versión',
    creado: 'Creado',
    resultados: {
      aprobado: 'Aprobado',
      rechazado: 'Rechazado',
    },
  },

  nav: {
    clients: 'Clientes',
    library: 'Biblioteca',
    planner: 'Planificador',
    approvals: 'Aprobaciones',
    results: 'Resultados',
    settings: 'Configuración',
  },

  // Labels for the 16 piece states of spec section 15. The codes are the exact values the backend
  // stores (estado_pieza); they must never be translated or renamed.
  estados: {
    pieza: {
      planeada: 'Planeada',
      plan_aprobado: 'Plan aprobado',
      guion_listo: 'Guion listo',
      en_produccion: 'En producción',
      en_control_calidad: 'En control de calidad',
      revision_novaciel: 'En revisión NovaCiel',
      esperando_aprobacion: 'Esperando aprobación',
      aprobada: 'Aprobada',
      programada: 'Programada',
      publicada: 'Publicada',
      en_medicion: 'En medición',
      cerrada: 'Cerrada',
      con_cambios: 'Con cambios',
      rechazada: 'Rechazada',
      fallo_publicacion: 'Fallo de publicación',
      pausada: 'Pausada',
    },

    // Labels for the four weekly plan states stored in planes_semanales.estado.
    plan: {
      borrador: 'Borrador',
      propuesto: 'Propuesto',
      aprobado: 'Aprobado',
      descartado: 'Descartado',
    },
  },
} as const;

export type Dictionary = typeof es;
