import { isAbsolute, join } from 'node:path';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { memoryError } from './contracts.js';

/** Test overrides name the DSH home, never the plugin installation directory. */
export function resolveMemoryPaths({ dshHome = resolveDshHome() } = {}) {
  if (typeof dshHome !== 'string' || !isAbsolute(dshHome)) {
    throw memoryError('MEMORY_INVALID_PATH', 'DSH home must be an absolute path');
  }
  const root = join(dshHome, 'dafeiyu-memory');
  return Object.freeze({
    root,
    database: join(root, 'memory.sqlite'),
    backups: join(root, 'backups'),
    spool: join(root, 'spool'),
    reports: join(root, 'reports'),
  });
}
