# 大肥鱼统一记忆系统 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付一个本机 DSH 核心插件，使 Aurabot QQ 私聊、QQ群聊和 dsh-pet 在不改变现有模型配置的前提下共享受隐私边界约束的短期记忆、长期记忆和永久日记。

**Architecture:** 仓库根目录就是可安装的 `dsh-dafeiyu-memory` bundle。宿主插件通过 Cordis 注册同步只读、异步写入的 `dafeiyuMemory` 服务；Node 24 内置 `node:sqlite` 保存数据，所有写事务进入单进程队列。Aurabot 使用公开用户模块接入；dsh-pet 使用仓库内的版本锁定补丁生成独立源码副本，不直接修改已安装包。模型只输出经过严格校验的整理决定，确定性代码掌握事务、状态迁移、备份和物理删除。

**Tech Stack:** Node.js 24.22.1、ESM JavaScript、`node:sqlite`、`node:test`、Cordis/DeepSeek Harness 0.2.1-rc.2、Aurabot module API v1、PowerShell 7、React 18（仅使用 DSH 浏览器端内置运行时）

## Global Constraints

- 实施依据是 `docs/superpowers/specs/2026-10-27-dafeiyu-unified-memory-design.md`；本计划不能降低其中的数据保留、隐私或失败保护。
- 不修改模型供应商、模型名称、推理强度、上下文窗口或 API Key。整理任务每次读取 `agentDefaultModel.currentSelection()`，再调用 `ctx.llm.stream()`。
- 不接入抖音群聊、抖音开放平台或 `dsh-douyin-scroll`。抖音好友私信/观看经历只在核心验收全部通过后单独评估。
- 不直接修改 `$DSH_HOME/profiles/desktop/node_modules`。dsh-pet 的改动必须以可复核补丁应用到独立源码副本。
- 自动测试只使用临时目录、合成消息和假模型，不向真实 QQ 或抖音发送消息。
- 所有 Git 提交信息使用中文；每个任务单独提交，任务未通过其验证命令不得提交。
- 时间统一为 UTC 毫秒；测试注入 `clock.now()`，不得依赖真实等待。
- 日志、状态接口和错误报告不写对话正文、账号凭据、完整来源对象或内部绝对路径。

## Repository Map

```text
dsh-dafeiyu-memory/
├── .gitignore
├── package.json
├── package-lock.json
├── cordis.patch.yml
├── client.js
├── README.md
├── src/
│   ├── index.js
│   ├── config.js
│   ├── paths.js
│   ├── service.js
│   ├── contracts.js
│   ├── storage/
│   │   ├── database.js
│   │   ├── migrations.js
│   │   ├── schema.sql
│   │   └── write-queue.js
│   ├── memory/
│   │   ├── repository.js
│   │   ├── privacy.js
│   │   ├── tokenize.js
│   │   ├── rank.js
│   │   └── recall.js
│   ├── review/
│   │   ├── model-client.js
│   │   ├── protocol.js
│   │   ├── lifecycle.js
│   │   └── scheduler.js
│   ├── maintenance/
│   │   ├── backup.js
│   │   ├── capacity.js
│   │   ├── purge.js
│   │   └── spool.js
│   ├── importers/
│   │   ├── index.js
│   │   ├── aurabot.js
│   │   ├── pet.js
│   │   └── douyin.js
│   └── management/
│       ├── routes.js
│       └── projection.js
├── aurabot-module/
│   └── dafeiyu-memory/
│       ├── index.mjs
│       └── spool.mjs
├── integrations/
│   └── dsh-pet/
│       ├── README.md
│       ├── bridge.ts
│       └── patches/
│           └── 0.3.8-unified-memory.patch
├── scripts/
│   ├── install-aurabot-module.ps1
│   ├── prepare-pet-source.ps1
│   └── verify-local-install.ps1
└── test/
    ├── helpers/
    ├── fixtures/
    ├── storage.test.js
    ├── repository.test.js
    ├── recall.test.js
    ├── review-protocol.test.js
    ├── lifecycle.test.js
    ├── maintenance.test.js
    ├── importers.test.js
    ├── aurabot-connector.test.js
    ├── pet-patch.test.js
    ├── management.test.js
    └── acceptance.test.js
```

---

### Task 1: 建立可安装插件骨架和稳定服务契约

