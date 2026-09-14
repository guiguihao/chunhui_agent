# 通用风扇设备控制方法

- **开启**：调用 Home Assistant 服务 `fan.turn_on`，参数 `entity_id` 为目标风扇的实体 ID。
- **关闭**：调用 `fan.turn_off`，同样传入 `entity_id`。
- **调节风速**：使用 `fan.set_percentage`，`percentage` 为 0‑100（对应风速百分比）。
- **切换预设模式**：`fan.set_preset_mode`，常见模式包括 `standard`（标准风）、`nature`（自然风）和 `sleep`（睡眠）。
- **摆动**：`fan.toggle` 可在开启状态下切换摆动；若风扇支持 `fan.set_oscillation`，也可直接控制摆动开关。
- **常见错误**：调用时未提供 `entity_id`、`device_id`、`area_id`、`floor_id`、`label_id` 任意之一会返回错误 *"must contain at least one of entity_id, device_id, area_id, floor_id, label_id"*，因此请确保至少提供其中一个标识（通常使用 `entity_id` 即可）。
- **建议**：将目标风扇的实体 ID（如 `fan.jipin_cn_994298128_008_s_2_fan`）记录在记忆中，以后只需提供 ID 即可快速控制。


# 按键控制经验
- 对于 Home Assistant 中的 **按钮实体**（`button.xxx`），使用 **`button.press`** 服务进行一次性按键触发。
- 调用方式示例:
  ```json
  {
    "domain": "button",
    "service": "press",
    "target": { "entity_id": "button.<entity_id>" }
  }
  ```
- 必须在请求中提供 **`entity_id`**（或 `device_id`、`area_id` 等任意标识），否则会报错 *must contain at least one of entity_id, device_id, area_id, floor_id, label_id*。
- 按键实体通常对应 **开关切换**、**功能触发**，一次调用即相当于一次点击，适用于“开/关”“一次性动作”。
- 若需要在脚本或自动化中多次控制，同一实体可重复调用 `button.press`。
- 对于 **多路开关**（如三键开关），每一路都有独立的 `button.xxx_toggle_a_<路号>_1` 实体，只需替换对应的 `entity_id` 即可控制指定路。
- 建议在自动化中使用 **模板** 或 **变量** 动态拼接 `entity_id`，提高复用性。

## Home Assistant开关设备实体对照 用户说开灯关灯 指的就是三键智能单火开关2.0  二键智能单火开关2.0

### Cpcker三键智能单火开关2.0（办公室）
- 设备型号：BLN003
- 左键实体ID：`button.ckcper_cn_2144280885_bln003_toggle_a_2_1`
- 中键实体ID：`button.ckcper_cn_2144280885_bln003_toggle_a_3_1`
- 右键实体ID：`button.ckcper_cn_2144280885_bln003_toggle_a_4_1`
- 全开全关服务实体：`notify.ckcper_cn_2144280885_bln003_all_onoff_a_10_1`
- 所属区域：办公室 (ban_gong_shi)

### Cpcker二键智能单火开关2.0（办公室）
- 设备型号：BLN002
- 左键实体ID：`button.ckcper_cn_2144306477_bln002_toggle_a_2_1`
- 右键实体ID：`button.ckcper_cn_2144306477_bln002_toggle_a_3_1`
- 全开全关服务实体：`notify.ckcper_cn_2144306477_bln002_all_onoff_a_9_1`
- 所属区域：办公室 (ban_gong_shi)

### 控制方式
- **单键控制**：`button.press` 服务，target 传入对应 `entity_id`
- **全开/全关**：`notify.xxx_all_onoff` 实体通过 `notify.send_message` 服务发送 `on` 或 `off`

## 办公室灯光控制 - 开关实体（switch 域）

发现办公室灯的实际状态可通过 **switch** 域实体查询和控制，而不是 button 实体。

### Cpcker三键智能单火开关2.0（办公室）

| 按键 | 开关实体 ID | 对应操作 |
|:----:|:-----------|:--------:|
| 左键 | `switch.ckcper_cn_2144280885_bln003_on_p_2_1` | `switch.turn_on` / `switch.turn_off` |
| 中键 | `switch.ckcper_cn_2144280885_bln003_on_p_3_1` | `switch.turn_on` / `switch.turn_off` |
| 右键 | `switch.ckcper_cn_2144280885_bln003_on_p_4_1` | `switch.turn_on` / `switch.turn_off` |

### Cpcker二键智能单火开关2.0（办公室）

