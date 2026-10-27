import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createTempHome } from './helpers/temp-home.js';
import { MemoryDatabase } from '../src/storage/database.js';
import { resolveMemoryPaths } from '../src/paths.js';
import { resolveConfig } from '../src/config.js';
import { apply } from '../src/index.js';
import { createFakeContext } from './helpers/fake-context.js';
const { ImportManager } = await import('../src/importers/index.js').catch(() => ({}));
const NOW = Date.UTC(2026, 9, 27), DAY = 86400000;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function put(file, value) { await fs.mkdir(join(file, '..'), { recursive: true }); await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value)); }
async function setup(t, overrides = {}) {
  assert.equal(typeof ImportManager, 'function', 'ImportManager must implement read-only idempotent migration');
  const home = createTempHome(), paths = resolveMemoryPaths({ dshHome: home });
  const database = await MemoryDatabase.open(paths.database); t.after(() => database.close());
  const sources = { aurabot: join(home, 'plugins-data', 'aurabot'), pet: join(home, 'dsh-pet', 'memory.json'), douyin: join(home, 'missing.sqlite') };
  const manager = new ImportManager({ database, paths, config: resolveConfig(), clock: { now: () => NOW }, ...overrides });
  const rows = table => database.read(db => db.prepare(`SELECT * FROM ${table}`).all());
  return { home, paths, database, sources, manager, rows };
}
async function qqFixture(sources) {
  await fs.cp(new URL('./fixtures/aurabot/', import.meta.url), sources.aurabot, { recursive: true });
}
function source(report, kind) { return report.sources.find(row => row.source === kind); }
async function tree(path) { try { return (await fs.readdir(path, { recursive: true })).sort(); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } }
function sqliteFixture(file, supported = true) {
  const db = new DatabaseSync(file);
  if (supported) { db.exec(readFileSync(new URL('./fixtures/douyin/schema.sql', import.meta.url), 'utf8'));
    db.prepare(`INSERT INTO memory_entries VALUES (1,'note','douyin fixture','api','["api"]',NULL,NULL,NULL,NULL,'{}',?,?,'video','recorded-note',NULL)`).run(NOW - 80 * DAY, NOW - DAY);
  } else db.exec('CREATE TABLE unknown_table(id INTEGER, body TEXT)');
  db.close();
}

test('Aurabot preserves ages, safe visibility, permanent diary and a fresh full long-term lifetime', async t => {
  const c = await setup(t); await qqFixture(c.sources);
  const path = join(c.sources.aurabot, 'chatlog', 'recent.jsonl'), before = digest(await fs.readFile(path));
  const report = await c.manager.importExisting({ sources: c.sources });
  assert.equal(report.ok, true); assert.equal(source(report, 'aurabot').imported, 4);
  const events = c.rows('memory_events'); assert.equal(events.length, 2);
  assert.equal(events[0].visibility, 'group'); assert.equal(events[1].visibility, 'conversation');
  assert.equal(events[0].review_due_at, NOW + 6 * DAY); assert.equal(events[1].review_due_at, NOW - 2 * DAY);
  assert.ok(events.every(row => row.state === 'active'));
  const item = c.rows('memory_items')[0]; assert.equal(item.promoted_at, NOW); assert.equal(item.expires_at, NOW + 30 * DAY); assert.equal(item.visibility, 'owner-private');
  assert.equal(c.rows('diary_entries')[0].visibility, 'owner-private');
  assert.equal(c.rows('import_ledger').length, 4); assert.equal(digest(await fs.readFile(path)), before);
  assert.equal(source(report, 'pet').status, 'skipped');
});

