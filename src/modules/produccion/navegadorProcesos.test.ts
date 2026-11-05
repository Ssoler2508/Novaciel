import { describe, expect, it } from 'vitest';
import {
  arbolDe,
  crearProcesosNavegador,
  parsearTablaPs,
  type DependenciasProcesos,
  type Senal,
} from './navegadorProcesos.js';

const CHROME = '/opt/novaciel/node_modules/.remotion/chrome-headless-shell/linux64/chrome-headless-shell';

interface Fila {
  pid: number;
  ppid: number;
  args: string;
}

/** A fake machine: a process table, the signals each pid obeys, and a log of everything done to it. */
class MaquinaFalsa {
  tabla: Fila[];
  senales: Array<{ pid: number; senal: Senal }> = [];
  comandos: Array<{ comando: string; argumentos: string[] }> = [];
  /** Pids that ignore SIGTERM (only SIGKILL removes them). */
  ignoranTerm = new Set<number>();
  /** Pids whose signal call throws (no permission). */
  sinPermiso = new Set<number>();
  salidaTasklist = '';
  reloj = 0;

  constructor(tabla: Fila[]) {
    this.tabla = tabla;
  }

  deps(plataforma: NodeJS.Platform, extra: Partial<DependenciasProcesos> = {}): DependenciasProcesos {
    return {
      plataforma,
      pidPropio: 1,
      esperaSigtermMs: 300,
      ejecutar: async (comando, argumentos) => {
        this.comandos.push({ comando, argumentos });
        if (comando === 'ps') return this.tabla.map((f) => `  ${f.pid} ${f.ppid} ${f.args}`).join('\n');
        if (comando === 'tasklist') return this.salidaTasklist;
        return '';
      },
      enviarSenal: (pid, senal) => {
        if (this.sinPermiso.has(pid)) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
        this.senales.push({ pid, senal });
        if (senal === 'SIGKILL' || !this.ignoranTerm.has(pid)) this.tabla = this.tabla.filter((f) => f.pid !== pid);
      },
      estaVivo: (pid) => this.tabla.some((f) => f.pid === pid),
      dormir: async (ms) => {
        await new Promise((r) => setTimeout(r, ms));
      },
      ...extra,
    };
  }
}

const ARBOL: Fila[] = [
  { pid: 1, ppid: 0, args: 'node /srv/app/dist/index.js' },
  { pid: 100, ppid: 1, args: `${CHROME} --headless --remote-debugging-pipe` },
  { pid: 101, ppid: 100, args: `${CHROME} --type=zygote` },
  { pid: 102, ppid: 101, args: `${CHROME} --type=renderer` },
  { pid: 103, ppid: 100, args: `${CHROME} --type=gpu-process` },
  { pid: 200, ppid: 1, args: '/usr/bin/other-chrome --headless' },
  { pid: 201, ppid: 200, args: '/usr/bin/other-chrome --type=renderer' },
];

describe('parsearTablaPs / arbolDe', () => {
  it('parses ps output with leading spaces and arguments containing spaces', () => {
    expect(parsearTablaPs('  12   1 /usr/bin/x --a b\n\n 7 12 y\nbasura\n')).toEqual([
      { pid: 12, ppid: 1, args: '/usr/bin/x --a b' },
      { pid: 7, ppid: 12, args: 'y' },
    ]);
  });

  it('returns descendants children first, each pid once, and ignores cycles', () => {
    const tabla = [
      { pid: 1, ppid: 5, args: '' },
      { pid: 2, ppid: 1, args: '' },
      { pid: 3, ppid: 2, args: '' },
      { pid: 5, ppid: 3, args: '' }, // artificial cycle
    ];
    const orden = arbolDe(tabla, [1]);
    expect(new Set(orden).size).toBe(orden.length);
    expect(orden.indexOf(3)).toBeLessThan(orden.indexOf(2));
    expect(orden.indexOf(2)).toBeLessThan(orden.indexOf(1));
  });
});