| 按键 | 开关实体 ID | 对应操作 |
|:----:|:-----------|:--------:|
| 左键 | `switch.ckcper_cn_2144306477_bln002_on_p_2_1` | `switch.turn_on` / `switch.turn_off` |
| 右键 | `switch.ckcper_cn_2144306477_bln002_on_p_3_1` | `switch.turn_on` / `switch.turn_off` |

### 全开全关（notify 方式，但有内部错误风险）
- 三键全开全关：`notify.ckcper_cn_2144280885_bln003_all_onoff_a_10_1` → `notify.send_message` + `message:"on"/"off"`
- 二键全开全关：`notify.ckcper_cn_2144306477_bln002_all_onoff_a_9_1` → `notify.send_message` + `message:"on"/"off"`
- ⚠️ 全开全关 notify 方式可能遇到设备内部错误（code=-704002000），此时应改用逐路 `switch.turn_on/off`

## 办公室灯光控制经验总结

### 正确的控制方式
办公室灯光（Cpcker三键/二键智能单火开关2.0）使用 **switch 域** 实体控制最可靠。

### service 调用格式
调用 `mcp_ha-mcp_call_service` 时，参数必须包含 `domain` 和 `target`：
```json
{
  "domain": "switch",
  "service": "turn_on",   // 或 turn_off
  "target": { "entity_id": "switch.xxx" }
}
```
缺少 `domain` 或 `target` 字段会导致调用失败。

### 全开/全关
- **推荐方式**：逐个调用 `switch.turn_on/off` 控制每个实体
- **备选（notify方式）**：`notify.xxx_all_onoff` + `notify.send_message` + `message:"on"/"off"`，但可能遇到设备内部错误（code=-704002000），失败时应回退到逐路控制

### 办公室灯光实体清单
| 实体 ID | 对应位置 |
|---------|---------|
| `switch.ckcper_cn_2144280885_bln003_on_p_2_1` | 三键开关 - 左键 |
| `switch.ckcper_cn_2144280885_bln003_on_p_3_1` | 三键开关 - 中键 |
| `switch.ckcper_cn_2144280885_bln003_on_p_4_1` | 三键开关 - 右键 |
| `switch.ckcper_cn_2144306477_bln002_on_p_2_1` | 二键开关 - 左键 |
| `switch.ckcper_cn_2144306477_bln002_on_p_3_1` | 二键开关 - 右键 |

## mcp_ha-mcp_call_service 参数传递方式

调用 `mcp_ha-mcp_call_service` 时，**不要**将 `entity_id` 嵌套在 `target` 对象中。正确的传参方式是将 `entity_id`、`domain`、`service` 作为**顶层参数**直接传入：

✅ 正确示例：
```json
{
  "domain": "switch",
  "service": "turn_off",
  "entity_id": "switch.xxx"
}
```

❌ 错误示例（会导致 "must contain at least one of entity_id..." 错误）：
```json
{
  "domain": "switch",
  "service": "turn_off",
  "target": { "entity_id": "switch.xxx" }
}
```

## 完整海尔空调设备-实体映射（2026年6月12日）

### 办公室区域（ban_gong_shi）- 5台海尔空调
| 序号 | HA设备ID | 开关实体 | 温度传感器 | 运行模式传感器 | 设定温度 | 模式选择 | 风速选择 |
|:----:|:---------|:---------|:-----------|:-------------|:---------|:---------|:---------|
| 1 | e5786d1842a40bbfe16867704e04fbd3 | `switch.hai_er_kong_diao_kai_guan_ji` | `sensor.hai_er_kong_diao_fang_jian_wen_du_2` | `sensor.hai_er_kong_diao_yun_xing_mo_shi_2` | `number.hai_er_kong_diao_she_ding_wen_du_2` | `select.hai_er_kong_diao_mo_shi` | `select.hai_er_kong_diao_feng_su` |
| 2 | 0d9e1d5b4a917d427de2cd027d8db742 | `switch.hai_er_kong_diao_kai_guan_ji_3` | `sensor.hai_er_kong_diao_fang_jian_wen_du_4` | `sensor.hai_er_kong_diao_yun_xing_mo_shi_5` | `number.hai_er_kong_diao_she_ding_wen_du_4` | `select.hai_er_kong_diao_mo_shi_3` | `select.hai_er_kong_diao_feng_su_3` |
| 3 | f60b0d6abca27b7c3ba667343c13aa94 | `switch.hai_er_kong_diao_kai_guan_ji_4` | `sensor.hai_er_kong_diao_fang_jian_wen_du_5` | `sensor.hai_er_kong_diao_yun_xing_mo_shi_7` | `number.hai_er_kong_diao_she_ding_wen_du_5` | `select.hai_er_kong_diao_mo_shi_4` | `select.hai_er_kong_diao_feng_su_4` |
| 4 | 9763b9953bac57ed20e4cc5959d3b631 | `switch.hai_er_kong_diao_kai_guan_ji_6` | `sensor.hai_er_kong_diao_fang_jian_wen_du_7` | `sensor.hai_er_kong_diao_yun_xing_mo_shi_9` | `number.hai_er_kong_diao_she_ding_wen_du_7` | `select.hai_er_kong_diao_mo_shi_6` | `select.hai_er_kong_diao_feng_su_6` |
| 5 | ee37c941b365dcaef840ed63c6e3a3a7 | `switch.hai_er_kong_diao_kai_guan_ji_7` | `sensor.hai_er_kong_diao_fang_jian_wen_du_8` | `sensor.hai_er_kong_diao_yun_xing_mo_shi_10` | `number.hai_er_kong_diao_she_ding_wen_du_8` | `select.hai_er_kong_diao_mo_shi_7` | `select.hai_er_kong_diao_feng_su_7` |