test('Aurabot writer empty text matches live connector and known non-chat qzone rows stay skipped', async t => {
  const c = await setup(t);
  const path = join(c.sources.aurabot, 'chatlog', 'recent.jsonl');
  const rows = [
    { t: NOW, chatId: 'group:synthetic', who: 'fixture', uid: 'synthetic', text: '' },
    { t: NOW + 1, chatId: 'private:synthetic', who: 'fixture', uid: 'synthetic', text: ' \t ' },
    { t: NOW + 2, chatId: 'qzone', who: 'fixture', uid: 'synthetic', text: 'synthetic qzone content' },
  ];
  await put(path, rows.map(JSON.stringify).join('\n'));
  const before = digest(await fs.readFile(path));
  const planned = await c.manager.importExisting({ dryRun: true, sources: { aurabot: c.sources.aurabot } });
  assert.equal(planned.ok, true); assert.equal(source(planned, 'aurabot').planned, 2); assert.equal(source(planned, 'aurabot').skipped, 1);
  const imported = await c.manager.importExisting({ sources: { aurabot: c.sources.aurabot } });
  assert.equal(imported.ok, true); assert.equal(source(imported, 'aurabot').imported, 2); assert.equal(source(imported, 'aurabot').skipped, 1);
  assert.ok(c.rows('memory_events').every(x => x.content_text === '[空消息]'));
  assert.ok(c.rows('memory_events').every(x => x.conversation_key !== 'qzone'));
  assert.equal(c.rows('import_ledger').filter(x => x.result === 'skipped-inactive').length, 1);
  const again = await c.manager.importExisting({ sources: { aurabot: c.sources.aurabot } });
  assert.equal(source(again, 'aurabot').imported, 0); assert.equal(c.rows('import_ledger').length, 3);
  assert.equal(digest(await fs.readFile(path)), before);
});

test('Aurabot unrecognized conversation prefixes remain fail closed instead of becoming public or group', async t => {
  const c = await setup(t);
  await put(join(c.sources.aurabot, 'chatlog', 'recent.jsonl'), JSON.stringify({ t: NOW, chatId: 'unknown:synthetic', who: 'fixture', uid: 'synthetic', text: 'synthetic' }));
  const report = await c.manager.importExisting({ sources: { aurabot: c.sources.aurabot } });
  assert.equal(report.ok, false); assert.equal(source(report, 'aurabot').code, 'INVALID_SOURCE');
  assert.equal(c.rows('memory_events').length, 0); assert.equal(c.rows('import_ledger').length, 0);
});

test('dryRun validates and plans without creating backups, reports, ledger or memory rows', async t => {
  const c = await setup(t); await qqFixture(c.sources);
  const before = await tree(c.home);
  const report = await c.manager.importExisting({ dryRun: true, sources: c.sources });
  assert.equal(report.ok, true); assert.equal(source(report, 'aurabot').planned, 4);
  for (const table of ['import_ledger', 'memory_events', 'memory_items', 'diary_entries']) assert.equal(c.rows(table).length, 0);
  assert.deepEqual(await tree(c.home), before);
});

test('pet uses each message time and owner-private visibility', async t => {
  const c = await setup(t);
  await put(c.sources.pet, await fs.readFile(new URL('./fixtures/pet/memory.json', import.meta.url), 'utf8'));
  const report = await c.manager.importExisting({ sources: c.sources });
  assert.equal(report.ok, true); assert.equal(source(report, 'pet').imported, 2);
  assert.deepEqual(c.rows('memory_events').map(row => [row.occurred_at,row.visibility,row.direction]), [[NOW-DAY,'owner-private','incoming'],[NOW-20*DAY,'owner-private','outgoing']]);
});

test('repeat imports skip ledger entries even after their target is physically removed and the source moved', async t => {
  const c = await setup(t); await qqFixture(c.sources);
  await c.manager.importExisting({ sources: c.sources });
  await c.database.write(db => db.exec('DELETE FROM memory_events; DELETE FROM memory_items; DELETE FROM diary_entries'));
  const moved = join(c.home,'relocated'); await fs.cp(c.sources.aurabot,moved,{recursive:true});
  const report = await c.manager.importExisting({ sources: {...c.sources, aurabot:moved} });
  assert.equal(source(report,'aurabot').skipped,4); assert.equal(source(report,'aurabot').imported,0);
  assert.equal(c.rows('import_ledger').length,4); assert.equal(c.rows('memory_events').length,0);
});

