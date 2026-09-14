---
name: ureal-skill
description: 指导 Agent 使用智能家居 MCP 服务器（ureal-mcp）的所有工具、场景与提示词
type: md
---

# MCP 智能家居服务器使用指南

> 本文档是 `ureal-mcp` 服务器的完整操作手册。当用户需要控制智能家居设备、查询状态、创建场景或进行环境分析时，请严格按照本指南调用对应工具。

---

## 一、可用工具清单

| 工具名 | 描述 | 是否只读 |
|--------|------|----------|
| `smarthome_get_homes` | 获取账号下所有家庭及网关列表 | ✅ 只读 |
| `smarthome_get_project` | 获取指定网关的工程配置数据 | - |
| `smarthome_control_device` | 控制设备（开关、调节数值） | - |
| `smarthome_get_device_capabilities` | 获取设备型号的物理能力描述 | ✅ 只读 |
| `smarthome_query_device_status` | 实时查询设备当前状态 | ✅ 只读 |
| `smarthome_create_local_scene` | 在本地数据库创建自定义场景 | - |
| `smarthome_list_local_scenes` | 列出所有本地自定义场景 | ✅ 只读 |
| `smarthome_execute_local_scene` | 执行本地已定义的自定义场景 | - |
| `smarthome_delete_local_scene` | 删除本地自定义场景 | - |
| `smarthome_get_mcp_status` | 获取 MCP 服务器运行状态 | ✅ 只读 |
| `smarthome_get_history` | 获取设备节点的历史时序数据 | ✅ 只读 |
| `smarthome_get_today_summary` | 获取今日数据摘要（最大/最小/平均） | ✅ 只读 |
| `smarthome_get_period_summary` | 获取多天数据摘要（按天分组） | ✅ 只读 |

---

## 二、关键约束与注意事项

### 2.1 网关序列号（SN）规则
- ⚠️ **控制设备时必须使用以 `G` 开头的网关序列号 (SN)，严禁使用纯数字的家庭 ID。**
- 调用 `smarthome_get_homes` 后，结果中 `hostlist` 或 `snlist` 里以 `G` 开头的字符串即为 Gateway SN。

### 2.2 参数说明
- **sn**: 网关序列号（Gateway SN，通常以 G 开头）
- **did**: 设备 ID（整数）
- **node**: 控制节点名称（如 `Switch`, `SetTemp`, `QueryRoomTemp` 等）
- **idx**: 索引（默认为 0）
- **value**: 控制值（如 `'on'`, `'off'`, `25` 等）

### 2.3 操作顺序
1. 先调用 `smarthome_get_homes` 获取家庭和网关列表
2. 用户选择网关后，调用 `smarthome_get_project` 加载工程配置
3. 根据项目信息调用对应工具进行设备控制或数据查询

---

## 三、工具调用规范

### 3.1 设备控制流程

```
1. smarthome_get_homes() → 获取家庭列表和网关SN
2. smarthome_get_project(sn="Gxxxxx") → 获取工程配置（含设备列表）
3. smarthome_query_device_status(sn, did) → 查询设备当前状态
4. smarthome_control_device(sn, did, node, value) → 发送控制指令
5. smarthome_query_device_status(sn, did) → 确认控制结果
```

### 3.2 场景管理流程

```
1. smarthome_list_local_scenes() → 查看已有场景
2. smarthome_create_local_scene(name, description, actions) → 创建新场景
3. smarthome_execute_local_scene(name) → 执行场景
4. smarthome_delete_local_scene(name) → 删除不需要的场景
```

### 3.3 数据分析流程

```
1. smarthome_get_project(sn) → 确认设备类型和节点名称
2. smarthome_get_history(sn, did, nodes, hours) → 获取详细历史数据
3. smarthome_get_today_summary(sn, did, nodes) → 获取今日统计
4. smarthome_get_period_summary(sn, did, nodes, days) → 获取多天趋势
```

---

## 四、内置提示词（Prompts）

以下提示词已预定义在 MCP 服务器中，可通过 MCP 的 `prompts/get` 接口按需获取：

### 4.1 首次使用引导（initialize_home）
用途：首次连接时引导用户完成网关发现、工程加载与场景确认。

