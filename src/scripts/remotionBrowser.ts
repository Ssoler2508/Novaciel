import { ensureBrowser } from '@remotion/renderer';

/**
 * `npm run remotion:browser`
 * SETUP STEP, like installing FFmpeg: downloads Remotion's pinned Chrome Headless Shell into
 * node_modules/.remotion/chrome-headless-shell/<platform>/ (about 100 MB). It is the ONLY time anything is
 * downloaded: rendering never downloads (it is given the executable path explicitly), so a render works with
 * the network off. Needs the network once. Prints the percentage and nothing else.
 */
async function main(): Promise<void> {
  let ultimo = -1;
  await ensureBrowser({
    onBrowserDownload: () => {
      console.log('Downloading Chrome Headless Shell (Remotion\'s pinned version)...');
      return {
        version: null,
        onProgress: ({ percent }) => {
          const entero = Math.floor(percent * 100);
          if (entero % 10 === 0 && entero !== ultimo) {
            ultimo = entero;
            console.log(`  ${entero}%`);
          }
        },
      };
    },
  });
  console.log('Chrome Headless Shell is installed.');
}

main().catch((err: unknown) => {
  // Message only: never print the error object.
  console.error(err instanceof Error ? err.message : 'remotion:browser failed');
  process.exitCode = 1;
});