test('bad JSONL rolls back its whole file while independent files and pet still commit', async t => {
  const c = await setup(t); await qqFixture(c.sources);
  await fs.appendFile(join(c.sources.aurabot,'chatlog','recent.jsonl'),'not json with secret-account');
  await put(c.sources.pet,{ k:{ p:{ messages:[{role:'user',content:'valid pet',ts:NOW}] } } });
  const report=await c.manager.importExisting({sources:c.sources});
  assert.equal(report.ok,false); assert.equal(source(report,'aurabot').code,'INVALID_SOURCE');
  assert.equal(c.rows('memory_events').length,1); assert.equal(c.rows('memory_items').length,1); assert.equal(c.rows('import_ledger').length,3);
  assert.doesNotMatch(JSON.stringify(report),/secret-account|valid pet|relocated|[A-Z]:\\/);
});

test('a constraint error rolls back ledger and memory atomically for a whole batch', async t => {
  const c=await setup(t); await qqFixture(c.sources);
  await c.database.write(db=>db.exec(`CREATE TRIGGER fail_fixture BEFORE INSERT ON import_ledger WHEN NEW.target_type='event' BEGIN SELECT RAISE(ABORT,'sensitive details'); END`));
  const report=await c.manager.importExisting({sources:c.sources});
  assert.equal(report.ok,false); assert.equal(c.rows('memory_events').length,0); assert.equal(c.rows('import_ledger').length,2);
  assert.doesNotMatch(JSON.stringify(report),/sensitive details/);
});

test('source snapshots include only imported files and sanitized protected manifests',async t=>{
  const c=await setup(t); await qqFixture(c.sources); await put(join(c.sources.aurabot,'media','private.jpg'),'not imported');
  await c.manager.importExisting({sources:c.sources});
  const names=await tree(join(c.paths.backups,'import-sources')); assert.ok(names.some(name=>name.endsWith('manifest.json'))); assert.ok(!names.some(name=>name.includes('private.jpg')));
  const manifestName=names.find(name=>name.endsWith('manifest.json'));
  const manifest=JSON.parse(await fs.readFile(join(c.paths.backups,'import-sources',manifestName),'utf8'));
  assert.equal(manifest.protected,true); assert.equal(manifest.files.length,3);
  for(const entry of manifest.files){ assert.match(entry.sha256,/^[a-f0-9]{64}$/); assert.equal(typeof entry.size,'number'); assert.ok(!entry.name.includes(':')); }
  assert.doesNotMatch(JSON.stringify(manifest),/recent fixture|long fixture|[A-Z]:\\/);
});

test('backup failure blocks that source and remains sanitized',async t=>{
  const c=await setup(t,{io:{...fs,mkdir:async()=>{throw new Error('secret source path');}}}); await qqFixture(c.sources);
  const report=await c.manager.importExisting({sources:c.sources}); assert.equal(report.ok,false); assert.equal(source(report,'aurabot').code,'BACKUP_FAILED');
  assert.equal(c.rows('import_ledger').length,0); assert.equal(c.rows('memory_events').length,0); assert.doesNotMatch(JSON.stringify(report),/secret source path/);
});

test('source mutation during snapshot reports SOURCE_CHANGED with zero source writes',async t=>{
  let mutate;
  const c=await setup(t,{io:{...fs,writeFile:async(...args)=>{await fs.writeFile(...args);if(mutate){const run=mutate; mutate=null;await run();}}}}); await qqFixture(c.sources);
  mutate=()=>fs.appendFile(join(c.sources.aurabot,'memories.json'),' ');
  const report=await c.manager.importExisting({sources:c.sources}); assert.equal(source(report,'aurabot').code,'SOURCE_CHANGED'); assert.equal(c.rows('import_ledger').length,0);
});

test('recognized Douyin SQLite notes import once using official consistent snapshots',async t=>{
  const c=await setup(t); c.sources.douyin=join(c.home,'shared.sqlite'); sqliteFixture(c.sources.douyin);
  const before=digest(await fs.readFile(c.sources.douyin));
  let report=await c.manager.importExisting({sources:c.sources}); assert.equal(report.ok,true); assert.equal(source(report,'douyin').imported,1);
  const item=c.rows('memory_items')[0]; assert.equal(item.expires_at,NOW+30*DAY); assert.equal(item.visibility,'owner-private');
  report=await c.manager.importExisting({sources:c.sources}); assert.equal(source(report,'douyin').skipped,1);assert.equal(c.rows('memory_items').length,1);
  const names=await tree(join(c.paths.backups,'import-sources')); const snapshot=names.find(name=>name.endsWith('shared.sqlite'));
  const db=new DatabaseSync(join(c.paths.backups,'import-sources',snapshot),{readOnly:true}); assert.equal(db.prepare('SELECT count(*) n FROM memory_entries').get().n,1);db.close();
  assert.equal(digest(await fs.readFile(c.sources.douyin)),before);
});

