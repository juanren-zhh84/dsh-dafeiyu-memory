import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, cpSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DafeiyuMemoryService } from '../src/service.js';
import { MemoryDatabase } from '../src/storage/database.js';
import { resolveMemoryPaths } from '../src/paths.js';
import { resolveConfig } from '../src/config.js';
import { createFakeContext } from './helpers/fake-context.js';
import { fakeAurabot } from './helpers/fake-aurabot.js';
import { setupConnector } from '../aurabot-module/dafeiyu-memory/index.mjs';
import { recallForPet, recordPetExchange } from '../integrations/dsh-pet/bridge.ts';
import { NOW, DAY } from './fixtures/events.js';

const discard = ({ mode, candidates }) => ({ ...(mode === 'short-term' ? { retain: [] } : {}), diary: [], discard: candidates.map(x => x.id) });
const retain = ({ mode, candidates }) => mode === 'short-term'
  ? { retain: candidates.map(x => ({ sourceIds: [x.id], kind: 'fact', content: x.content, importance: 0.8 })), diary: [], discard: [] }
  : discard({ mode, candidates });
async function assemble(t, review = discard) {
  const home = mkdtempSync(join(tmpdir(), 'memory-acceptance-'));
  const paths = resolveMemoryPaths({ dshHome: home });
  const time = { value: NOW }, clock = { now: () => time.value };
  const model = { review: async input => review(input) };
  const h = { home, time, model };
  const open = async () => {
    const database = await MemoryDatabase.open(paths.database);
    h.service = new DafeiyuMemoryService(createFakeContext(), { paths, database, config: resolveConfig(), clock, reviewModel: model });
    h.qq = fakeAurabot(join(home, 'qq-module')); h.qq.service = h.service;
    setupConnector(h.qq.api, { clock });
  };
  h.restart = async () => { h.qq.dispose(); await h.service.dispose(); await open(); };
  h.rows = table => h.service.database.read(db => db.prepare(`SELECT * FROM ${table}`).all());
  await open();
  t.after(async () => { h.qq.dispose(); await h.service.dispose(); rmSync(home, { recursive: true, force: true }); });
  return h;
}

const group = { kind: 'group', chatId: 'group:acceptance', groupId: 'acceptance', userId: 'friend-fixture', text: '春季聚会定在湖边', messageId: 'acceptance-group' };
const owner = { kind: 'private', chatId: 'private:owner-fixture', userId: 'owner-fixture', text: '湖边聚会' };

