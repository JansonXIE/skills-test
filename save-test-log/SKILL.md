---
name: save-test-log
description: "在开发板端执行功能测试并把测试 log 保存到 SDK 的 log/ 目录，log 文件用 JIRA ID 命名。适用于：AI 解决完一个需求/bug 后，需要在板端做功能验证测试，并把本次测试的串口 log 归档留证的场景。触发词：保存 log、保存测试日志、功能测试、板端验证、测试并存 log、JIRA log、归档日志、save test log。"
argument-hint: "提供 JIRA ID 和要在板端执行的测试指令（一条或多条），可选提供本次测试的功能描述"
user-invocable: true
---

# Save Test Log

## 作用

这个 skill 用于把一次「板端功能测试」的过程和结果归档成 log 文件：

1. 通过 `uart_agent.py` 在开发板上执行用户给定的测试指令。
2. 捕获串口返回的过滤后 log 和命令返回码。
3. 把本次测试 log 保存到 SDK 根目录下的 `log/` 目录。
4. log 文件名使用 **JIRA ID** 命名（同一个 JIRA ID 多次测试时自动追加时间戳后缀避免覆盖）。

## 何时使用

- 你（AI）刚解决完用户提出的某个需求或 bug，并已完成编译 + 烧录。
- 需要在板端跑功能测试验证改动是否生效。
- 需要把本次测试的串口输出留档，方便后续追溯 / 附到 JIRA / code review 里。

## 输入要求

调用这个 skill 时，从用户提示或当前任务上下文中提取：

- **JIRA ID**（必需）：用作 log 文件名，例如 `MARS3-1234`。
  - 如果用户没有明确给出 JIRA ID，先询问，不要用占位符猜测命名。
- **测试指令**（必需）：要在板端执行的一条或多条 shell 命令，例如 `gpio_test 3` 或 `cat /proc/interrupts`。
  - 多条命令时用 `&&` 或 `;` 拼接成一次下发（注意串口无流控，内容需短小）。
- **功能描述**（可选）：本次测试验证的功能点，会写进 log 头部作为上下文。

## 输出位置与命名

- 目录：SDK 根目录下的 `log/`（即 `<TOP_DIR>/log/`，脚本会自动定位当前 Agent 工作区）。
- 文件名：
  - 首次：`<JIRA_ID>.log`
  - 若 `<JIRA_ID>.log` 已存在（同一 JIRA 多轮测试）：`<JIRA_ID>_<YYYYmmdd_HHMMSS>.log`，不覆盖历史记录。
- log 内容包含：JIRA ID、功能描述、测试时间、每条测试命令、串口返回的过滤 log、命令返回码（PASS/FAIL）。

## 如何运行

在 **SDK 根目录**（当前 Agent 自己的工作区）运行辅助脚本，把 JIRA ID 和测试指令传进去：

```bash
~/.claude/skills/save-test-log/save_test_log.sh -j <JIRA_ID> -c "<测试指令>"
```

可选参数：

- `-d "<功能描述>"`：本次测试验证的功能点，写进 log 头部。
- `-c "<测试指令>"` 可多次出现，用于按顺序执行多条测试命令，每条各自记录返回码。
- `-r <TOP_DIR>`：手动指定 SDK 根目录（默认取当前目录 `$PWD`，log 会写到该目录下的 `log/`）。

示例（单条命令）：

```bash
~/.claude/skills/save-test-log/save_test_log.sh -j MARS3-1234 -d "Wiegand 读卡功能" -c "wiegand_test read"
```

示例（多条命令）：

```bash
~/.claude/skills/save-test-log/save_test_log.sh -j MARS3-1234 \
  -c "cat /proc/interrupts | grep gpio" \
  -c "gpio_test 3 out 1" \
  -c "gpio_test 3 read"
```

## 判定规则

- 脚本以最后一条测试命令的返回码作为整体退出码：全部 `RC=0` -> 退出码 0（PASS），任意一条非 0 -> 非 0（FAIL）。
- 无论 PASS/FAIL，log 都会完整落盘，方便失败复盘。
- 脚本执行完会打印 log 的保存路径，把该路径回报给用户。

## 并行开发注意

- 本 skill 通过 `uart_agent.py` 读写串口，属于「独占开发板」操作。
- 在多 Agent / 多终端共享同一块板子时，必须先拿板子锁再跑，避免并发读写串口：

  ```bash
  ~/.claude/skills/parallel-dev-setup/board-lock.sh -- \
    ~/.claude/skills/save-test-log/save_test_log.sh -j MARS3-1234 -c "<测试指令>"
  ```