test('unsupported or failed optional Douyin never blocks the core sources',async t=>{
  const c=await setup(t); await qqFixture(c.sources); c.sources.douyin=join(c.home,'unknown.sqlite');sqliteFixture(c.sources.douyin,false);
  let report=await c.manager.importExisting({sources:c.sources}); assert.equal(report.ok,true);assert.equal(source(report,'douyin').status,'optional-unsupported');
  await fs.writeFile(c.sources.douyin,'not sqlite');report=await c.manager.importExisting({sources:c.sources});assert.equal(report.ok,true);assert.equal(source(report,'douyin').status,'optional-failed');
});

test('service exposes importExisting with default DSH-home paths and scan only, never a model call',async t=>{
  const home=createTempHome(), ctx=createFakeContext();let calls=0;
  await apply(ctx,{}, {dshHome:home,clock:{now:()=>NOW},reviewModel:{review:()=>{calls++;throw Error('no model');}}});
  const service=ctx.get('dafeiyuMemory');t.after(()=>service.dispose());
  service.importManager.env = {};
  await put(join(home,'douyin-browser','runtime-location.json'),{version:1,stateDir:home,memoryDbPath:join(home,'missing.sqlite')});
  await qqFixture({aurabot:join(home,'plugins-data','aurabot')});
  const report=await service.importExisting();assert.equal(report.ok,true);assert.equal(calls,0);
  assert.equal(service.database.read(db=>db.prepare('SELECT count(*) n FROM import_ledger').get().n),4);
});

test('dryRun deduplicates stable message IDs across files and honors purge tombstones',async t=>{
  const c=await setup(t);const record={id:'stable-message',t:NOW,chatId:'private:fixture',who:'fixture',text:'stable fixture'};
  await put(join(c.sources.aurabot,'chatlog','a.jsonl'),JSON.stringify(record));
  await put(join(c.sources.aurabot,'chatlog','b.jsonl'),JSON.stringify(record));
  let report=await c.manager.importExisting({sources:c.sources,dryRun:true});assert.equal(source(report,'aurabot').planned,1);assert.equal(source(report,'aurabot').skipped,1);
  await c.manager.importExisting({sources:c.sources});const event=c.rows('memory_events')[0];
  await c.database.write(db=>{db.exec('DELETE FROM import_ledger; DELETE FROM memory_events');db.prepare('INSERT INTO purge_ledger VALUES (?,\'event\',?)').run(digest(`event\0${event.external_key}`),NOW);});
  report=await c.manager.importExisting({sources:c.sources,dryRun:true});assert.equal(source(report,'aurabot').planned,0);assert.equal(source(report,'aurabot').skipped,2);
  report=await c.manager.importExisting({sources:c.sources});assert.equal(source(report,'aurabot').imported,0);assert.equal(c.rows('memory_events').length,0);
});

test('capacity degradation prevents source backups and import mutations but permits dryRun',async t=>{
  const c=await setup(t,{canGrow:()=>false});await qqFixture(c.sources);
  let report=await c.manager.importExisting({sources:c.sources,dryRun:true});assert.equal(report.ok,true);assert.equal(source(report,'aurabot').planned,4);
  report=await c.manager.importExisting({sources:c.sources});assert.equal(report.ok,false);assert.equal(source(report,'aurabot').code,'CAPACITY_LIMIT');
  assert.equal(c.rows('import_ledger').length,0);assert.deepEqual(await tree(c.paths.backups),[]);
});

test('invalid import arguments are sanitized without invoking caller accessors',async t=>{
  const c=await setup(t);let calls=0;
  for(const input of [null,[],{dryRun:'yes'},{sources:{unknown:'x'}},{sources:{pet:'relative'}},Object.defineProperty({},'sources',{get(){calls++;throw Error('sensitive-options');}})]){
    await assert.rejects(c.manager.importExisting(input),error=>error.code==='MEMORY_INVALID_INPUT'&&!String(error.stack).includes('sensitive-options'));
  }
  assert.equal(calls,0);
});