步骤：
1. 调用 `smarthome_get_homes` 获取家庭列表
2. 展示所有家庭名称及对应网关 SN
3. 用户确认后，对选定网关调用 `smarthome_get_project`
4. 最后确认本地数据库中是否有已保存的联动场景

### 4.2 设备深度诊断（device_diagnostic）
用途：对特定设备进行多维度体检，包括故障码分析。

步骤：
1. 调用 `smarthome_query_device_status` 获取实时节点状态
2. 重点分析 `QueryErrCode` 字段，判断设备是否有故障
3. 检查 `QueryLinkStat`，确认通信是否正常
4. 必要时调用 `smarthome_get_device_capabilities` 查看设备支持的控制节点

### 4.3 全屋场景设计大师（scenario_advisor）
用途：量身定制并保存本地场景。

步骤：
1. 查询 `smarthome_get_project` 获取网关下所有设备和房间信息
2. 用 `smarthome_get_device_capabilities` 查看具体型号的能力
3. 构思场景方案（如离家模式、回家模式、睡眠模式等）
4. 用 `smarthome_create_local_scene` 将场景写入本地数据库
5. 用 `smarthome_execute_local_scene` 执行验证

场景 JSON 格式：
```json
{
  "name": "场景名称",
  "description": "场景功能描述",
  "actions": [
    {
      "sn": "Gxxxxx",
      "did": 1001,
      "node": "Switch",
      "idx": 0,
      "value": "on",
      "delay": 500
    }
  ]
}
```

### 4.4 温湿度历史分析（temperature_humidity_analysis）
用途：分析指定设备一段时间内的温湿度变化趋势。

步骤：
1. `smarthome_get_project` 确认设备类型和名称
2. `smarthome_get_period_summary` 查询过去 N 天的温湿度数据
3. 分析最高/最低温度时段、温度波动范围、湿度是否在 40%-60% 舒适区间
4. 必要时用 `smarthome_get_history` 查看小时级详细数据

### 4.5 今日环境健康报告（daily_environment_report）
用途：生成当天室内环境舒适度报告。

步骤：
1. `smarthome_get_today_summary` 获取今日统计数据
2. 关注指标：温度（20-26°C 最佳）、设定温度匹配度、湿度（40%-60%）、开关状态
3. 根据数据给出舒适度评分和建议

### 4.6 全屋设备对比分析（multi_device_comparison）
用途：对比多个同类设备的运行状态。

步骤：
1. `smarthome_get_project` 获取网关下所有设备列表
2. 筛选出需要对比的设备 ID
3. 逐个 `smarthome_query_device_status` 获取实时状态
4. 对比：开关状态、设定温度 vs 实际温度、运行模式、在线状态
5. 生成对比表格

### 4.7 智能家居节能建议（energy_saving_advice）
用途：基于设备运行数据给出节能优化建议。

步骤：
1. `smarthome_get_project` 获取网关下所有设备
2. 筛选耗能设备类型（空调、地暖、锅炉、新风等）
3. `smarthome_get_period_summary` 查询 7 天或 30 天数据
4. 分析运行时间占比、温度设定合理性、是否存在不必要的长时间运行
5. 给出具体可操作的节能方案

---



## 六、常见场景示例

### 场景一："我出门了"
```
1. smarthome_control_device(sn, did_空调, "Switch", "off")
2. smarthome_control_device(sn, did_地暖, "Switch", "off")
3. smarthome_control_device(sn, did_新风, "Switch", "off")
4. smarthome_create_local_scene("离家模式", "关闭所有空调地暖新风", actions)
```

### 场景二："我回来了"
```
1. smarthome_control_device(sn, did_空调, "Switch", "on")
2. smarthome_control_device(sn, did_空调, "SetTemp", 24)
3. smarthome_control_device(sn, did_新风, "Switch", "on")
```

### 场景三："晚安"
```
1. smarthome_control_device(sn, did_灯光, "Switch", "off")
2. smarthome_control_device(sn, did_地暖, "SetTemp", 18)
3. smarthome_create_local_scene("睡眠模式", "关灯、调节地暖", actions)
```