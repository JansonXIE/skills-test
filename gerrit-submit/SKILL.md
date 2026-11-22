---
name: gerrit-submit
description: "提交代码到 Gerrit/服务器。适用于已经执行 git add 后，需要自动生成符合 hook 规范的 commit message、在 pre-commit 风格检查失败时自动修复并重试 git commit，最后根据 420/410/master/632/萤石5部/RTT-A2 分支映射执行 git push origin HEAD:refs/for/... 的场景。触发词：提交代码、git commit、git push、refs/for、Gerrit、420分支、410分支、632分支、萤石5部、RTT-A2。"
argument-hint: "提供分支、变更摘要、scope、JIRA ID（如有）、root cause、chip project、side effects 等信息"
user-invocable: true
---

# Gerrit Submit

## 作用

这个 skill 用于完成一次标准的 Gerrit 提交流程：

1. 基于已暂存的改动分析本次提交内容。
2. 生成符合仓库 hook 规则的 commit message。
3. 执行 `git commit`。
4. 如果 `pre-commit` 因风格问题失败，自动修复、重新 `git add`、继续重试。
5. `git commit` 成功后，根据用户提示中声明的目标分支执行 `git push origin HEAD:refs/for/...`。

## 何时使用

- 你已经先执行过 `git add`。
- 你希望代理自动写 commit message，而不是手工编辑模板。
- 你希望代理在 `pre-commit` 风格检查失败时继续修复直到 `git commit` 成功。
- 你希望按照固定分支映射推送到 Gerrit 的 `refs/for/*`。

## 输入要求

调用这个 skill 时，优先从用户提示中提取这些信息：

- 目标分支别名：`420`、`410`、`master`、`632`、`萤石5部`、`RTT-A2`
- 变更摘要
- `scope`
- `JIRA ID`，如果用户提示里出现则必须写入
- 可选：`type`、`root cause`、`chip project`、`side effects`

如果用户没有显式给出 `type`、`scope` 或标题，则根据已暂存 diff 和文件路径推断；只有在关键信息无法可靠推断时才提问。

## 分支映射

严格按照用户提示中说明的分支执行推送：

- `420` -> `git push origin HEAD:refs/for/v4.2.0`
- `410` -> `git push origin HEAD:refs/for/v4.1.0`
- `master` -> `git push origin HEAD:refs/for/master`
- `632` -> `git push origin HEAD:refs/for/v6.3.2`
- `萤石5部` -> `git push origin HEAD:refs/for/bm1688_ezviz_division5`
- `RTT-A2` -> `git push origin HEAD:refs/for/A2_dev`

如果用户提示没有给出分支，或者分支不在上面的映射中，必须先询问，不要猜测。

## 提交信息规则

使用 [commit message 模板](./assets/commit-message-template.txt) 生成完整提交信息，并满足以下约束：

- 提交信息必须是英文
- 第一行必须是 `[type](scope):英文标题`
- 第一行中的方括号、圆括号、冒号都不能删除，也不能改成全角符号
- `type` 只能是 `feat|fix|docs|style|refactor|perf|test|chore|revert`
- 标题长度必须是 3 到 150 个字符
- 如果用户提示中给出 `JIRA ID`，则 `[JIRA      ID]:` 这一项必须填写真实值，不能保留 `NA`
- `[Affected *.ko/*.so/*.a] :` 需要根据已暂存文件自动判断；如果没有匹配文件则填写 `NA`

提交信息建议优先覆盖这些字段：

- `[description ]:` 英文，说明这次改了什么
- `[root   cause]:` 英文，说明为什么要改或未知时写 `NA`
- `[JIRA      ID]:` 英文，如果用户提供则必须填写
- `[chip project]:` 英文，未知时写 `NA`
- `[side effects]:` 英文，未知时写 `NA`
- `[Affected *.ko/*.so/*.a] :` 英文，自动汇总或写 `NA`

## 执行流程

1. 检查前提条件。
   - 运行 `git diff --cached --name-only`，确认已经有暂存改动。
   - 运行 `git branch --show-current` 记录当前分支名。
   - 如果没有暂存改动，停止并告知用户先 `git add`。

2. 从用户提示和已暂存 diff 中提取提交元数据。
   - 根据改动性质推断 `type`。
   - 根据路径、模块名或用户输入推断 `scope`。
   - 生成一个 3 到 150 字符的中文或英文标题。
   - 收集 `description`、`root cause`、`JIRA ID`、`chip project`、`side effects`。
   - 用 `git diff --cached --name-only | grep -E '\\.(ko|so|a)$'` 检测受影响的二进制产物名称。

3. 生成 commit message。
   - 优先使用临时消息文件并通过 `git commit -F <message-file>` 提交，这样能稳定写入多行模板。
   - 第一行必须完全满足 hook 的正则：`^\[(feat|fix|docs|style|refactor|perf|test|chore|revert)\]\(.+\):(.{3,150})$`
   - 当用户提示中出现 JIRA 号时，必须原样带入提交信息。

4. 执行 `git commit`，并在失败时循环修复。
   - 如果 `pre-commit` 失败，先读取终端输出，区分是 `checkpatch.pl`、`flake8`、`cpplint`、非 ASCII、文件名非 ASCII 等哪类问题。
   - 仅修改 hook 报出的相关文件与相关位置，优先做格式和风格修复，不要顺手改动无关逻辑。
   - 修复后重新 `git add` 受影响文件，再次执行 `git commit -F <message-file>`。
   - 按这个循环持续重试，直到 `git commit` 成功，或者明确遇到需要用户决策的非格式性问题。

5. 处理 `commit-msg` 校验失败。
   - 如果失败原因是 `[type](scope)` 未替换、第一行格式不符、或缺少必填字段，则直接修正 commit message 后重试。
   - 不要删除模板字段名。
   - 如果仓库额外要求关键字字段，优先补齐 `[description ]:` 和 `[root   cause]:`。

6. 推送到目标分支。
   - 根据“分支映射”选择唯一正确的 `refs/for/*` 目标。
   - 如果用户提示里的目标分支和当前本地分支名明显不一致，先停下来问用户，不要直接推送。
   - 执行对应的 `git push origin HEAD:refs/for/...`。

7. 返回结果。
   - 告诉用户最终的提交标题、commit hash、推送目标 ref。
   - 如果在循环中自动修复过风格问题，简要说明修了哪些文件和哪类问题。

## 自动修复策略

- 对 `checkpatch.pl` 和 `cpplint`：优先修复空格、缩进、行宽、注释样式、括号与换行等格式问题。
- 对 `flake8`：优先修复明显的空格、换行、导入顺序、简单语法和静态风格问题；不要为了通过检查重写业务逻辑。
- 对非 ASCII 检查：仅在确认为误输入时替换为 ASCII；如果文件内容必须包含非 ASCII，则停止并向用户确认。
- 每次修复后都只重新暂存实际变更的文件。

## 终止条件

在以下情况下停止自动重试并向用户说明原因：

- 缺少目标分支信息，且无法从提示中确定
- hook 失败原因不是格式问题，而是需要业务判断
- 修复会引入超出当前提交意图的逻辑变化
- `git push` 因权限、网络或远端拒绝失败

## 示例提示词

- `/gerrit-submit 420分支，修复 osdrv 中 DMA cache 同步问题，scope=osdrv，JIRA=CVI-1234，root cause=边界条件下缓存未刷新`
- `/gerrit-submit master 分支，整理文档注释格式，scope=docs，无 JIRA`
- `/gerrit-submit RTT-A2 分支，修复音频初始化失败，scope=audio，description=修正时钟顺序，side effects=NA`