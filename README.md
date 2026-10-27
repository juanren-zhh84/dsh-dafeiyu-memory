# 大肥鱼统一记忆

本机 DSH 核心插件，通过 `dafeiyuMemory` 服务连接 Aurabot QQ 与 dsh-pet。短期记忆完整保留 7 天；成功整理后进入长期记忆（从晋升起 30 天）或永久日记；回收站再保留 7 天才允许物理清理。模型读取当前 DSH 选择，安装和导入脚本不切换模型。

目标环境：Windows、PowerShell 7、Node.js ≥24.22.0（本机验证 24.22.1）、DSH 0.2.1-rc.2、Aurabot 1.0.2、dsh-pet 0.3.8。抖音连接器**未安装/可选**，不属于核心失败条件；下列命令只选择 QQ 和桌宠，绝不探测抖音来源。

## 文件与数据

```text
插件源码目录/
  src/                         服务、SQLite、检索、整理、备份和管理 API
  client.js                    DSH 设置页
  cordis.patch.yml              核心挂载声明
  aurabot-module/               QQ 用户模块
  integrations/dsh-pet/         0.3.8 版本锁定桥接补丁与说明
  scripts/                     安装、只读检查与安全导入入口
$DSH_HOME/
  dafeiyu-memory/
    memory.sqlite              统一库（运行期间可能有 -wal/-shm）
    backups/                   SQLite 备份和 import-sources/ 来源快照
    spool/                     核心离线事件
    reports/                   只含计数、错误码和时间的报告
  plugins-data/aurabot/modules/dafeiyu-memory/   QQ 模块
  sources/dsh-pet-unified-memory/               桌宠独立源码
```

数据、来源备份和 spool 可能包含私人内容，只留在 DSH_HOME；请使用 Windows 当前用户目录权限保护并离线备份，勿提交 Git 或复制到公开工单。npm 包白名单不包含测试、数据库、备份、报告、截图或凭据。

## 先检查，再安装

以下在**插件源码根目录**的 PowerShell 7 执行。明确指定绝对 DSH_HOME，不把源码目录当数据目录。首次操作前退出 Electron/DSH，避免来源聊天流水在核对哈希期间继续写入。

```powershell
$DshHome = Join-Path $env:USERPROFILE '.dsh'
pwsh -NoProfile -File .\scripts\verify-local-install.ps1 -DshHome $DshHome
```

检查器只读：查看版本、目录 ACL/最近现有父目录权限、离线数据库完整性/schema/计数、QQ 文件哈希、pet 的 canonical bridge/补丁、Git tag/远端/工作区和构建产物，以及 Electron profile 引用。不会创建权限测试文件，不发送消息，不改模型/profile。schema 对照由同一套迁移在内存生成，包含表/列/STRICT/索引/约束和迁移标记。`pending` 表示尚未安装或尚未由 Electron 激活，默认是可接受的准备阶段状态；`fail` 必须先处理。`required` 是核心检查，`optional` 仅为可选项。出现活动 WAL 时仅安全检查库头，返回 `DATABASE_ACTIVE_SAFE_HEADER_ONLY`，退出 DSH 后复查。profile 检查会解析实际 `file:` 路径（相对路径以 desktop profile 目录为基准），要求精确指向当前核心源码/pet 包根且包名版本正确；严格模式拒绝错误版本、不存在或错误路径。有效引用仍不证明进程内服务已经启动。

```powershell
# 全部准备并经 Electron 切换后，再要求所有核心 pending 消失
pwsh -NoProfile -File .\scripts\verify-local-install.ps1 -DshHome $DshHome -RequireActivated
```

## 安装核心与 QQ

1. 在 DSH Electron 的插件/本地源管理中，把本仓库根目录注册为 `dsh-dafeiyu-memory` 的本地源，安装/启用后由 Electron 管理 desktop profile。目录必须包含 `package.json` 和 `cordis.patch.yml`。本仓库脚本不编辑 profile，不直接修改宿主 `node_modules`。
2. 执行下列 QQ 用户模块安装器。只复制 `index.mjs` 与 `spool.mjs`；旧模块目录若存在，先保存在 Aurabot 数据目录中的 `dafeiyu-memory-backup-*`。遇到链接或路径异常即拒绝，保留原文件。
3. 完成导入与桌宠准备后再启动 DSH。由用户正常启用 QQ 模块；安装器不启动/登录 QQ，不触发真实聊天。设置页出现“统一记忆”后查看计数。连接器状态反映库中观察到的事件，不代表实时在线。

```powershell
pwsh -NoProfile -File .\scripts\install-aurabot-module.ps1 -DshHome $DshHome
```

## 桌宠源码准备与切换

```powershell
pwsh -NoProfile -File .\scripts\prepare-pet-source.ps1 -DshHome $DshHome
```

脚本默认 clone 固定 `v0.3.8` 到 `$DSH_HOME/sources/dsh-pet-unified-memory`，核对包名/版本/tag/远端/工作区，应用本仓库补丁，安装锁定依赖并运行上游测试和构建。真实上游包位于其 `dsh-pet/` 子目录；以脚本检测出的含 `package.json` 的包目录作为 Electron 中 `dsh-pet` 本地源。网络、依赖或构建失败即停止，请勿在失败目录上手工覆盖补丁。