**Files:**
- Create: `.gitignore`
- Create: `package.json`
- Create: `package-lock.json`
- Create: `cordis.patch.yml`
- Create: `src/index.js`
- Create: `src/config.js`
- Create: `src/paths.js`
- Create: `src/contracts.js`
- Create: `src/service.js`
- Create: `test/helpers/fake-context.js`
- Create: `test/plugin-lifecycle.test.js`

**Interfaces:**
- Consumes: Cordis `Service`、`ctx.effect()`、`resolveDshHome()`。
- Produces: `ctx.get('dafeiyuMemory')`；公开方法固定为 `recordEvent()`、`recall()`、`status()`、`search()`、`importExisting()`、`runDueReviews()`、`backup()`、`restoreRecycleItem()`、`purgeRecycleItem()`、`promoteToDiary()` 和 `dispose()`。
- `recall()` 必须同步返回投影文本，因为 Aurabot `api.context()` 只接受同步函数；其余写操作返回 Promise。

- [ ] 写 `test/plugin-lifecycle.test.js`：断言 `apply()` 注册名为 `dafeiyuMemory` 的服务；调用 effect disposer 后，服务拒绝新写入且 `dispose()` 幂等。
- [ ] 运行 `node --test test/plugin-lifecycle.test.js`，确认因入口文件不存在而失败。
- [ ] 创建 ESM 包清单，声明 Node `>=24.0.0`，把 Cordis、`dsh-home-paths`、`dsh-llm`、`dsh-agent-default-model` 和 `dsh-host-webserver` 列为 peer dependencies；`npm test` 使用 Node 测试运行器。运行 `npm install` 生成并提交锁文件；`.gitignore` 排除 `node_modules/`、`*.sqlite*`、备份、spool、报告和测试临时目录。
- [ ] 在 `src/config.js` 固定并校验默认值：短期 7 天、长期 30 天、回收站 7 天、软上限 1 GiB、告警线 80%、召回配额 8/6/3、整理批量上限、超时和重试退避；低于安全下限的容量配置直接报错。
- [ ] 在 `src/paths.js` 只从 `resolveDshHome()` 或测试显式注入的根路径构造 `memory.sqlite`、`backups/`、`spool/`、`reports/`，禁止落到安装目录。
- [ ] `DafeiyuMemoryService` 继承 `Service` 并调用 `super(ctx, 'dafeiyuMemory')`；`apply()` 只负责组装依赖，所有计时器和关闭动作通过一个 `ctx.effect()` disposer 收口。
- [ ] 运行 `node --test test/plugin-lifecycle.test.js` 和 `npm test`，确认通过。
- [ ] 提交：`工程：初始化统一记忆插件骨架`

### Task 2: 建立 SQLite 模式、迁移和串行写队列

**Files:**
- Create: `src/storage/schema.sql`
- Create: `src/storage/migrations.js`
- Create: `src/storage/database.js`
- Create: `src/storage/write-queue.js`
- Create: `test/helpers/temp-home.js`
- Create: `test/storage.test.js`
- Modify: `src/service.js`

**Interfaces:**
- Consumes: `DatabaseSync` from `node:sqlite`。
- Produces: `MemoryDatabase.open(path)`、`read(fn)`、`write(fn)`、`transaction(fn)`、`checkpoint()`、`close()`；`WriteQueue.enqueue(job)`、`drain()`、`close()`。

- [ ] 先写失败测试覆盖：首次建库、重复启动不重复迁移、`PRAGMA foreign_keys=ON`、WAL、`busy_timeout`、STRICT 表、唯一 `external_key`、非法状态/可见性被约束拒绝、队列严格按提交顺序执行、关闭等待已入队短事务。
- [ ] 运行 `node --test test/storage.test.js`，确认表或模块缺失导致失败。
- [ ] `schema.sql` 一次建立 `memory_events`、`memory_items`、`diary_entries`、`review_jobs`、`import_ledger`、`purge_ledger`、`schema_meta`，并为到期扫描、会话检索、状态与时间建立索引。
- [ ] `migrations.js` 使用 `PRAGMA user_version` 顺序升级；升级前由调用方先备份，任何迁移失败回滚并保留原库，不创建替代空库。
- [ ] `database.js` 打开后执行 `journal_mode=WAL`、`foreign_keys=ON`、`busy_timeout=5000`、`auto_vacuum=INCREMENTAL`；准备语句集中创建并在关闭时逐一 `close()`。
- [ ] 事务使用显式 `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`，禁止在事务函数里 `await`；模型调用不能进入该函数。
- [ ] 运行 `node --test test/storage.test.js`，再运行 `npm test`。
- [ ] 提交：`存储：建立记忆数据库与迁移机制`