### 客厅区域（ke_ting）- 5台海尔空调
| HA设备ID | 开关实体 | 温度传感器 |
|:---------|:---------|:-----------|
| 395b347ed39d45e6a2a3bb37d0aab592 | `switch.wei_te_qi_xin_feng_kai_guan_ji` | `sensor.hai_er_kong_diao_fang_jian_wen_du` (26.0°C) |
| 0cd1a3b105a30af4c75400e0c45de8f5 | `switch.hai_er_kong_diao_kai_guan_ji_2` | `sensor.hai_er_kong_diao_fang_jian_wen_du_3` (25.0°C) |
| a100b0586f7b860321863c86a73be2ed | `switch.ri_li_kong_diao_kai_guan_ji` | `sensor.ri_li_kong_diao_fang_jian_wen_du` (27.0°C) |
| 2195fe64a7bc113877091d401068e25d | `switch.wen_kong_qi_kai_guan_ji` | `sensor.wen_kong_qi_fang_jian_wen_du` (26.0°C) |
| da250c1b12a6cf31cc40b68ddbd0e865 | `switch.hai_er_kong_diao_kai_guan_ji_5` | `sensor.hai_er_kong_diao_fang_jian_wen_du_6` (26.0°C) |

## mcp_ha-mcp_call_service 正确参数传递方式（2026年7月22日验证）

### 核心格式
```json
{
  "domain": "<domain>",
  "service": "<service>",
  "entity_id": "<entity_id>",
  "data": { <service_data_fields> }
}
```

### 关键规则
1. **`entity_id` 是顶层参数** — 直接放在顶层，**不要**用 `target` 包裹
2. **`data` 是 JSON 对象**（不是字符串）— 包含该 service 所需的全部字段
3. **不要使用 `target` 字段** — 会导致 "must contain at least one of entity_id, device_id..." 错误

### 常见操作示例

| 操作 | domain | service | data |
|:----|:-------|:--------|:-----|
| 设置空调温度 | `number` | `set_value` | `{"value": 24}` |
| 切换空调模式 | `select` | `select_option` | `{"option": "制冷"}` |
| 调节风速 | `select` | `select_option` | `{"option": "高"}` |
| 开灯 | `switch` | `turn_on` | 不需要 data |
| 关灯 | `switch` | `turn_off` | 不需要 data |

### 验证记录
- ✅ `number.set_value` 带 `data: {"value": 26}` → 调用成功
- ✅ `select.select_option` 带 `data: {"option": "制冷"}` → 调用成功
- ❌ `value` 作为顶层参数 → 报错 "required key not provided"
- ❌ `data` 传字符串 `'{"value":24}'` → 报错 "str object is not a mapping"
- ✅ `data` 传 JSON 对象 `{"value":24}` → 调用成功

## mcp_ha 查询工具正确传参（2026-09-06 实测验证）
- 工具入口：Home Assistant 内置 MCP（http://127.0.0.1:8123/api/mcp）
- `mcp_ha-mcp_get_state` 正确传参 = 顶层 `entity_id`（字符串），实测返回 state+attributes
- `mcp_ha-mcp_batch_get_state` 正确传参 = 顶层 `entity_ids`（字符串数组），实测一次返回多条
- 报错 `Internal error: 'entity_id'` / `'entity_ids'` = 服务器端解析参数 KeyError：未带该键/键名错（如 entities、entity）/被 target、data 嵌套/单复数混用（get_state 单数、batch_get_state 复数数组）
- 该 MCP 服务器所有工具与 call_service 同约定：标识符一律放顶层，禁止 target 包裹
- 工具 schema 显示为空 {} 时，需确保客户端透传顶层命名参数，否则参数被剥离服务器收不到