test('service disposal waits for pending importer IO before closing its database',async t=>{
  const home=createTempHome(),ctx=createFakeContext();await apply(ctx,{}, {dshHome:home,clock:{now:()=>NOW}});
  const service=ctx.get('dafeiyuMemory');await qqFixture({aurabot:join(home,'plugins-data','aurabot')});
  let release,signal;const gate=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{signal=resolve;});
  const original=service.importManager.io;
  service.importManager.io={...original,mkdir:async(...args)=>{signal();await gate;return original.mkdir(...args);}};
  const importing=service.importExisting();await entered;let closed=false;const disposing=service.dispose().then(()=>{closed=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false);release();
  const report=await importing;await disposing;assert.equal(source(report,'aurabot').imported,4);
});

test('WAL-only SQLite records are included by official snapshot without changing any source bytes',async t=>{
  const c=await setup(t);c.sources.douyin=join(c.home,'wal.sqlite');sqliteFixture(c.sources.douyin);
  const writer=new DatabaseSync(c.sources.douyin);t.after(()=>writer.close());writer.exec('PRAGMA journal_mode=WAL');
  writer.prepare("UPDATE memory_entries SET content='wal fixture' WHERE id=1").run();
  const before=await Promise.all(['','-wal'].map(async suffix=>digest(await fs.readFile(c.sources.douyin+suffix))));
  const report=await c.manager.importExisting({sources:c.sources});assert.equal(source(report,'douyin').imported,1);assert.equal(c.rows('memory_items')[0].content,'wal fixture');
  const names=await tree(join(c.paths.backups,'import-sources'));const snapshot=names.find(name=>name.endsWith('shared.sqlite'));
  const db=new DatabaseSync(join(c.paths.backups,'import-sources',snapshot),{readOnly:true});assert.equal(db.prepare('SELECT content FROM memory_entries').get().content,'wal fixture');db.close();
  assert.deepEqual(await Promise.all(['','-wal'].map(async suffix=>digest(await fs.readFile(c.sources.douyin+suffix)))),before);
});

test('SQLite notes with unverified column types are optional-unsupported without guessed mappings',async t=>{
  const c=await setup(t);c.sources.douyin=join(c.home,'wrong-types.sqlite');sqliteFixture(c.sources.douyin);
  const db=new DatabaseSync(c.sources.douyin);db.exec('ALTER TABLE memory_entries RENAME TO wrong_entries; CREATE TABLE memory_entries AS SELECT * FROM wrong_entries');db.close();
  const report=await c.manager.importExisting({sources:c.sources});assert.equal(report.ok,true);assert.equal(source(report,'douyin').status,'optional-unsupported');assert.equal(c.rows('import_ledger').length,0);
});

test('a late source mutation while waiting for the write queue rolls back before ledger or body writes',async t=>{
  let release,entered;
  const gate=new Promise(resolve=>{release=resolve;}),snapshotReady=new Promise(resolve=>{entered=resolve;});
  const c=await setup(t,{io:{...fs,writeFile:async(file,...args)=>{await fs.writeFile(file,...args);if(file.endsWith('manifest.json'))entered();}}});await qqFixture(c.sources);
  const hold=c.database.writeQueue.enqueue(()=>gate);
  const importing=c.manager.importExisting({sources:c.sources});await snapshotReady;
  await fs.appendFile(join(c.sources.aurabot,'memories.json'),' ');release();await hold;
  const report=await importing;assert.equal(source(report,'aurabot').code,'SOURCE_CHANGED');assert.equal(c.rows('import_ledger').length,0);
});

test('incoming QQ nickname bot with a sender ID is not misclassified as an outgoing reply',async t=>{
  const c=await setup(t);await put(join(c.sources.aurabot,'chatlog','nick.jsonl'),JSON.stringify({t:NOW,chatId:'private:fixture',who:'bot',uid:'fixture-sender',text:'nickname fixture'}));
  await c.manager.importExisting({sources:c.sources});assert.equal(c.rows('memory_events')[0].direction,'incoming');
});

