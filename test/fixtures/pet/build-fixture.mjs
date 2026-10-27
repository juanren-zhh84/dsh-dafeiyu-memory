import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
if (process.env.PET_BUILD_FAIL) process.exit(1);
if (!process.env.PET_BUILD_EMPTY) for (const [path, body] of [
  ['lib/index.js', '// synthetic PET_MEMORY_RECORDED PET_MEMORY_RECORD_FAILED dafeiyuMemory\nexport {};\n'],
  ['lib/types/index.d.ts', 'export {};\n'],
  ['runtime/electron-helper/shared-core.js', 'export {};\n'],
]) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body); }
