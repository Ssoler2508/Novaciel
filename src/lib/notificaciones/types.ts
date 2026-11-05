// The Notifier port. A message is an id-and-template-name envelope: the provider that delivers it (e-mail,
// SMS, WhatsApp: Step 11 or later) builds the text from the template and the ids. NO client text here:
// never a caption, an idea, a comment or a file name.

export const PLANTILLAS = [
  'recordatorio_24h',
  'recordatorio_4h',
  'turno_suplente',
  'escalada_cambios',
  'aprobador_no_configurado',
  // Persistent alerts (Step 11). The provider builds the text from the template and the alert id.
  'alerta_novaciel',
  'presupuesto_techo_cliente',
  'aprobacion_vencida',
] as const;
export type Plantilla = (typeof PLANTILLAS)[number];

export interface Aviso {
  /** Null only for a global alert (no client). */
  clienteId: string | null;
  destinatarioUsuarioId: string;
  plantilla: Plantilla;
  /** What the message is about. */
  referencia: { tipo: 'pieza' | 'plan' | 'alerta'; id: string };
}

export interface Notifier {
  enviar(aviso: Aviso): Promise<void>;
}