### Task 3: 实现幂等写入和三层记忆仓储

**Files:**
- Create: `src/memory/repository.js`
- Create: `test/repository.test.js`
- Create: `test/fixtures/events.js`
- Modify: `src/contracts.js`
- Modify: `src/service.js`

**Interfaces:**
- Consumes: 经校验的 `MemoryEventInput`、长期记忆决定和日记决定。
- Produces: `insertEvent()`、`promoteEvents()`、`appendDiary()`、`moveToRecycle()`、`restoreRecycle()`、`findDueEvents()`、`findDueItems()`、`getStatusCounts()`。

- [ ] 写失败测试：同一 `external_key` 两次写入只产生一条；消息字段长度/枚举/时间非法时拒绝；媒体仅留下占位符和稳定引用；长期 `expires_at` 精确等于 `promoted_at + 30 天`；召回不改变该时间；日记修正只追加并设置 `supersedes_id`；回收恢复清空 `purge_due_at`。
- [ ] 运行 `node --test test/repository.test.js`，确认失败。
- [ ] 输入规范化只读取普通对象自有字段，限定正文、名称、来源引用和批量大小；外部稳定 ID 不存在时使用 `source + conversation_key + direction + occurred_at + normalized text` 的 SHA-256 指纹。
- [ ] `promoteEvents()` 在单事务中写长期/日记、移动该批原事件到回收站、写完成状态；任何引用不存在或版本变化都整批回滚。
- [ ] `purge_ledger` 只保存来源键哈希、删除时间和对象类别，绝不保存正文。
- [ ] 运行 `node --test test/repository.test.js` 和 `npm test`。
- [ ] 提交：`存储：实现幂等写入和记忆状态`

### Task 4: 实现中文检索、配额和隐私投影

**Files:**
- Create: `src/memory/tokenize.js`
- Create: `src/memory/privacy.js`
- Create: `src/memory/rank.js`
- Create: `src/memory/recall.js`
- Create: `test/recall.test.js`
- Modify: `src/service.js`

**Interfaces:**
- Consumes: `{ queryText, audience, conversationKind, conversationKey, actorKey, now }`。
- Produces: `{ short, long, diary, text }`，分别最多 8、6、3 条；`text` 是连接器可直接注入的无账号标识文本。

- [ ] 先写矩阵测试：主人私聊和 pet 可检索允许的跨平台内容；普通联系人私聊只能看到自己的会话和 public；群聊只能看到当前群、该群可见长期记忆、公开日记摘要及无正文行为限制；任何群都看不到主人私聊正文、账号或私密日记。
- [ ] 写排序测试：当前会话/人物精确匹配优先，其次中文二元字组和英文数字词相关度，再按重要度、新近度、不同日期召回数；回收站永不出现；三个层级分别截断而非共用一个不透明窗口。
- [ ] 运行 `node --test test/recall.test.js`，确认失败。
- [ ] `tokenize.js` 规范化空白和大小写，中文生成相邻二元字组，英文数字按词切分；不引入向量服务或网络依赖。
- [ ] `privacy.js` 先生成 SQL 候选范围，再对返回 DTO 二次过滤；只接受请求对象的自有字段，未知 audience 默认拒绝而不是回落到 owner。
- [ ] `recall()` 只读同步执行；召回统计作为可丢弃的异步写入排队，失败不能阻塞聊天，也不能延长长期到期时间。
- [ ] 运行 `node --test test/recall.test.js` 和 `npm test`。
- [ ] 提交：`检索：加入隐私投影与相关性排序`

### Task 5: 接入当前 DSH 模型并严格校验整理协议

**Files:**
- Create: `src/review/model-client.js`
- Create: `src/review/protocol.js`
- Create: `test/helpers/fake-llm.js`
- Create: `test/review-protocol.test.js`
- Modify: `src/index.js`
- Modify: `src/service.js`

