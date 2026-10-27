import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

const homes = new Set();
// Registered at module scope so this runs after test-level database disposers.
after(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

export function createTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'dafeiyu-memory-'));
  homes.add(home);
  return home;
}