test('01 群事实经公开 QQ 连接器整理后可在主人私聊召回', async t => {
  const h = await assemble(t, retain);
  assert.equal(await h.qq.emit('message', group), false); await h.qq.tick();
  h.time.value += 7 * DAY; assert.equal((await h.service.runDueReviews()).completed, 1);
  assert.match(h.qq.context(owner), /春季聚会定在湖边/);
});
test('02 主人私聊原文不进入其他群的连接器上下文', async t => {
  const h = await assemble(t, retain);
  await h.qq.emit('message', { ...owner, text: '主人的私密安排', messageId: 'acceptance-secret' }); await h.qq.tick();
  h.time.value += 7 * DAY; await h.service.runDueReviews();
  assert.match(h.qq.context({ ...owner, text: '私密安排' }), /主人的私密安排/);
  assert.doesNotMatch(h.qq.context({ ...group, text: '私密安排' }), /主人的私密安排|owner-fixture/);
});
test('03 pet 通过实际桥接层跨平台召回并幂等回写成功对话', async t => {
  const h = await assemble(t, retain);
  await h.qq.emit('message', group); await h.qq.tick();
  assert.match(recallForPet(h.service, 'fish', '湖边聚会'), /春季聚会定在湖边/);
  const stamp = { exchangeId: 'acceptance-exchange', userAt: NOW, assistantAt: NOW + 1 };
  assert.equal(await recordPetExchange(h.service, 'fish', '喜欢蓝色鱼缸', '记住蓝色鱼缸', stamp), 'PET_MEMORY_RECORDED');
  await recordPetExchange(h.service, 'fish', '喜欢蓝色鱼缸', '记住蓝色鱼缸', stamp);
  assert.equal(h.service.status().events.active, 3);
  assert.match(h.qq.context({ ...owner, text: '蓝色鱼缸' }), /蓝色鱼缸/);
});
test('04 恰好七天整理且回收满七天才物理清理', async t => {
  const h = await assemble(t);
  await h.qq.emit('message', group); await h.qq.tick();
  h.time.value = NOW + 7 * DAY - 1; assert.equal((await h.service.runDueReviews()).completed, 0);
  h.time.value++; assert.equal((await h.service.runDueReviews()).completed, 1);
  h.time.value += 7 * DAY - 1; assert.equal((await h.service.purgeRecycleItem()).deleted, 0);
  h.time.value++; assert.equal((await h.service.purgeRecycleItem()).deleted, 1);
  assert.equal(h.service.status().events.recycle, 0);
});
test('05 晋升后完整三十天且召回不续期', async t => {
  const h = await assemble(t, retain); await h.qq.emit('message', group); await h.qq.tick();
  h.time.value += 7 * DAY; await h.service.runDueReviews();
  const before = h.rows('memory_items')[0];
  h.time.value += 30 * DAY - 1; h.qq.context(owner); await h.service.writeQueue.drain();
  assert.equal(h.rows('memory_items')[0].expires_at, before.promoted_at + 30 * DAY);
  assert.equal((await h.service.runDueReviews()).completed, 0);
  h.time.value++; assert.equal((await h.service.runDueReviews()).completed, 1);
  assert.equal(h.service.status().items.recycle, 1);
});
test('06 日记在一年后的所有自动清理后仍永久存在', async t => {
  const h = await assemble(t, retain); await h.qq.emit('message', group); await h.qq.tick();
  const diary = await h.service.promoteToDiary({ title: '纪念', body: '永久的湖边经历' });
  h.time.value += 7 * DAY; await h.service.runDueReviews();
  h.time.value += 365 * DAY; await h.service.runDueReviews(); await h.service.runMaintenance();
  h.time.value += 7 * DAY; await h.service.runMaintenance();
  assert.equal(h.service.status().diary, 1); assert.equal(h.rows('diary_entries')[0].id, diary.id);
  assert.match(recallForPet(h.service, 'fish', '永久湖边经历'), /永久的湖边经历/);
});
test('07 模型、备份和真实数据库事务故障均默认不删除', async t => {
  const h = await assemble(t, () => { throw Error('synthetic model failure'); });
  await h.qq.emit('message', group); await h.qq.tick(); h.time.value += 7 * DAY;
  assert.equal((await h.service.runDueReviews()).retried, 1); assert.equal(h.rows('memory_events').length, 1);
  h.model.review = async request => discard(request); h.time.value += DAY; await h.service.runDueReviews(); h.time.value += 7 * DAY;
  const backup = h.service.backupManager.createUnlocked;
  h.service.backupManager.createUnlocked = async () => { throw Object.assign(Error(), { code: 'MEMORY_BACKUP_FAILED' }); };
  await assert.rejects(h.service.purgeRecycleItem(), { code: 'MEMORY_BACKUP_FAILED' }); assert.equal(h.rows('memory_events').length, 1);
  h.service.backupManager.createUnlocked = backup;
  await h.service.database.write(db => db.exec("CREATE TRIGGER acceptance_no_delete BEFORE DELETE ON memory_events BEGIN SELECT RAISE(ABORT,'synthetic database failure'); END"));
  await assert.rejects(h.service.purgeRecycleItem(), { code: 'MEMORY_PURGE_FAILED' });
  assert.equal(h.rows('memory_events').length, 1); assert.equal(h.rows('purge_ledger').length, 0);
});
test('08 公开服务重复导入不增长且源文件哈希完全不变', async t => {
  const h = await assemble(t);
  const source = join(h.home, 'aurabot'); cpSync(new URL('./fixtures/aurabot', import.meta.url), source, { recursive: true });
  const pet = join(h.home, 'pet.json'); cpSync(new URL('./fixtures/pet/memory.json', import.meta.url), pet);
  const files = [join(source, 'memories.json'), join(source, 'diary.json'), join(source, 'chatlog/recent.jsonl'), pet];
  const hashes = () => files.map(p => createHash('sha256').update(readFileSync(p)).digest('hex'));
  const before = hashes(); const options = { sources: { aurabot: source, pet } };
  const first = await h.service.importExisting(options); assert.equal(first.ok, true); assert.ok(first.sources.some(x => x.imported));
  const counts = h.service.status(); const second = await h.service.importExisting(options);
  assert.equal(second.ok, true); assert.ok(second.sources.every(x => x.imported === 0));
  const after = h.service.status();
  for (const key of ['events', 'items', 'diary']) assert.deepEqual(after[key], counts[key]);
  assert.deepEqual(hashes(), before);
});
test('09 关闭并重新组装公开服务后恢复到期任务且重复启动不重复', async t => {
  const h = await assemble(t, retain); await h.qq.emit('message', group); await h.qq.tick();
  h.time.value += 7 * DAY; await h.service.reviewLifecycle.scan();
  await h.restart(); assert.equal((await h.service.runDueReviews()).completed, 1);
  await h.restart(); assert.equal((await h.service.runDueReviews()).completed, 0);
  assert.equal(h.service.status().items.active, 1); assert.equal(h.rows('review_jobs').length, 1);
});
test('10 未安装抖音时核心服务、QQ 与 pet 完整工作且不创建其目录', async t => {
  const h = await assemble(t, retain);
  const report = await h.service.importExisting({ sources: { aurabot: join(h.home, 'missing-aurabot'), pet: join(h.home, 'missing-pet') } });
  assert.equal(report.ok, true); assert.equal(report.sources.length, 2);
  await h.qq.emit('message', group); await h.qq.tick(); h.time.value += 7 * DAY; await h.service.runDueReviews();
  assert.match(recallForPet(h.service, 'fish', '湖边聚会'), /春季聚会定在湖边/);
  assert.equal(existsSync(join(h.home, 'douyin')), false);
});