describe('linux path (fake process table)', () => {
  it('lists the browser root and all its descendants, and nothing else', async () => {
    const m = new MaquinaFalsa(ARBOL);
    const p = crearProcesosNavegador(m.deps('linux'));
    const pids = await p.listar(CHROME);
    expect([...pids].sort((a, b) => a - b)).toEqual([100, 101, 102, 103]);
    expect(m.comandos[0]).toEqual({ comando: 'ps', argumentos: ['-e', '-o', 'pid=,ppid=,args='] });
  });

  it('does not match a different executable that merely shares a prefix', async () => {
    const m = new MaquinaFalsa([{ pid: 300, ppid: 1, args: `${CHROME}-old --headless` }]);
    expect(await crearProcesosNavegador(m.deps('linux')).listar(CHROME)).toEqual([]);
  });

  it('never lists or kills its own process', async () => {
    const m = new MaquinaFalsa([{ pid: 1, ppid: 0, args: `${CHROME} --odd` }]);
    const p = crearProcesosNavegador(m.deps('linux'));
    expect(await p.listar(CHROME)).toEqual([]);
    await p.matar([1]);
    expect(m.senales).toEqual([]);
  });

  it('sends SIGTERM to the whole tree, children first, and no SIGKILL when everything obeys', async () => {
    const m = new MaquinaFalsa(ARBOL);
    await crearProcesosNavegador(m.deps('linux')).matar([100]);
    const orden = m.senales.map((s) => s.pid);
    expect(m.senales.every((s) => s.senal === 'SIGTERM')).toBe(true);
    expect(new Set(orden)).toEqual(new Set([100, 101, 102, 103]));
    expect(orden.indexOf(102)).toBeLessThan(orden.indexOf(101));
    expect(orden.indexOf(101)).toBeLessThan(orden.indexOf(100));
    expect(m.tabla.map((f) => f.pid)).toEqual([1, 200, 201]); // the unrelated browser is untouched
  });

  it('kills descendants that appeared after the caller listed the pids', async () => {
    const m = new MaquinaFalsa(ARBOL);
    await crearProcesosNavegador(m.deps('linux')).matar([101]); // only the zygote was listed
    expect(m.senales.map((s) => s.pid).sort((a, b) => a - b)).toEqual([101, 102]);
  });

  it('escalates to SIGKILL only for processes that ignore SIGTERM, after the bounded wait', async () => {
    const m = new MaquinaFalsa(ARBOL);
    m.ignoranTerm.add(102);
    const inicio = Date.now();
    await crearProcesosNavegador(m.deps('linux', { esperaSigtermMs: 200 })).matar([100]);
    const duracion = Date.now() - inicio;
    expect(m.senales.filter((s) => s.senal === 'SIGKILL')).toEqual([{ pid: 102, senal: 'SIGKILL' }]);
    expect(duracion).toBeGreaterThanOrEqual(180);
    expect(duracion).toBeLessThan(1500);
    expect(m.tabla.some((f) => f.pid === 102)).toBe(false);
  });

  it('does not wait the grace period when every process exits at once', async () => {
    const m = new MaquinaFalsa(ARBOL);
    const inicio = Date.now();
    await crearProcesosNavegador(m.deps('linux', { esperaSigtermMs: 5_000 })).matar([100]);
    expect(Date.now() - inicio).toBeLessThan(1000);
  });

  it('survives a signal that throws and a process table that cannot be read', async () => {
    const m = new MaquinaFalsa(ARBOL);
    m.sinPermiso.add(103);
    await expect(crearProcesosNavegador(m.deps('linux', { esperaSigtermMs: 100 })).matar([100])).resolves.toBeUndefined();

    const roto = crearProcesosNavegador({
      ...m.deps('linux'),
      ejecutar: async () => {
        throw new Error('ps missing');
      },
    });
    await expect(roto.listar(CHROME)).resolves.toEqual([]);
    await expect(roto.matar([100])).resolves.toBeUndefined();
  });

  it('ignores invalid pids', async () => {
    const m = new MaquinaFalsa(ARBOL);
    await crearProcesosNavegador(m.deps('linux')).matar([0, -5, 1.5, Number.NaN]);
    expect(m.senales).toEqual([]);
    expect(m.comandos).toEqual([]);
  });
});

describe('windows path (fake commands)', () => {
  it('lists by image name and parses the CSV, ignoring other images and noise', async () => {
    const m = new MaquinaFalsa([]);
    m.salidaTasklist = [
      '"chrome-headless-shell.exe","1234","Console","1","50.000 KB"',
      '"CHROME-HEADLESS-SHELL.EXE","5678","Console","1","9 KB"',
      '"other.exe","42","Console","1","1 KB"',
      'INFO: No tasks are running which match the specified criteria.',
    ].join('\r\n');
    const pids = await crearProcesosNavegador(m.deps('win32')).listar('C:\\app\\.remotion\\chrome-headless-shell.exe');
    expect(pids).toEqual([1234, 5678]);
    expect(m.comandos[0]).toEqual({
      comando: 'tasklist',
      argumentos: ['/FI', 'IMAGENAME eq chrome-headless-shell.exe', '/FO', 'CSV', '/NH'],
    });
  });

  it('kills each pid with its tree using taskkill and sends no signals', async () => {
    const m = new MaquinaFalsa([]);
    await crearProcesosNavegador(m.deps('win32')).matar([1234, 5678, 1]);
    expect(m.comandos).toEqual([
      { comando: 'taskkill', argumentos: ['/PID', '1234', '/T', '/F'] },
      { comando: 'taskkill', argumentos: ['/PID', '5678', '/T', '/F'] },
    ]);
    expect(m.senales).toEqual([]);
  });
});
