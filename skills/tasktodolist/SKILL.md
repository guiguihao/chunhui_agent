---
name: tasktodolist
description: A CLI-based task/todo list manager. Allows you to maintain multiple independent to-do lists by specifying a task name. Use it to add, list, complete, or remove tasks.
parameters:
  type: object
  properties:
    action:
      type: string
      description: "要执行的操作: add, list, done, rm, clear, tasks_list, tasks_rm。注意 clear 只删除已完成项，未完成项保留，不等于清空列表"
      enum: ["add", "list", "done", "rm", "clear", "tasks_list", "tasks_rm"]
    task:
      type: string
      description: "任务列表名称 (对应 -t 参数)。如果未提供，则使用 default 列表"
    content:
      type: string
      description: "当 action 为 add 时，待办的具体内容 (或 tasks_rm 时的目标列表名称)"
    index:
      type: number
      description: "当 action 为 done 或 rm 时的待办项目序号"
  required: ["action"]
---

# tasktodolist Skill

## 描述
一个简单的待办事项管理 Skill，支持以下操作。**可以通过 `-t, --task <name>` 参数来指定不同的任务名称，从而维护多个互相独立的待办列表。**
- `tasktodolist --task <name> add <内容>`
- `tasktodolist --task <name> list`
- `tasktodolist --task <name> done <序号>`
- `tasktodolist --task <name> rm <序号>`
- `tasktodolist --task <name> clear`（**只删除已完成项**，未完成项保留）
- `tasktodolist tasks list`（列出所有任务列表）
- `tasktodolist tasks rm <名称>`（删除指定的任务列表）

## 使用方法
在终端运行 `tasktodolist [全局参数] <子命令> [参数]`。数据保存在用户家目录下的 `~/.tasktodolist/<task_name>_tasktodolist.json`，如果未指定任务名称，默认使用 `~/.tasktodolist/default_tasktodolist.json`。

## 行为细节（实测确认，别想当然）
1. **序号是实时编号，不是 id**：`list` 每次按数组顺序从 1 开始编号；`done`/`rm` 之后再 `list` 会重新编号。
   不要沿用上一轮看到的历史序号，操作前必须重新 `list` 核对。
2. **`clear` 不清空列表**：它等价于「删掉所有 `done: true` 的项」，未完成项一律保留。
   需要清空整个列表时：先 `tasks rm <名称>` 删掉列表（会把 JSON 文件一起删），或逐条 `rm <序号>`。
   不要向用户汇报「已清空列表」，除非确实删光了每一条。
3. **存储结构**：`add` 写入 `{id, text, done}`，`id` 是毫秒时间戳，仅作内部标识，对外一律用序号。
4. **越界即失败**：`done`/`rm` 的序号超出范围会打印 `❌ 序号超出范围` 并以非 0 退出码结束，此时不要假设操作已生效。
5. **列表名即文件名**：`--task <name>` 对应 `~/.tasktodolist/<name>_tasktodolist.json`，重命名列表只能先 `tasks rm` 再 `add` 重建。

## 安装
- **本地依赖**: `npm install`
- **全局安装 (推荐)**: 在该项目目录下运行 `npm install -g .`。安装后，你可以直接在任何地方运行 `tasktodolist` 命令。

## 命令不可用时（重要）
如果执行 `tasktodolist` 报 `command not found`，不要放弃也不要编造结果，直接调用仓库内的入口脚本
（`cmd_exec` 的默认工作目录就是仓库根目录）：

```bash
node skills/tasktodolist/src/index.js --task <name> add "待办内容"
node skills/tasktodolist/src/index.js --task <name> list
node skills/tasktodolist/src/index.js --task <name> done <序号>
node skills/tasktodolist/src/index.js --task <name> rm <序号>
node skills/tasktodolist/src/index.js --task <name> clear   # 只删已完成项
node skills/tasktodolist/src/index.js tasks list
node skills/tasktodolist/src/index.js tasks rm <名称>
```

## 依赖
`commander`（CLI 框架）