**Interfaces:**
- Consumes: `ctx.agentDefaultModel.currentSelection()`、`ctx.llm.stream(options)` 和冻结的候选批次。
- Produces: `ReviewDecision`，只能含批次内 `sourceIds` 的 `retain`、`diary`、`discard`；失败抛出带稳定错误码的异常。

- [ ] 写失败测试覆盖：合法 JSON；Markdown 围栏、重复顶层键、继承属性、未知字段、越界 ID、同一 ID 重复归类、遗漏 ID、数量/长度超限、非法 importance/confidence、模型空文本、无终止帧、超时和 aborted/error finish。
- [ ] 运行 `node --test test/review-protocol.test.js`，确认失败。
- [ ] `model-client.js` 每次调用时读取当前选择，只复制 `provider`、`model` 和已有 `reasoningEffort`；不得调用 `saveSelection()`。请求设 `temperature: 0`、有限 `maxTokens` 和 `AbortSignal.timeout()`。
- [ ] 使用 `BlockAssembler` 消费流，只接受“零个 reasoning 块 + 一个 text 块 + stop”；模型输出先做重复成员检测，再 `JSON.parse`，再按自有字段和精确键集合验证。
- [ ] 协议要求每个候选 ID 恰好出现在 retain、diary 或 discard 一次；可见性由来源集合的最严格级别确定，模型不能提供或扩大 visibility。
- [ ] 插件 inject 声明 `llm` 和 `agentDefaultModel`，但聊天检索/记录不依赖模型调用成功。
- [ ] 运行 `node --test test/review-protocol.test.js` 和 `npm test`。
- [ ] 提交：`整理：校验模型决策并接入当前模型`

### Task 6: 实现 7 天、30 天和离线补处理生命周期

**Files:**
- Create: `src/review/lifecycle.js`
- Create: `src/review/scheduler.js`
- Create: `test/lifecycle.test.js`
- Modify: `src/service.js`
- Modify: `src/storage/schema.sql`

**Interfaces:**
- Consumes: 到期事件/长期记忆、`ReviewModel`、注入时钟和 scheduler。
- Produces: 可租约的 `review_jobs`，短期整理、长期终审、退避重试和启动补处理。

- [ ] 写失败测试覆盖边界：`7d - 1ms` 不整理、恰好 7 天可整理；长期从 `promoted_at` 精确 30 天到期；回收 7 天；关机期间到期的任务下次启动补跑；热重载/双 tick 不重复处理；租约过期可恢复。
- [ ] 写失败测试覆盖所有失败语义：模型失败、协议失败、事务失败、批次版本变化时原状态不变；成功后任务和记忆状态在一个事务内提交；退避达到上限后保持 failed 可手动重试，数据仍有效。
- [ ] 运行 `node --test test/lifecycle.test.js`，确认失败。
- [ ] 扫描先用唯一键创建 job；工作器在短事务中领取租约，事务外调用模型，再在第二个短事务中核对候选版本并落地。
- [ ] scheduler 启动立即 catch-up，之后用单个可释放 timer 周期扫描；`dispose()` 停止领取新任务、等待当前落地事务、释放租约并关闭。
- [ ] 运行 `node --test test/lifecycle.test.js` 和 `npm test`。
- [ ] 提交：`生命周期：实现七天和三十天整理调度`

### Task 7: 加入备份、回收站物理清理、容量保护和离线 spool

**Files:**
- Create: `src/maintenance/backup.js`
- Create: `src/maintenance/capacity.js`
- Create: `src/maintenance/purge.js`
- Create: `src/maintenance/spool.js`
- Create: `test/maintenance.test.js`
- Modify: `src/service.js`

**Interfaces:**
- Consumes: SQLite 数据库、目录容量、回收站到期项和 JSONL spool。
- Produces: 滚动备份、确定性 purge、checkpoint/增量回收、容量状态和 `drainSpool()`。

