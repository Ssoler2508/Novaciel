import { execFile } from 'node:child_process';
import path from 'node:path';

// The operating-system side of the Remotion adapter's cleanup (Step 7c, fix in Step 11): list the processes of
// the headless browser and kill them. The adapter uses it ONLY after a render failed or timed out and the
// browser did not close by itself within its bounded wait. Nothing here reads or returns anything but process
// ids. Every call is bounded (the child process has its own timeout; the Linux grace wait is short) and never
// throws. The platform is chosen by `process.platform`:
//  - win32: `tasklist` to list, `taskkill /T /F` to kill a process and its children.
//  - anything else (Linux, macOS): `ps` to read the process table, then signals: SIGTERM to the whole tree
//    (children first), a bounded wait, and SIGKILL to whatever is still alive.
// The Linux path is covered by unit tests with fake process tables only; it has not been exercised on a real
// Linux machine yet (see ADR-06, section 8).

export interface ProcesosNavegador {
  /** Process ids of the browser: the processes running its executable plus all their descendants. */
  listar(ejecutable: string): Promise<number[]>;
  /** Kills these processes and their descendants. Best effort: it never throws. */
  matar(pids: readonly number[]): Promise<void>;
}

const LIMITE_COMANDO_MS = 3_000;
/** Grace period between SIGTERM and SIGKILL. Shorter than the adapter's own bound for killing processes. */
export const ESPERA_SIGTERM_MS = 800;
const SONDEO_MS = 50;

export type Senal = 'SIGTERM' | 'SIGKILL';

/** Everything the module needs from the machine, so both platform paths can be tested with fakes. */
export interface DependenciasProcesos {
  plataforma: NodeJS.Platform;
  /** Runs a command and returns its stdout ('' on any failure). Bounded. */
  ejecutar(comando: string, argumentos: string[]): Promise<string>;
  /** Sends a signal to one pid. May throw (the process is gone, no permission). */
  enviarSenal(pid: number, senal: Senal): void;
  /** True if the pid still exists. */
  estaVivo(pid: number): boolean;
  dormir(ms: number): Promise<void>;
  pidPropio: number;
  esperaSigtermMs: number;
}

function ejecutarReal(comando: string, argumentos: string[]): Promise<string> {
  return new Promise((resolve) => {
    try {
      execFile(comando, argumentos, { windowsHide: true, timeout: LIMITE_COMANDO_MS, encoding: 'utf8' }, (_error, salida) => resolve(String(salida ?? '')));
    } catch {
      resolve('');
    }
  });
}

const DEPENDENCIAS_REALES: DependenciasProcesos = {
  plataforma: process.platform,
  ejecutar: ejecutarReal,
  enviarSenal: (pid, senal) => {
    process.kill(pid, senal);
  },
  estaVivo: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM'; // exists but not ours
    }
  },
  dormir: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pidPropio: process.pid,
  esperaSigtermMs: ESPERA_SIGTERM_MS,
};

// ---------- Windows ----------

async function listarWindows(deps: DependenciasProcesos, ejecutable: string): Promise<number[]> {
  const nombre = path.win32.basename(ejecutable);
  const salida = await deps.ejecutar('tasklist', ['/FI', `IMAGENAME eq ${nombre}`, '/FO', 'CSV', '/NH']);
  // "chrome-headless-shell.exe","1234","Console","1","50.000 KB"
  return salida.split(/\r?\n/).flatMap((linea) => {
    const campos = linea.match(/"([^"]*)"/g)?.map((c) => c.slice(1, -1)) ?? [];
    return campos[0]?.toLowerCase() === nombre.toLowerCase() && /^\d+$/.test(campos[1] ?? '') ? [Number(campos[1])] : [];
  });
}

async function matarWindows(deps: DependenciasProcesos, pids: readonly number[]): Promise<void> {
  await Promise.all(pids.map((pid) => deps.ejecutar('taskkill', ['/PID', String(pid), '/T', '/F'])));
}

