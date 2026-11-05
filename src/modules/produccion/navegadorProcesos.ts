import { execFile } from 'node:child_process';
import path from 'node:path';

// The operating-system side of the Remotion adapter's cleanup (Step 7c, fix in Step 11): list the processes of
// the headless browser and kill them. The adapter uses it ONLY after a render failed or timed out and the
// browser did not close by itself within its bounded wait. Nothing here reads or returns anything but process
// ids. Every call is bounded (the child process has its own timeout) and never throws.

export interface ProcesosNavegador {
  /** Process ids whose image is the browser's executable (the root process and its children). */
  listar(ejecutable: string): Promise<number[]>;
  /** Kills these processes and their children. Best effort: it never throws. */
  matar(pids: readonly number[]): Promise<void>;
}

const LIMITE_COMANDO_MS = 3_000;

function ejecutar(comando: string, argumentos: string[]): Promise<string> {
  return new Promise((resolve) => {
    try {
      execFile(comando, argumentos, { windowsHide: true, timeout: LIMITE_COMANDO_MS, encoding: 'utf8' }, (_error, salida) => resolve(String(salida ?? '')));
    } catch {
      resolve('');
    }
  });
}

export const procesosReales: ProcesosNavegador = {
  async listar(ejecutable) {
    const nombre = path.basename(ejecutable);
    if (process.platform === 'win32') {
      const salida = await ejecutar('tasklist', ['/FI', `IMAGENAME eq ${nombre}`, '/FO', 'CSV', '/NH']);
      // "chrome-headless-shell.exe","1234","Console","1","50.000 KB"
      return salida
        .split(/\r?\n/)
        .flatMap((linea) => {
          const campos = linea.match(/"([^"]*)"/g)?.map((c) => c.slice(1, -1)) ?? [];
          return campos[0]?.toLowerCase() === nombre.toLowerCase() && /^\d+$/.test(campos[1] ?? '') ? [Number(campos[1])] : [];
        });
    }
    const salida = await ejecutar('pgrep', ['-f', ejecutable]);
    return salida
      .split(/\r?\n/)
      .filter((l) => /^\d+$/.test(l.trim()))
      .map(Number);
  },

  async matar(pids) {
    await Promise.all(
      pids.map(async (pid) => {
        if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
        if (process.platform === 'win32') {
          await ejecutar('taskkill', ['/PID', String(pid), '/T', '/F']);
          return;
        }
        try {
          process.kill(-pid, 'SIGKILL'); // the browser leads its own process group
        } catch {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // already gone
          }
        }
      }),
    );
  },
};