- [ ] 写失败测试：官方 SQLite backup 成功后才允许物理删除；备份失败时删除为零；清理正文后写 `purge_ledger`；旧备份先删但迁移保护备份保留；80% 触发维护；100% 进入 degraded 且不删短期/长期/日记；spool 满后拒绝新项且不覆盖旧项。
- [ ] 运行 `node --test test/maintenance.test.js`，确认失败。
- [ ] backup 写临时目标，Promise 成功后原子改名；清单只记录时间、大小、原因和 SHA-256，不记录正文。
- [ ] purge 在备份成功门禁后按到期时间小批删除，执行 WAL checkpoint，并仅在空闲页比例达阈值时运行 `incremental_vacuum`。
- [ ] spool 每行存最小事件 DTO；使用单文件大小和条数双上限；回放成功后原子截断，坏行移入无正文错误报告而不阻塞其余行。
- [ ] 运行 `node --test test/maintenance.test.js` 和 `npm test`。
- [ ] 提交：`维护：加入备份回收和容量保护`

### Task 8: 只读、可重复地导入现有 QQ、桌宠和可选抖音数据

**Files:**
- Create: `src/importers/index.js`
- Create: `src/importers/aurabot.js`
- Create: `src/importers/pet.js`
- Create: `src/importers/douyin.js`
- Create: `test/fixtures/aurabot/`
- Create: `test/fixtures/pet/`
- Create: `test/fixtures/douyin/`
- Create: `test/importers.test.js`
- Modify: `src/service.js`

**Interfaces:**
- Consumes: 显式来源路径；默认探测 `$DSH_HOME/plugins-data/aurabot`、`$DSH_HOME/dsh-pet/memory.json` 和抖音 `shared.sqlite`。
- Produces: `ImportReport` 计数与错误码、`import_ledger`；绝不写来源目录。

- [ ] 写失败测试：Aurabot 最近 7 天流水进短期、旧流水进待整理、`memories.json` 从导入时获得 30 天、`diary.json` 永久；pet 文件缺失正常跳过；损坏 JSON 回滚本批；重复导入计数不增长；来源文件字节哈希前后相同。
- [ ] 写抖音单独测试：存在可识别表时导入；模式不支持时返回 `optional-unsupported`，不得使核心导入失败。
- [ ] 运行 `node --test test/importers.test.js`，确认失败。
- [ ] 导入开始前分别创建来源目录清单和可恢复备份；备份失败则该来源不导入。每条 ledger 使用来源稳定 ID，否则使用来源文件相对路径、记录序号、时间和正文指纹。
- [ ] 每个来源小批事务提交；报告只含来源类别、成功/跳过/失败数量、错误码和时间，不含正文及账号。
- [ ] 提供 `dryRun`，先生成计划和计数，不创建数据库记录；实际导入只由管理动作或首次启用明确配置触发。
- [ ] 运行 `node --test test/importers.test.js` 和 `npm test`。
- [ ] 提交：`迁移：导入现有QQ和桌宠记忆`

### Task 9: 通过公开模块 API 接入 Aurabot QQ

**Files:**
- Create: `aurabot-module/dafeiyu-memory/index.mjs`
- Create: `aurabot-module/dafeiyu-memory/spool.mjs`
- Create: `scripts/install-aurabot-module.ps1`
- Create: `test/helpers/fake-aurabot.js`
- Create: `test/aurabot-connector.test.js`

**Interfaces:**
- Consumes: `api.on('message')`、`api.on('activity')`、`api.context()`、`api.dsh.get('dafeiyuMemory', false)`、`api.onDispose()`。
- Produces: QQ 入站/出站记忆和每轮统一记忆上下文；连接器永不接管消息。

- [ ] 写失败测试：每条允许的群消息即使不回复也记录；`message` 总返回 false/undefined；out activity 记录助手回复；in activity 不二次记录；owner 私聊、其他私聊、群聊构造正确 audience；核心缺失时聊天继续且事件进入有界 spool；disposer 后不再写入。
- [ ] 运行 `node --test test/aurabot-connector.test.js`，确认失败。
- [ ] 入站 `external_key` 使用 OneBot `messageId`；出站没有稳定 ID 时用方向、chatId、规范文本和近秒时间桶生成连接器键。正文为空或只有媒体时保存占位符，不读取二进制。
- [ ] `api.context()` 只调用同步 `service.recall()`，异常返回空串并节流记录去敏告警。主人判断优先 `api.isOwner(chat.userId)`，未知身份按最小权限。
- [ ] 安装脚本只把版本化模块复制到 `$DSH_HOME/plugins-data/aurabot/modules/dafeiyu-memory/`，覆盖前备份旧模块；不调用受 Electron 管理限制的 `dsh plugin add`。
- [ ] 运行连接器测试和 `npm test`；在临时目录执行安装脚本并核对文件清单。
- [ ] 提交：`接入：连接Aurabot QQ记忆`

