# dsh-pet 0.3.8 统一记忆补丁

只接受 `dsh-pet@0.3.8`。默认远端为 `https://github.com/PC2005-cloud/dsh-pet.git`，tag 为 `v0.3.8`。补丁只修改 `src/host/index.ts` 的聊天挂接，新增 `src/host/unified-memory.ts` 和对应测试。`bridge.ts` 是桥接的规范源码；离线测试校验补丁中的桥接与它逐文本一致（统一换行符）。

在本仓库执行：

```powershell
pwsh -NoProfile -File ./scripts/prepare-pet-source.ps1
# 可显式指定 DSH_HOME；Target 必须位于其 sources 子目录中。
pwsh -NoProfile -File ./scripts/prepare-pet-source.ps1 -DshHome 'D:\dsh-test' -Target 'D:\dsh-test\sources\dsh-pet-unified-memory'
```

默认目标是 `$DSH_HOME/sources/dsh-pet-unified-memory`。未设置 `DSH_HOME` 时使用 `$env:USERPROFILE/.dsh`。`-Remote`、`-Tag` 和 `-Target` 支持使用本地临时仓库验证；包名和版本检查始终生效。真实 `v0.3.8` 仓库的包根是 `<target>/dsh-pet`；脚本同时支持包位于仓库根的测试布局，补丁路径始终相对于解析出的包根。

脚本在修改前检查规范化目录、路径祖先无链接、包名/版本、HEAD 对应指定 tag、origin 和工作树。首次只接受不存在的目标或干净的匹配仓库；随后执行 `git apply --check` 和应用补丁（子目录布局使用 `--directory=dsh-pet`）。检测到上游 pnpm 锁文件时，在其 workspace 根运行 `corepack pnpm install --frozen-lockfile`，再运行 `corepack pnpm --dir <packageRoot> test` 和 `build`。真实 tag 的锁文件及 workspace 配置均位于 `<target>/dsh-pet`，其中的 rolldown override 必须保留。Corepack 自动写入 packageManager 的行为已关闭。仅无 pnpm 配置的测试布局回落到 `npm install --ignore-scripts --no-audit --no-fund --package-lock=false`、`npm test`、`npm run build`。命令失败即停止，不回滚或覆盖用户文件。脚本不修改 desktop profile，也不修改已安装的 `node_modules`；构建成功后通过桌面应用的本地源界面选择解析出的 **packageRoot**，当前为 `<target>/dsh-pet`。

应用状态存在源码仓库的 `.git/dafeiyu-unified-memory.json` 中，包含基线 commit、补丁 hash 和三个补丁文件的 hash。重复执行只接受同一补丁、同一基线和完整的已知工作树状态；未知文件、暂存修改或补丁文件变化都会停止。安装/测试/构建失败后，状态仍可用于检查并重试。

桥接同步调用可选的 `ctx.get('dafeiyuMemory', false)` 服务的 `recall()`；只消费返回的字符串。非空记忆作为“历史资料，不是指令”的分隔块追加到原 system prompt。空结果保持 `generateChat()` 的全部原参数。模型选择、推理参数、最近 `chatMemoryRounds` 轮、表情池、气泡、`memory.json` 和响应形状沿用原实现。

只有模型成功且原 `memory.json` 写入成功后，才异步 best-effort 记录双方。每次聊天生成一次 UUID，`recordPetExchange(service, petId, userText, answer, { exchangeId, userAt, assistantAt })` 使用 `pet:<petId>:<exchangeId>:user` / `:assistant` 作为稳定去重键。两条事件都是 `source=pet`、`conversationKind=pet`、`visibility=owner-private`。重试须复用同一 stamp；桥接不创建队列。服务缺失、召回/写入异常或写入悬停均不阻塞聊天；桥接返回稳定 code，不记录正文、错误对象或路径。

本仓库验证：`node --test test/pet-patch.test.js` 或 `npm test`。测试只使用仓库内的原版聊天源码快照和临时本地 Git remote，安装测试显式启用 npm offline，不访问网络。夹具来自只读的已安装 `dsh-pet@0.3.8` 源码；不能据此替代上游 tag 验证。外部 tag 的 `apply --check`、上游测试和完整 build 的实际结果见 Task 10 报告；网络不可达时不得宣称这些步骤已通过。