成功输出 `PET_SOURCE_READY` 后，在 Electron 本地源管理中将 `dsh-pet` 切换到该源码包目录，然后重载插件。脚本不会做此切换。没有核心服务时仍使用上游 `memory.json` 路径；聊天失败不记录伪造的助手回复。更多细节见 [桌宠补丁说明](integrations/dsh-pet/README.md)。

## 现有数据：先 dry-run，再 apply

导入命令不启动服务调度器或模型。仅显式选取：

- `$DSH_HOME/plugins-data/aurabot/memories.json`、`diary.json` 和 `chatlog/*.jsonl`。
- `$DSH_HOME/dsh-pet/memory.json`；缺失属于正常 `skipped`。

Aurabot 流水中的空文本沿用实时连接器的 `[空消息]`。上游 QQ 空间 writer 使用单独的 `qzone` 非聊天来源：该行只记无正文的跳过凭据，计入 `skipped`，不猜成私聊/群聊；其他未知会话格式仍阻塞导入。

```powershell
node --disable-warning=ExperimentalWarning .\scripts\import-existing.mjs --dsh-home $DshHome --dry-run
```

必须看到 `ok: true`、`code: DRY_RUN_OK`。核对每个来源的 `planned/skipped/failed`；`backupTarget: CORE_IMPORT_SOURCES` 固定指向 `$DSH_HOME/dafeiyu-memory/backups/import-sources/<快照ID>/`。dry-run 对真实目标不建库、不迁移、不写报告或备份；已有库使用内存副本规划，新库使用临时规划库后清理。有 `-wal/-shm` 时以 `TARGET_BUSY` 停止，退出 DSH 后重试。若有未知目标、链接、损坏来源或变化的来源哈希则停止。

```powershell
node --disable-warning=ExperimentalWarning .\scripts\import-existing.mjs --dsh-home $DshHome --apply
# 再运行两次，planned/imported 应为 0（skipped 为已有记录）
node --disable-warning=ExperimentalWarning .\scripts\import-existing.mjs --dsh-home $DshHome --dry-run
node --disable-warning=ExperimentalWarning .\scripts\import-existing.mjs --dsh-home $DshHome --apply
```

apply 先运行同样的预检，再在 DSH_HOME 下创建同盘隔离 staging。预检文件集合、大小和 SHA-256 必须与 staging 来源快照完全相同，实际导入只消费该快照；所有批次和来源备份先在 staging 完成。发布前再次核对全部真实来源及目标库哈希：新目标一次重命名整个数据目录；已有目标先发布来源备份，最后通过同步哈希门后原子替换数据库文件。返回 `SOURCE_CHANGED` 时真实目标记录始终不变，新目标不留下半导入；失败 staging 自动清理。成功报告在数据库发布后才发布，报告失败以 `REPORT_FAILED` 单独表达。原始来源文件永不修改。报告只输出来源类别、计数、稳定 code 和时间，不输出原文、账号或绝对来源路径。任何来源失败时立即停止，不以覆盖、删除或重建异常目标“修复”。重复导入仍按 ledger 幂等跳过。

## 核验备份与回滚

来源快照每个目录有 `manifest.json`，包含 `protected: true`、来源、时间、相对文件名、大小和 SHA-256。apply 后核对 manifest 的每项文件存在、大小相同，`Get-FileHash -Algorithm SHA256` 与清单相同；来源当前哈希也必须仍等于导入前记录。普通 SQLite 备份同样附有去敏清单；清理任务必须先成功备份。

回滚步骤：退出 DSH/Electron → 保留当前整个 `dafeiyu-memory` 目录作为隔离副本 → 从已核验的 SQLite 备份复制库到恢复目录 → 只读检查成功后再替换停机目标，并避免带入旧 `-wal/-shm` → 重新启动并核对计数。不要在运行中替换库，勿删除来源文件。若只是停用集成，可在 Electron 禁用核心/切回原 dsh-pet 本地源，QQ 模块用安装器创建的旧模块备份恢复；统一库留存以便复核。来源数据始终保留，因此可以选择新的空数据目录重新导入，但绝不自动覆盖异常现有目标。

## 日志与故障语义

导入报告在 `dafeiyu-memory/reports/import-*.json`。整理状态、重试次数和下次时间可在设置页查看；QQ 降级告警只有稳定错误码，离线副本位于模块自有 dataDir 的 `events.jsonl`。不要把该 spool 正文贴进日志。

- 模型超时、协议错误或数据库事务失败：不提交整理结果，不删除原记忆，稍后重试。
- 备份失败：禁止物理清理；继续允许正常读取和记录。
- 库无法打开：不以新空库覆盖；QQ/pet 按原聊天路径降级。
- 磁盘达到软上限：进入降级，不提前删除短期、有效长期或永久日记。
- 重复事件/导入：稳定键和 ledger 去重；物理清理后的最小凭据防止再次导回。
- 主人私聊与 pet 可查询允许的跨平台记忆；普通联系人和群严格受自己的会话投影约束。

自动验证：`node --test test/acceptance.test.js`、`npm test`、`npm pack --dry-run`。测试使用合成数据与临时目录，不发送真实 QQ/抖音消息；管理界面的真实浏览器探针需要测试文件说明的本地 Playwright/React 环境。Electron 注册/真实会话仍由用户自行启动。