### Task 10: 以版本锁定补丁接入 dsh-pet 0.3.8

**Files:**
- Create: `integrations/dsh-pet/bridge.ts`
- Create: `integrations/dsh-pet/patches/0.3.8-unified-memory.patch`
- Create: `integrations/dsh-pet/README.md`
- Create: `scripts/prepare-pet-source.ps1`
- Create: `test/pet-patch.test.js`

**Interfaces:**
- Consumes: dsh-pet `src/host/index.ts` 的 `chatWithPet()` 路径和可选 `ctx.get('dafeiyuMemory', false)`。
- Produces: 模型调用前的统一记忆补充、成功后的 pet 用户/assistant 事件；核心不可用时保持原 `memory.json` 路径和 `chatMemoryRounds` 语义。

- [ ] 先写补丁契约测试：只接受包名 `dsh-pet` 且版本精确 `0.3.8`；补丁必须只改源码/测试而不碰模型配置；无服务时传给 `generateChat()` 的参数与上游一致；有服务时最近 N 轮仍在且另加统一上下文；模型失败不写 assistant 事件。
- [ ] 运行 `node --test test/pet-patch.test.js`，确认补丁或夹具不存在而失败。
- [ ] `bridge.ts` 提供 `recallForPet(service, petId, text)` 和 `recordPetExchange(service, petId, userText, answer, now)`；所有错误降级为空上下文/去敏告警，不能使原聊天失败。
- [ ] 补丁在 dsh-pet 源码新增桥接文件与单元测试，并仅在 `chatWithPet()` 的模型调用前后挂接。不得改变 `configuredModel()`、`chatMemoryRounds`、气泡写入或 `memory.json` 原有写入。
- [ ] `prepare-pet-source.ps1` 默认把上游 tag `v0.3.8` 克隆到 `$DSH_HOME/sources/dsh-pet-unified-memory`；先核对版本和干净目录，再执行 `git apply --check`、应用补丁、安装、测试、构建。目标存在且有未知改动时停止，不覆盖。
- [ ] 在临时 clone 上运行补丁检查和 dsh-pet 针对性测试；再运行本仓库 `npm test`。Electron profile 的切换留给桌面应用本地源界面，不由脚本改 `profile/desktop/package.json`。
- [ ] 提交：`接入：连接dsh-pet统一记忆`

### Task 11: 增加最小管理 API 和 DSH 设置页

**Files:**
- Create: `src/management/projection.js`
- Create: `src/management/routes.js`
- Create: `client.js`
- Create: `test/management.test.js`
- Modify: `package.json`
- Modify: `src/index.js`

**Interfaces:**
- Consumes: `ctx.webServer.register()`、浏览器端 `slots`/`locale`、核心管理方法。
- Produces: `/dafeiyu-memory/api/status`、`/search`、`/recycle/restore`、`/recycle/purge`、`/diary/promote`、`/backup`、`/review/run` 和 `settings.section` 页面。

- [ ] 写失败测试：公开 status 只有计数/状态码/时间；搜索必须显式管理上下文；恢复、永久删除、写日记、备份和整理只接受 POST；永久删除要求目标 ID + 二次确认短语 + 当前回收状态；路径/正文不进入日志。
- [ ] 写客户端注册测试：factory 注入 `slots`、`locale`，注册唯一 `settings.section`，卸载时释放；页面显示四层计数、任务、容量、连接器状态、搜索、恢复和明确二次确认。
- [ ] 运行 `node --test test/management.test.js`，确认失败。
- [ ] host 路由对 JSON body 设小上限，拒绝未知字段和原型链字段；错误只返回稳定 code。`/search` 默认遮蔽 actor key，仅用户主动展开单条时取正文。
- [ ] `client.js` 使用 DSH 提供的 React 18 lazy-CJS factory，不打包第二份 React；布局使用全宽设置区和紧凑表格/工具栏，不嵌套卡片，窄屏操作自动换行。
- [ ] 用 Playwright 在本地假 API 页验证桌面 1440x900 与移动 390x844：无空白、无重叠、最长中文错误码不溢出、二次确认有效；保存截图到测试临时目录，不提交截图。
- [ ] 运行管理测试、`npm test` 和 `npm pack --dry-run`。
- [ ] 提交：`管理：增加记忆状态与恢复面板`

