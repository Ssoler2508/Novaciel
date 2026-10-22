import React, { useEffect, useState } from 'react';
import { cancelRender, continueRender, delayRender, staticFile } from 'remotion';

// The bundled font (Inter, assets/fonts) loaded from the bundle itself: the files are copied into the
// bundle's public/fonts when it is built. NOTHING is fetched from the network (no Google Fonts, no @import).
// The render waits (delayRender) until the browser says both weights are ready, so the first frame already
// has the right glyphs.

const CSS = (): string =>
  [400, 700]
    .map(
      (peso) =>
        `@font-face{font-family:"Inter";font-style:normal;font-weight:${peso};font-display:block;` +
        `src:url(${staticFile(`fonts/inter-latin-${peso}-normal.woff2`)}) format("woff2");}`,
    )
    .join('\n');

export const FuentesInter: React.FC = () => {
  const [espera] = useState(() => delayRender('Loading the bundled font'));
  useEffect(() => {
    Promise.all([document.fonts.load('400 40px "Inter"'), document.fonts.load('700 40px "Inter"')])
      .then(() => continueRender(espera))
      .catch(() => cancelRender(new Error('The bundled font could not be loaded')));
  }, [espera]);
  return <style>{CSS()}</style>;
};
