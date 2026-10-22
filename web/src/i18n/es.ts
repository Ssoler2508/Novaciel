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