test('object-valued source IDs fail the whole batch instead of collapsing distinct IDs into one ledger key',async t=>{
  const c=await setup(t);await put(join(c.sources.aurabot,'memories.json'),{items:[{id:{invalid:true},text:'bad id fixture',at:NOW}]});
  const report=await c.manager.importExisting({sources:c.sources});assert.equal(report.ok,false);assert.equal(source(report,'aurabot').code,'INVALID_SOURCE');assert.equal(c.rows('import_ledger').length,0);
});

test('source changes are checked even when a snapshot operation also fails',async t=>{
  let mutate;
  const c=await setup(t,{io:{...fs,writeFile:async(...args)=>{if(mutate){await mutate();mutate=null;throw Error('sensitive backup details');}return fs.writeFile(...args);}}});await qqFixture(c.sources);
  mutate=()=>fs.appendFile(join(c.sources.aurabot,'memories.json'),' ');
  const report=await c.manager.importExisting({sources:c.sources});assert.equal(source(report,'aurabot').code,'SOURCE_CHANGED');assert.equal(c.rows('import_ledger').length,0);
});

test('default Douyin discovery uses the verified runtime-location and environment precedence entirely within temporary fixtures',async t=>{
  const c=await setup(t,{env:{}}),memoryDir=join(c.home,'configured-memory');await fs.mkdir(memoryDir);
  const file=join(memoryDir,'shared.sqlite');sqliteFixture(file);
  await put(join(c.home,'douyin-browser','runtime-location.json'),{version:1,stateDir:c.home,memoryDir});
  let report=await c.manager.importExisting({dryRun:true});assert.equal(source(report,'douyin').planned,1);assert.equal(c.rows('import_ledger').length,0);
  const unknown=join(c.home,'override.sqlite');sqliteFixture(unknown,false);c.manager.env={DEEPSEEK_SHARED_MEMORY_DB:unknown};
  report=await c.manager.importExisting({dryRun:true});assert.equal(source(report,'douyin').status,'optional-unsupported');
  await put(join(c.home,'douyin-browser','runtime-location.json'),{version:1,stateDir:'relative',memoryDir});c.manager.env={};
  report=await c.manager.importExisting({dryRun:true});assert.equal(source(report,'douyin').status,'optional-failed');assert.equal(source(report,'douyin').code,'INVALID_SOURCE');
});

async function walWithoutShm(c) {
  const live=join(c.home,'fixture-writer.sqlite');sqliteFixture(live);
  const writer=new DatabaseSync(live);writer.exec('PRAGMA journal_mode=WAL');
  writer.prepare("UPDATE memory_entries SET content='isolated WAL fixture' WHERE id=1").run();
  const directory=join(c.home,'sqlite-source');await fs.mkdir(directory);
  c.sources.douyin=join(directory,'shared.sqlite');
  for(const suffix of ['','-wal']) await fs.copyFile(live+suffix,c.sources.douyin+suffix);
  writer.close();return directory;
}
async function directoryState(directory) {
  const names=await tree(directory);
  return Promise.all(names.map(async name=>[name,digest(await fs.readFile(join(directory,name)))]));
}

test('Douyin dryRun leaves a main+WAL source without SHM byte-for-byte unchanged and cleans scratch copies',async t=>{
  const scratch=[];
  const c=await setup(t,{io:{...fs,mkdtemp:async(...args)=>{const path=await fs.mkdtemp(...args);scratch.push(path);return path;}}});
  const directory=await walWithoutShm(c),before=await directoryState(directory);
  const report=await c.manager.importExisting({sources:{douyin:c.sources.douyin},dryRun:true});
  assert.equal(source(report,'douyin').planned,1);assert.deepEqual(await directoryState(directory),before);
  assert.equal(c.rows('import_ledger').length,0);assert.deepEqual(await tree(c.paths.backups),[]);
  assert.ok(scratch.length);for(const path of scratch)await assert.rejects(fs.access(path),{code:'ENOENT'});
});

