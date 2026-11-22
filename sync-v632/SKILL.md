---
name: sync-v632
description: "同步 Gerrit cherry-pick 到 v6.3.2 分支。Use when: 用户提供 Gerrit cherry-pick 命令需要同步到 v632 分支；cherry-pick 遇到冲突需要解决；sync_v632 脚本报冲突错误；将 cherry-pick 的差异补充到 v632 不修改现有代码。触发词: sync_v632, cherry-pick, Gerrit, v632, v6.3.2 冲突, 代码冲突, 同步分支"
argument-hint: "粘贴 Gerrit 的 cherry-pick 命令，例如: git fetch ssh://.../build refs/changes/XX/XXXXX/X && git cherry-pick FETCH_HEAD"
---

# Sync v6.3.2 — Gerrit Cherry-Pick 同步技能

## 目标

将 Gerrit 上的提交通过 cherry-pick 同步到 `v6.3.2` 分支。若遇到冲突，采用**补充策略**解决：保留当前代码不变，仅将 cherry-pick 中新增的内容追加进来，不覆盖或删除已有代码。

---

## 输入

用户提供的 Gerrit cherry-pick 命令，格式如下：

```
git fetch ssh://<host>/<project>/<repo> refs/changes/XX/XXXXX/X && git cherry-pick FETCH_HEAD
```

---

## 执行流程

### Step 1：解析命令，定位目录

从命令中提取仓库名（`ssh://` 路径中最后一段，位于 `refs/changes` 之前）：

```bash
# 提取示例: ssh://host/project/build refs/changes/... → 目录名为 "build"
DIR_NAME=$(echo "$CMD" | grep -oP 'ssh://\S+/\K[^\s/]+(?=\s+refs/changes)')
cd "$DIR_NAME"
```

若目录不存在，告知用户检查路径并终止。

### Step 2：执行 cherry-pick

```bash
eval "$CMD"
```

**若成功（退出码 0）**：直接跳到 Step 5 推送。

**若失败（退出码非 0）**：检查是否为冲突错误（`git status` 中含 `both modified` / `conflict`），进入 Step 3。

### Step 3：冲突分析（补充策略）

> **核心原则：不修改当前代码，只补充 cherry-pick 新增的内容。**

#### 3a. 获取冲突文件列表

```bash
git diff --name-only --diff-filter=U
```

#### 3b. 获取 cherry-pick 提交引入的新增内容

```bash
# 查看该提交相对于其父提交的完整 diff（只看新增行）
git show FETCH_HEAD -- <conflicted_file>
```

#### 3c. 逐文件处理冲突标记

对每个冲突文件，冲突块格式为：

```
<<<<<<< HEAD
【当前分支代码 — 必须完整保留】
=======
【cherry-pick 带来的代码】
>>>>>>> <commit>
```

**处理规则：**

| 情形 | 处理方式 |
|------|----------|
| cherry-pick 仅新增了代码（无删除） | 保留 `<<<< HEAD` 部分，并在其后追加 `====` 到 `>>>>` 之间的新增内容 |
| cherry-pick 修改了已有行（存在删除） | 保留 `<<<< HEAD` 部分（保持现有逻辑），跳过 cherry-pick 的修改行；仅追加纯新增行 |
| 新文件（当前分支无此文件） | 直接使用 cherry-pick 版本 |

使用辅助脚本自动处理：[resolve_conflicts.sh](./scripts/resolve_conflicts.sh)

```bash
bash resolve_conflicts.sh <conflicted_file> FETCH_HEAD
```

#### 3d. 标记冲突已解决

```bash
git add <resolved_file>
```

### Step 4：继续并完成 cherry-pick

```bash
git cherry-pick --continue --no-edit
```

若 `--continue` 仍报错，检查是否还有未解决的冲突文件，重复 Step 3。

### Step 5：推送到 v6.3.2

```bash
git push origin HEAD:refs/for/v6.3.2
```

推送成功输出 `✅ 同步完成！`，失败则提示检查网络或 Gerrit 权限。

---

## 冲突解决辅助脚本

参考 [resolve_conflicts.sh](./scripts/resolve_conflicts.sh)，该脚本：
1. 读取含冲突标记的文件
2. 保留 `<<<< HEAD` 段内容
3. 提取 `=====` 到 `>>>>>` 段中**纯新增**的行（对比 HEAD 版本不存在的行）
4. 将新增行追加到 HEAD 段后面
5. 写回文件，移除所有冲突标记

---

## 诊断检查清单

- [ ] 目录名是否正确解析（`grep -oP` 正则匹配）
- [ ] `git status` 确认冲突类型（`both modified` vs `deleted by us` vs `added by them`）
- [ ] 每个冲突文件处理后用 `git diff --cached` 确认暂存内容合理
- [ ] `git log --oneline -3` 确认 cherry-pick commit 已进入提交历史
- [ ] `git push` 返回 Gerrit review URL 表示推送成功

---

## 注意事项

- **不执行 `git cherry-pick --abort`**，冲突解决在当前 cherry-pick 会话内完成
- 若用户明确说某些文件的冲突不想要，则对该文件执行 `git checkout HEAD -- <file>` 后 `git add`
- Gerrit 推送目标固定为 `refs/for/v6.3.2`，不推送到其他分支
