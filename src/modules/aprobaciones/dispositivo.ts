// The device an approval was made from (spec 11.3), as a SHORT COARSE LABEL such as "movil · Safari".
// Never the full user agent and never an IP address: the label is all that is stored. At most 40
// characters, the same limit as the database CHECK.

export function etiquetaDispositivo(userAgent: string | undefined): string {
  const ua = (userAgent ?? '').slice(0, 512);
  const clase = /iPad|Tablet/i.test(ua) ? 'tableta' : /Mobi|iPhone|Android/i.test(ua) ? 'movil' : ua === '' ? 'desconocido' : 'escritorio';
  // Order matters: Edge, Opera and Chrome all contain "Safari"; Edge and Opera contain "Chrome".
  const navegador = /Edg(e|A|iOS)?\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Firefox\/|FxiOS\//.test(ua)
        ? 'Firefox'
        : /Chrome\/|CriOS\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'otro';
  return `${clase} · ${navegador}`;
}