test('Douyin actual import reads WAL through a protected official backup without opening the source SQLite',async t=>{
  const c=await setup(t),directory=await walWithoutShm(c),before=await directoryState(directory);
  const report=await c.manager.importExisting({sources:{douyin:c.sources.douyin}});
  assert.equal(source(report,'douyin').imported,1);assert.equal(c.rows('memory_items')[0].content,'isolated WAL fixture');
  assert.deepEqual(await directoryState(directory),before);
  const names=await tree(join(c.paths.backups,'import-sources'));const snapshot=names.find(name=>name.endsWith('shared.sqlite'));
  const db=new DatabaseSync(join(c.paths.backups,'import-sources',snapshot),{readOnly:true});
  assert.equal(db.prepare('SELECT content FROM memory_entries').get().content,'isolated WAL fixture');db.close();
});

test('Douyin source SHM presence changes during copying are SOURCE_CHANGED with no ledger writes',async t=>{
  let sourceFile,changed=false;
  const c=await setup(t,{io:{...fs,writeFile:async(...args)=>{await fs.writeFile(...args);if(sourceFile&&!changed){changed=true;await fs.writeFile(sourceFile+'-shm','external fixture');}}}});
  await walWithoutShm(c);sourceFile=c.sources.douyin;
  const report=await c.manager.importExisting({sources:{douyin:sourceFile},dryRun:true});
  assert.equal(source(report,'douyin').code,'SOURCE_CHANGED');assert.equal(c.rows('import_ledger').length,0);
});

test('Aurabot inactive and superseded facts only produce skipped-inactive ledger entries',async t=>{
  const c=await setup(t),file=join(c.sources.aurabot,'memories.json');
  const items=[{id:'old-fact',text:'inactive fixture body',at:NOW,invalidAt:NOW},{id:'superseded-fact',text:'superseded fixture body',at:NOW,supersededBy:'new-fact'},{id:'new-fact',text:'active fixture body',at:NOW}];
  await put(file,{items});
  let report=await c.manager.importExisting({sources:{aurabot:c.sources.aurabot},dryRun:true});
  assert.equal(source(report,'aurabot').planned,1);assert.equal(source(report,'aurabot').skipped,2);assert.equal(c.rows('import_ledger').length,0);
  report=await c.manager.importExisting({sources:{aurabot:c.sources.aurabot}});
  assert.equal(source(report,'aurabot').imported,1);assert.equal(source(report,'aurabot').skipped,2);
  assert.deepEqual(c.rows('memory_items').map(row=>row.content),['active fixture body']);
  assert.deepEqual(c.rows('import_ledger').map(row=>row.result).sort(),['imported','skipped-inactive','skipped-inactive']);
  assert.ok(c.rows('import_ledger').filter(row=>row.result==='skipped-inactive').every(row=>row.target_id===null));
  assert.doesNotMatch(JSON.stringify(c.rows('import_ledger')),/inactive fixture body|superseded fixture body/);
  delete items[0].invalidAt;delete items[1].supersededBy;await put(file,{items});
  report=await c.manager.importExisting({sources:{aurabot:c.sources.aurabot}});
  assert.equal(source(report,'aurabot').imported,0);assert.equal(source(report,'aurabot').skipped,3);assert.equal(c.rows('memory_items').length,1);
});

test('an inactive Aurabot fact restored after dryRun can import if no ledger has been committed',async t=>{
  const c=await setup(t),file=join(c.sources.aurabot,'memories.json'),row={id:'restorable-fact',text:'restored fixture',at:NOW,invalidAt:NOW};
  await put(file,{items:[row]});let report=await c.manager.importExisting({sources:{aurabot:c.sources.aurabot},dryRun:true});
  assert.equal(source(report,'aurabot').planned,0);assert.equal(source(report,'aurabot').skipped,1);
  delete row.invalidAt;await put(file,{items:[row]});report=await c.manager.importExisting({sources:{aurabot:c.sources.aurabot}});
  assert.equal(source(report,'aurabot').imported,1);assert.equal(c.rows('memory_items')[0].content,'restored fixture');
});

