---
name: tasktodolist
description: A CLI-based task/todo list manager. Allows you to maintain multiple independent to-do lists by specifying a task name. Use it to add, list, complete, or remove tasks.
parameters:
  type: object
  properties:
    action:
      type: string
      description: "要执行的操作: add, list, done, rm, clear, tasks_list, tasks_rm"
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
- `tasktodolist --task <name> clear`
- `tasktodolist tasks list`（列出所有任务列表）
- `tasktodolist tasks rm <名称>`（删除指定的任务列表）

## 使用方法
在终端运行 `tasktodolist [全局参数] <子命令> [参数]`。数据保存在用户家目录下的 `~/.tasktodolist/<task_name>_tasktodolist.json`，如果未指定任务名称，默认使用 `~/.tasktodolist/default_tasktodolist.json`。

## 安装
- **本地依赖**: `npm install`
- **全局安装 (推荐)**: 在该项目目录下运行 `npm install -g .`。安装后，你可以直接在任何地方运行 `tasktodolist` 命令。

## 依赖
`commander`（CLI 框架）