### Task 12: 完成核心端到端验收、安装说明和真实数据安全导入

**Files:**
- Create: `test/acceptance.test.js`
- Create: `scripts/verify-local-install.ps1`
- Create: `README.md`
- Modify: `package.json`
- Modify: `docs/superpowers/specs/2026-10-27-dafeiyu-unified-memory-design.md`

**Interfaces:**
- Consumes: 所有核心组件、临时 QQ/pet 夹具、假模型和本机只读源路径。
- Produces: 可重复的完整测试结果、安装/回滚/导入操作手册和不含正文的验收报告。

- [ ] 写端到端失败测试对应规格的 10 项核心验收：群聊重要事实可在主人私聊召回、私聊不泄露到群、pet 跨平台召回并回写、7/30/7 天边界、日记永久、失败不删除、重复导入不增长、重启不重复、无抖音也全通过。
- [ ] 运行 `node --test test/acceptance.test.js`，确认至少一项因尚未组装而失败；完成服务组装后使其通过。
- [ ] `verify-local-install.ps1` 只读检查 Node/DSH/插件版本、核心服务状态、目录权限、QQ 模块和 pet 源码版本；不发消息、不切换模型、不改 Electron profile。
- [ ] README 写明：目录结构、安装核心插件的 Electron 操作、QQ 模块安装、pet 本地源切换、dry-run 导入、实际导入、备份验证、回滚、日志位置和故障语义。
- [ ] 对本机现有数据先运行 dry-run，核对来源数量和备份目标；再由已批准的导入动作执行实际导入。导入前后计算三个来源的数据文件哈希，必须完全一致。
- [ ] 独立重跑：`npm test`、`npm pack --dry-run`、临时 pet patch 验证、管理页 Playwright 探针和 `scripts/verify-local-install.ps1`。
- [ ] 将规格状态改为“核心实现完成”只能在上述命令全部通过后进行；README 明确抖音为“未安装/可选”，不得把它计为核心失败。
- [ ] 提交：`验收：完成统一记忆系统核心交付`

## Optional Gate: 抖音好友私信与观看经历

只有 Task 1-12 全部完成并通过核心验收后才执行本节。先对 `dsh-douyin-browser-local` 1.4.5 做只读扩展点评估，并记录以下三选一结论：

- `supported`：存在稳定的生成前上下文钩子、发送确认后事件和观看经历事件，可用薄连接器完成。
- `read-only`：只能可靠导入 `shared.sqlite`，保留导入器但不做实时聊天接入。
- `abandoned`：需要大范围改写、无法确认发送成功或无法稳定验证真实浏览器流程，停止实现并记录原因。

无论结论如何，都不得修改 `dsh-douyin-scroll`，不得实现群聊，不得影响核心测试退出码。只有结论为 `supported` 时才新增独立 `test/douyin-connector.test.js`，且真实发送仍需用户另行明确启动。对应提交使用中文：`接入：增加抖音可选记忆连接器` 或 `文档：记录抖音连接器评估结论`。

## Final Verification Checklist

- [ ] `rg -n "TODO|TBD|placeholder|待实现|以后补" src test aurabot-module integrations scripts README.md` 无占位实现。
- [ ] `npm test` 全部通过，且测试日志中没有真实 QQ/抖音账号和正文。
- [ ] `npm pack --dry-run` 仅包含运行所需源码、连接器、补丁、文档和 manifest，不包含数据库、备份、spool、测试临时数据或凭据。
- [ ] 所有状态迁移测试均证明：模型失败、备份失败、数据库失败默认不删除。
- [ ] 所有隐私矩阵测试均证明：普通私聊/QQ群无法跨越自己的投影边界。
- [ ] dsh-pet 0.3.8 补丁能对干净 tag 应用；无核心服务时行为与上游一致。
- [ ] `git log --format=%s` 中本计划之后的实施提交均为中文。
- [ ] `git status --short` 为空，`origin/main` 与本地最终提交一致。