// ---------- Linux / POSIX ----------

interface FilaProceso {
  pid: number;
  ppid: number;
  /** Full command line (`ps -o args`). */
  args: string;
}

/** Parses `ps -e -o pid=,ppid=,args=` (one process per line, leading spaces allowed). */
export function parsearTablaPs(salida: string): FilaProceso[] {
  return salida.split(/\r?\n/).flatMap((linea) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(linea);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] ?? '' }] : [];
  });
}

/** `pid` and every descendant of it, deepest first (children before their parents). */
export function arbolDe(tabla: readonly FilaProceso[], raices: readonly number[]): number[] {
  const hijos = new Map<number, number[]>();
  for (const f of tabla) hijos.set(f.ppid, [...(hijos.get(f.ppid) ?? []), f.pid]);
  const orden: number[] = [];
  const visto = new Set<number>();
  const visitar = (pid: number): void => {
    if (visto.has(pid)) return;
    visto.add(pid);
    for (const hijo of hijos.get(pid) ?? []) visitar(hijo);
    orden.push(pid); // post-order: children first
  };
  for (const raiz of raices) visitar(raiz);
  return orden;
}

async function tablaPosix(deps: DependenciasProcesos): Promise<FilaProceso[]> {
  return parsearTablaPs(await deps.ejecutar('ps', ['-e', '-o', 'pid=,ppid=,args=']));
}

async function listarPosix(deps: DependenciasProcesos, ejecutable: string): Promise<number[]> {
  const tabla = await tablaPosix(deps);
  const raices = tabla
    .filter((f) => f.pid !== deps.pidPropio && (f.args === ejecutable || f.args.startsWith(`${ejecutable} `)))
    .map((f) => f.pid);
  return arbolDe(tabla, raices).filter((pid) => pid !== deps.pidPropio);
}

function enviar(deps: DependenciasProcesos, pid: number, senal: Senal): void {
  try {
    deps.enviarSenal(pid, senal);
  } catch {
    // already gone or not ours
  }
}

async function matarPosix(deps: DependenciasProcesos, pids: readonly number[]): Promise<void> {
  // Re-read the table: children may have appeared since the caller listed the pids.
  const tabla = await tablaPosix(deps);
  const objetivo = arbolDe(tabla, pids).filter((pid) => pid !== deps.pidPropio);
  for (const pid of pids) if (!objetivo.includes(pid) && pid !== deps.pidPropio) objetivo.push(pid);

  for (const pid of objetivo) enviar(deps, pid, 'SIGTERM');

  const limite = Date.now() + deps.esperaSigtermMs;
  let vivos = objetivo.filter((pid) => deps.estaVivo(pid));
  while (vivos.length > 0 && Date.now() < limite) {
    await deps.dormir(Math.min(SONDEO_MS, Math.max(1, limite - Date.now())));
    vivos = vivos.filter((pid) => deps.estaVivo(pid));
  }
  for (const pid of vivos) enviar(deps, pid, 'SIGKILL');
}

// ---------- Public ----------

/** Builds the process helper for a platform. The real one is `procesosReales`; tests pass fakes. */
export function crearProcesosNavegador(deps: DependenciasProcesos): ProcesosNavegador {
  const esWindows = deps.plataforma === 'win32';
  return {
    async listar(ejecutable) {
      try {
        return esWindows ? await listarWindows(deps, ejecutable) : await listarPosix(deps, ejecutable);
      } catch {
        return [];
      }
    },
    async matar(pids) {
      const validos = pids.filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== deps.pidPropio);
      if (validos.length === 0) return;
      try {
        if (esWindows) await matarWindows(deps, validos);
        else await matarPosix(deps, validos);
      } catch {
        // best effort
      }
    },
  };
}

export const procesosReales: ProcesosNavegador = crearProcesosNavegador(DEPENDENCIAS_REALES);
