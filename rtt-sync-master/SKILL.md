---
name: rtt-sync-master
description: Align the RT-Thread SDK (~/Public/rtt_master/rt-thread and its nested cvi_rtt repo) with the latest remote master — fetch origin/master explicitly, stash local changes, back up local-only commits, then reset local master to origin/master. Use whenever the user asks to update the RTT SDK / rt-thread / cvi_rtt to the latest code; just do it, no confirmation needed. 触发词：更新到最新代码、更新代码、同步远程、对齐远程、拉最新 master、更新 rt-thread、更新 cvi_rtt、git pull 最新。
---

# rtt-sync-master

**用户说"更新到最新代码"时，直接对齐远程 master，不需要先问。** 跑脚本即可：

```bash
bash ~/.claude/skills/rtt-sync-master/sync-master.sh            # rt-thread + cvi_rtt 都对齐 origin/master
bash ~/.claude/skills/rtt-sync-master/sync-master.sh -n         # 只 fetch 并报告，不改动
bash ~/.claude/skills/rtt-sync-master/sync-master.sh -r <root>  # 换 SDK 根目录（默认 ~/Public/rtt_master/rt-thread）
```

脚本按 rt-thread → cvi_rtt 的顺序处理两个仓库。`cvi_rtt` 是一个独立的 git 仓库，被父仓库的 `.gitignore` 忽略，不是 submodule。

## 每个仓库做的事

1. `git fetch origin +refs/heads/master:refs/remotes/origin/master` 显式 fetch。
   **rt-thread 的 fetch refspec 只映射 `cv18xx-dev`**，直接 `git fetch` 不会更新 `origin/master`。
2. 检查 master 有没有在别的 worktree 里被 checkout（`rt-thread-master` 是同一批仓库的另一个 worktree），有就报错退出。
3. 有 skip-worktree / assume-unchanged 标记的文件（例如 `isp_bin.c` 里编译时会改写的 `ISP_BIN_MD5`）
   会让 checkout 失败，而 `git status` 又看不到。脚本先清掉标记，对齐后再给仍然存在的文件重新加上。
4. 已跟踪文件的本地改动用 `git stash` 存起来，stash 名为 `rtt-sync-master <时间> (was <分支> @ <commit>)`。未跟踪的编译产物不动。
5. 本地 master 上用 patch-id 判断还没进上游的提交（`git cherry` 里的 `+`），先备份到 `backup/master-<时间>` 分支。
   已经进上游的（`-`，例如 cherry-pick 后又合入的 Gerrit change）直接丢弃。
6. `git checkout -B master origin/master`，然后用 `git config branch.master.*` 设置跟踪。
   这里不能用 `--track`：refspec 不映射 master 时，它会报 "starting point is not a branch"，而且会把 checkout 留在半完成状态。

## 汇报

把脚本输出里的这几项告诉用户：
- 两个仓库 `旧 commit → 新 commit`；
- 新建了哪些 stash、哪些 backup 分支（**没有就不用提**）；
- 有没有 ERROR。

找回旧状态的办法：`git stash list` / `git stash pop`，以及 `git log backup/master-<时间>`。

## 失败处理

- **master 在别的 worktree 里被 checkout**：问用户是要切走那个 worktree，还是只对齐当前 worktree 所在的分支。
- **checkout 被未跟踪文件挡住**：看报错里列出的文件。确认是编译产物后，移走或删除，再重跑脚本。
- **fetch 失败**：通常是 ssh 不通（远程是 `10.132.3.76:29418`），把错误报给用户，不要重试太多次。
