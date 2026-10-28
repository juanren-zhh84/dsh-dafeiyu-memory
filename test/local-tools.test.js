import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, cpSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const cli = fileURLToPath(new URL('../scripts/import-existing.mjs', import.meta.url));
const verifier = fileURLToPath(new URL('../scripts/verify-local-install.ps1', import.meta.url));
const run = (home, mode = '--dry-run') => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, '--dsh-home', home, mode], { encoding: 'utf8' });
function fixture(t) { const home = mkdtempSync(join(tmpdir(), 'local-tools-')); t.after(() => rmSync(home, { recursive: true, force: true })); return home; }
test('CLI dry-run never creates a real target; apply backs up and is idempotent without scheduler/model/Douyin', t => {
  assert.equal(existsSync(cli), true, 'safe import CLI is required'); const home = fixture(t);
  cpSync(new URL('./fixtures/aurabot', import.meta.url), join(home, 'plugins-data/aurabot'), { recursive: true });
  const dry = run(home); assert.equal(dry.status, 0, dry.stderr); const plan = JSON.parse(dry.stdout);
  assert.equal(plan.ok, true); assert.deepEqual(plan.sources.map(x => x.source), ['aurabot', 'pet']);
  assert.equal(existsSync(join(home, 'dafeiyu-memory')), false); assert.ok(plan.sources[0].planned > 0);
  const apply = run(home, '--apply'); assert.equal(apply.status, 0, apply.stderr); assert.equal(JSON.parse(apply.stdout).ok, true);
  const snapshots = join(home, 'dafeiyu-memory/backups/import-sources'); assert.ok(readdirSync(snapshots).length);
  const firstBytes = readFileSync(join(home, 'plugins-data/aurabot/memories.json'));
  const again = run(home, '--apply'); assert.equal(again.status, 0, again.stderr); assert.ok(JSON.parse(again.stdout).sources.every(x => x.imported === 0));
  assert.deepEqual(readFileSync(join(home, 'plugins-data/aurabot/memories.json')), firstBytes);
  assert.doesNotMatch(apply.stdout + again.stdout, /喜欢|private:|[A-Z]:\\|\/Users\//);
  const db = join(home, 'dafeiyu-memory/memory.sqlite');
  const beforeDb = readFileSync(db), beforeNames = readdirSync(join(home, 'dafeiyu-memory'));
  assert.equal(run(home).status, 0); assert.deepEqual(readFileSync(db), beforeDb);
  assert.deepEqual(readdirSync(join(home, 'dafeiyu-memory')), beforeNames);
  writeFileSync(`${db}-wal`, 'busy sentinel');
  const busy = run(home); assert.notEqual(busy.status, 0); assert.equal(JSON.parse(busy.stdout).code, 'TARGET_BUSY');
  assert.equal(readFileSync(`${db}-wal`, 'utf8'), 'busy sentinel');
});
test('CLI rejects relative paths, unknown existing targets, links and corrupt sources before real writes', t => {
  assert.equal(existsSync(cli), true); assert.notEqual(run('relative').status, 0);
  const home = fixture(t); mkdirSync(join(home, 'dafeiyu-memory')); writeFileSync(join(home, 'dafeiyu-memory/unknown'), 'preserve');
  assert.notEqual(run(home, '--apply').status, 0); assert.equal(readFileSync(join(home, 'dafeiyu-memory/unknown'), 'utf8'), 'preserve');
  const corrupt = fixture(t); mkdirSync(join(corrupt, 'plugins-data/aurabot'), { recursive: true }); writeFileSync(join(corrupt, 'plugins-data/aurabot/memories.json'), 'corrupt');
  assert.notEqual(run(corrupt, '--apply').status, 0); assert.equal(existsSync(join(corrupt, 'dafeiyu-memory')), false);
  const linked = fixture(t); mkdirSync(join(linked, 'plugins-data'));
  const command = `New-Item -ItemType Junction -Path '${join(linked, 'plugins-data/aurabot')}' -Target '${join(home, 'dafeiyu-memory')}' | Out-Null`;
  assert.equal(spawnSync('pwsh', ['-NoProfile', '-Command', command]).status, 0); assert.notEqual(run(linked).status, 0);
});
test('local verifier is read-only, redacted, supports preactivation and has an activation strict mode', t => {
  assert.equal(existsSync(verifier), true, 'read-only verifier required'); const home = fixture(t);
  const before = readdirSync(home);
  const runCheck = extra => spawnSync('pwsh', ['-NoProfile', '-File', verifier, '-DshHome', home, ...extra], { encoding: 'utf8' });
  const result = runCheck([]); const report = JSON.parse(result.stdout);
  assert.equal(report.checks.find(x => x.code === 'CORE_ACTIVATION').status, 'pending');
  assert.equal(report.checks.find(x => x.code === 'DOUYIN_OPTIONAL').required, false);
  assert.doesNotMatch(result.stdout, /[A-Z]:\\|local-tools-/); assert.deepEqual(readdirSync(home), before);
  assert.notEqual(runCheck(['-RequireActivated']).status, 0);
  assert.equal(run(home, '--apply').status, 0);
  const dbPath = join(home, 'dafeiyu-memory/memory.sqlite'), original = readFileSync(dbPath);
  const checked = JSON.parse(runCheck([]).stdout);
  assert.equal(checked.checks.find(x => x.code === 'CORE_DATABASE').details.code, 'DATABASE_OFFLINE_OK');
  assert.deepEqual(readFileSync(dbPath), original);
  assert.equal(existsSync(`${dbPath}-wal`), false); assert.equal(existsSync(`${dbPath}-shm`), false);
  writeFileSync(`${dbPath}-wal`, 'active sentinel');
  const active = JSON.parse(runCheck([]).stdout);
  assert.equal(active.checks.find(x => x.code === 'CORE_DATABASE').details.code, 'DATABASE_ACTIVE_SAFE_HEADER_ONLY');
  assert.equal(readFileSync(`${dbPath}-wal`, 'utf8'), 'active sentinel');
});
test('local verifier rejects a forged prepared state with no canonical patched files', t => {
  const home = fixture(t), pet = join(home, 'sources/dsh-pet-unified-memory');
  mkdirSync(join(pet, '.git'), { recursive: true }); mkdirSync(join(pet, 'lib'));
  writeFileSync(join(pet, 'package.json'), JSON.stringify({ name: 'dsh-pet', version: '0.3.8' }));
  writeFileSync(join(pet, 'lib/index.js'), 'synthetic');
  const patch = readFileSync(new URL('../integrations/dsh-pet/patches/0.3.8-unified-memory.patch', import.meta.url));
  writeFileSync(join(pet, '.git/dafeiyu-unified-memory.json'), JSON.stringify({ packageRelative: '', tag: 'v0.3.8', patchHash: createHash('sha256').update(patch).digest('hex'), files: [] }));
  const result = spawnSync('pwsh', ['-NoProfile', '-File', verifier, '-DshHome', home], { encoding: 'utf8' });
  const report = JSON.parse(result.stdout);
  assert.equal(report.checks.find(x => x.code === 'PET_PREPARED')?.status, 'fail');
});

test('local verifier accepts exactly tested DSH rc.2 and rc.3 versions without partial prerelease matches', t => {
  const home = fixture(t);
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  for (const [output, version, expected] of [
    ['0.2.1-rc.2', '0.2.1-rc.2', 'pass'], ['0.2.1-rc.3', '0.2.1-rc.3', 'pass'],
    ['DeepSeek Harness 0.2.1-rc.2', '0.2.1-rc.2', 'pass'], ['dsh v0.2.1-rc.3', '0.2.1-rc.3', 'pass'],
    ...['0.2.1-rc.20', '0.2.1-rc.4', '0.2.2', '0.2.1-rc.3.1', '0.2.1-rc.3beta',
      '0.2.1-rc.3+build.1', '0.2.1-rc.3-tail', '0.2.1-rc.3+'].map(version => [`DeepSeek Harness ${version}`, version, 'fail']),
    ['unavailable', 'UNKNOWN', 'fail']]) {
    const command = `function global:dsh { ${quote(output)} }; & ${quote(verifier)} -DshHome ${quote(home)}`;
    const result = spawnSync('pwsh', ['-NoProfile', '-Command', command], { encoding: 'utf8' });
    const check = JSON.parse(result.stdout).checks.find(row => row.code === 'DSH_VERSION');
    assert.equal(check.status, expected, version); assert.equal(check.details, version);
  }
});