test('two different object pet IDs fail the whole file with stable sanitized errors and zero rows',async t=>{
  const c=await setup(t);await put(c.sources.pet,{k:{p:{messages:[{id:{first:1},role:'user',content:'first private fixture',ts:NOW},{id:{second:2},role:'assistant',content:'second private fixture',ts:NOW}]}}});
  for(const dryRun of [true,false]) {
    const report=await c.manager.importExisting({sources:{pet:c.sources.pet},dryRun});
    assert.equal(report.ok,false);assert.equal(source(report,'pet').code,'INVALID_SOURCE');assert.equal(source(report,'pet').imported,0);
    assert.equal(c.rows('memory_events').length,0);assert.equal(c.rows('import_ledger').length,0);
    assert.doesNotMatch(JSON.stringify(report),/first private|second private|first:|second:/);
  }
});

test('pet IDs accept only nonempty strings or safe integers before namespace conversion',async t=>{
  const c=await setup(t);
  for(const id of [[],{},'', '  ',null,true,1.5,Number.MAX_SAFE_INTEGER+1]) {
    await put(c.sources.pet,{k:{p:{messages:[{id,role:'user',content:'invalid fixture',ts:NOW}]}}});
    const report=await c.manager.importExisting({sources:{pet:c.sources.pet},dryRun:true});assert.equal(source(report,'pet').code,'INVALID_SOURCE');
  }
  const row={role:'user',content:'stable pet fixture',ts:NOW};
  await put(c.sources.pet,{k:{p:{messages:[{...row,id:7},{...row,id:'7'},{...row,id:'named-id'},{...row}]}}});
  let report=await c.manager.importExisting({sources:{pet:c.sources.pet}});assert.equal(source(report,'pet').imported,3);assert.equal(source(report,'pet').skipped,1);
  report=await c.manager.importExisting({sources:{pet:c.sources.pet}});assert.equal(source(report,'pet').imported,0);assert.equal(source(report,'pet').skipped,4);
});

test('pet ID accessors are rejected before invocation or string conversion',async t=>{
  const {parsePet}=await import('../src/importers/pet.js');let calls=0;
  const row={role:'user',content:'accessor fixture',ts:NOW};Object.defineProperty(row,'id',{enumerable:true,get(){calls++;throw Error('sensitive fixture getter');}});
  const original=JSON.parse;t.mock.method(JSON,'parse',value=>value==='pet-getter-fixture'?{k:{p:{messages:[row]}}}:original(value));
  assert.throws(()=>parsePet(Buffer.from('pet-getter-fixture'),'memory.json',resolveConfig()),{code:'INVALID_SOURCE'});assert.equal(calls,0);
});

test('Douyin failed scratch writes clean the temporary directory and preserve the complete source state',async t=>{
  let scratch;
  const c=await setup(t,{io:{...fs,mkdtemp:async(...args)=>{scratch=await fs.mkdtemp(...args);return scratch;},writeFile:async(file,...args)=>{if(scratch&&file.startsWith(scratch))throw Error('sensitive scratch fixture');return fs.writeFile(file,...args);}}});
  const directory=await walWithoutShm(c),before=await directoryState(directory);
  const report=await c.manager.importExisting({sources:{douyin:c.sources.douyin},dryRun:true});
  assert.equal(report.ok,true);assert.equal(source(report,'douyin').status,'optional-failed');assert.equal(source(report,'douyin').code,'IMPORT_FAILED');
  assert.deepEqual(await directoryState(directory),before);await assert.rejects(fs.access(scratch),{code:'ENOENT'});
  assert.equal(c.rows('import_ledger').length,0);assert.deepEqual(await tree(c.paths.backups),[]);assert.doesNotMatch(JSON.stringify(report),/sensitive scratch/);
});

test('Douyin copying detects changes to every captured main/WAL/SHM hash or existence',async t=>{
  for(const suffix of ['','-wal','-shm']) {
    let mutate;
    const c=await setup(t,{io:{...fs,writeFile:async(...args)=>{await fs.writeFile(...args);if(mutate){const run=mutate;mutate=null;await run();}}}});
    await walWithoutShm(c);if(suffix==='-shm')await fs.writeFile(c.sources.douyin+'-shm','initial fixture');
    mutate=()=>fs.appendFile(c.sources.douyin+suffix,'externally changed fixture');
    const report=await c.manager.importExisting({sources:{douyin:c.sources.douyin},dryRun:true});assert.equal(source(report,'douyin').code,'SOURCE_CHANGED');assert.equal(c.rows('import_ledger').length,0);
  }
});
