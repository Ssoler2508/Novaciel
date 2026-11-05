import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Every pg-boss worker of the system must go through withFailureAlert, or a failed job raises no alert
// (Step 11). A new boss.work added without it fails here. The startup ping of lib/queue is the only exception.

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXCEPTIONS = [path.join('lib', 'queue', 'index.ts')];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') && !full.endsWith('.test.ts') ? [full] : [];
  });
}

describe('pg-boss workers', () => {
  it('every boss.work registration is wrapped with withFailureAlert', () => {
    const found: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const relative = path.relative(SRC, file);
      if (EXCEPTIONS.includes(relative)) continue;
      const source = readFileSync(file, 'utf8');
      const registrations = source.split('boss.work').length - 1;
      if (registrations === 0) continue;
      const wrapped = source.split('withFailureAlert(').length - 1;
      found.push(`${relative}: ${registrations} workers`);
      expect(wrapped, `${relative} registers ${registrations} workers but wraps ${wrapped}`).toBeGreaterThanOrEqual(registrations);
    }
    // 2 reminders, QC, 2 briefs, plan, budget expiry, 2 productions = 9 files' worth of registrations.
    expect(found.length).toBeGreaterThanOrEqual(6);
  });
});
