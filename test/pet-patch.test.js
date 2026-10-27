import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';

const root = fileURLToPath(new URL('../', import.meta.url));
const patchPath = resolve(root, 'integrations/dsh-pet/patches/0.3.8-unified-memory.patch');
const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function fixture(t, nested = false) {
  const dir = mkdtempSync(join(tmpdir(), 'pet-patch-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const packageRoot = nested ? join(dir, 'dsh-pet') : dir;
  mkdirSync(join(packageRoot, 'src/host'), { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), readFileSync(resolve(root, 'test/fixtures/pet/upstream-package.json')));
  writeFileSync(join(packageRoot, 'src/host/index.ts'), readFileSync(resolve(root, 'test/fixtures/pet/upstream-chat-0.3.8.ts')));
  run('git', ['init', '-q'], dir);
  run('git', ['config', 'core.autocrlf', 'false'], dir);
  run('git', ['add', '.'], dir);
  run('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'v0.3.8 fixture'], dir);
  run('git', ['tag', 'v0.3.8'], dir);
  return dir;
}

test('0.3.8 version-locked pet patch and preparation script exist', () => {
  for (const file of ['integrations/dsh-pet/bridge.ts', 'integrations/dsh-pet/patches/0.3.8-unified-memory.patch', 'scripts/prepare-pet-source.ps1']) {
    assert.equal(existsSync(new URL(`../${file}`, import.meta.url)), true, `${file} is missing`);
  }
  const script = readFileSync(new URL('../scripts/prepare-pet-source.ps1', import.meta.url), 'utf8');
  assert.match(script, /0\.3\.8/);
});

test('preparation supports the real tag layout with package inside dsh-pet/', t => {
  const remote = fixture(t, true);
  for (const name of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) writeFileSync(join(remote, 'dsh-pet', name), '# fixture');
  run('git', ['add', '.'], remote);
  run('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'pnpm workspace'], remote);
  run('git', ['tag', '-f', 'v0.3.8'], remote);
  const home = mkdtempSync(join(tmpdir(), 'pet-nested-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const target = join(home, 'sources/upstream');
  const bin = join(home, 'bin'), trace = join(home, 'commands.jsonl');
  mkdirSync(bin);
  writeFileSync(join(bin, 'corepack.ps1'), `param([Parameter(ValueFromRemainingArguments=$true)][string[]] $Rest)
@{ cwd = (Get-Location).Path; args = @($Rest) } | ConvertTo-Json -Compress | Add-Content -LiteralPath $env:PET_COMMAND_TRACE
exit 0
`);
  const env = { ...process.env, PET_COMMAND_TRACE: trace, npm_config_offline: 'true', npm_config_update_notifier: 'false' };
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path');
  env[pathKey] = `${bin};${env[pathKey]}`;
  const invoke = () => spawnSync('pwsh', ['-NoProfile', '-File', resolve(root, 'scripts/prepare-pet-source.ps1'),
    '-DshHome', home, '-Remote', remote, '-Target', target],
  { encoding: 'utf8', timeout: 120000, env });
  const result = invoke();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(existsSync(join(target, 'dsh-pet/src/host/unified-memory.ts')));
  assert.equal(existsSync(join(target, 'src')), false);
  assert.ok(existsSync(trace), 'pnpm workspace must use corepack, not npm');
  const commands = readFileSync(trace, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
  const packageRoot = join(target, 'dsh-pet');
  assert.deepEqual(commands, [
    { cwd: packageRoot, args: ['pnpm', 'install', '--frozen-lockfile'] },
    { cwd: packageRoot, args: ['pnpm', '--dir', packageRoot, 'test'] },
    { cwd: packageRoot, args: ['pnpm', '--dir', packageRoot, 'build'] },
  ]);
  const repeated = invoke();
  assert.equal(repeated.status, 0, repeated.stdout + repeated.stderr);
});

test('patch changes only host hook, canonical bridge and upstream tests; bridge matches normalized text', t => {
  const patch = readFileSync(patchPath, 'utf8');
  assert.deepEqual([...patch.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)].map(m => m[2]).sort(),
    ['src/host/index.ts', 'src/host/unified-memory.test.ts', 'src/host/unified-memory.ts']);
  const dir = fixture(t);
  run('git', ['apply', '--check', patchPath], dir);
  run('git', ['apply', patchPath], dir);
  const normalize = text => text.replaceAll('\r\n', '\n');
  assert.equal(normalize(readFileSync(join(dir, 'src/host/unified-memory.ts'), 'utf8')), normalize(readFileSync(resolve(root, 'integrations/dsh-pet/bridge.ts'), 'utf8')));
  assert.equal(normalize(readFileSync(join(dir, 'src/host/unified-memory.test.ts'), 'utf8')), normalize(readFileSync(resolve(root, 'test/fixtures/pet/unified-memory.test.ts'), 'utf8')));
  // Compare the actual original and patched function with the same host fixtures.
  const tests = readFileSync(join(dir, 'src/host/unified-memory.test.ts'), 'utf8');
  const harnessText = tests.slice(tests.indexOf('function harness('), tests.indexOf('const settle ='));
  const makeHarness = new Function('code', 'recallForPet', 'recordPetExchange', `${stripTypeScriptTypes(harnessText)}; return harness;`);
  const functionCode = text => stripTypeScriptTypes(text.slice(text.indexOf('  const chatWithPet = async (')));
  // The hook's helpers are inert when the optional service is absent.
  const before = makeHarness(functionCode(readFileSync(resolve(root, 'test/fixtures/pet/upstream-chat-0.3.8.ts'), 'utf8')), () => '', async () => 'PET_MEMORY_UNAVAILABLE')({ service: null });
  const after = makeHarness(functionCode(readFileSync(join(dir, 'src/host/index.ts'), 'utf8')), () => '', async () => 'PET_MEMORY_UNAVAILABLE')({ service: null });
  return Promise.all([before.chat('fish', 'query'), after.chat('fish', 'query')]).then(([a, b]) => {
    assert.deepEqual(b, a);
    assert.deepEqual(after.calls[0].slice(1), before.calls[0].slice(1));
    assert.deepEqual(after.calls[0][0].get('absent', false), before.calls[0][0].get('absent', false));
    assert.deepEqual(after.bubbles, before.bubbles);
    // These tests execute the actual patched chatWithPet function, with only its host dependencies substituted.
    const result = spawnSync(process.execPath, ['--test', 'src/host/unified-memory.test.ts'], { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
});

test('preparation rejects wrong versions, outside paths, dirty trees and changed patched files without overwriting', t => {
  const script = resolve(root, 'scripts/prepare-pet-source.ps1');
  assert.ok(existsSync(script), 'preparation script missing');
  const remote = fixture(t);
  const home = mkdtempSync(join(tmpdir(), 'pet-source-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const invoke = target => spawnSync('pwsh', ['-NoProfile', '-File', script, '-DshHome', home, '-Remote', remote, '-Target', target],
    { encoding: 'utf8', timeout: 120000, env: { ...process.env, npm_config_offline: 'true', npm_config_update_notifier: 'false' } });
  const outside = join(home, 'profile/desktop');
  assert.notEqual(invoke(outside).status, 0);
  assert.equal(existsSync(outside), false);
  const target = join(home, 'sources/pet');
  run('git', ['clone', '-q', remote, target], home);
  writeFileSync(join(target, 'package.json'), '{"name":"dsh-pet","version":"0.3.9"}');
  assert.match(invoke(target).stderr, /PET_SOURCE_VERSION_MISMATCH/);
  writeFileSync(join(target, 'package.json'), '{"name":"other-package","version":"0.3.8"}');
  assert.match(invoke(target).stderr, /PET_SOURCE_VERSION_MISMATCH/);
  run('git', ['restore', 'package.json'], target);
  writeFileSync(join(target, 'unknown.txt'), 'do not overwrite');
  assert.match(invoke(target).stderr, /PET_SOURCE_DIRTY/);
  assert.equal(readFileSync(join(target, 'unknown.txt'), 'utf8'), 'do not overwrite');
  rmSync(join(target, 'unknown.txt'));
  const prepared = invoke(target);
  assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
  const repeated = invoke(target);
  assert.equal(repeated.status, 0, repeated.stdout + repeated.stderr);
  writeFileSync(join(target, 'src/host/unified-memory.ts'), '// changed');
  assert.match(invoke(target).stderr, /PET_SOURCE_DIRTY/);
  assert.equal(readFileSync(join(target, 'src/host/unified-memory.ts'), 'utf8'), '// changed');
  const fresh = invoke(join(home, 'sources/fresh'));
  assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr);
});
