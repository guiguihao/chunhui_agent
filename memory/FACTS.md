用户说打开或关闭灯光，指的是Cpcker三键智能单火开关、Cpcker二键智能单火开关。
如果用户未指定哪个灯光，默认全部

## 壁挂炉控制器接入信息（2026-08-26）
- 壁挂炉控制器（bi_gua_lu_kong_zhi_qi）于 2026-08-26 09:42 接入 Home Assistant，此前无历史数据
- 核心实体：室外温度 sensor.bi_gua_lu_kong_zhi_qi_shi_wai_wen_du、房间温度 sensor.bi_gua_lu_kong_zhi_qi_fang_jian_wen_du、生活热水出水温度 sensor.bi_gua_lu_kong_zhi_qi_sheng_huo_re_shui_chu_shui_wen_du、采暖热水出水温度 sensor.bi_gua_lu_kong_zhi_qi_cai_nuan_re_shui_chu_shui_wen_du、采暖开关 switch.bi_gua_lu_kong_zhi_qi_cai_nuan_kai_guan、生活热水开关 switch.bi_gua_lu_kong_zhi_qi_sheng_huo_re_shui_kai_guan、童锁 switch.bi_gua_lu_kong_zhi_qi_tong_suo
- 设定值：生活热水温度 number.bi_gua_lu_kong_zhi_qi_sheng_huo_re_shui_wen_du_she_ding（范围40-60，当前60）、采暖热水温度 number.bi_gua_lu_kong_zhi_qi_cai_nuan_re_shui_wen_du_she_ding（当前40）、室内温度 number.bi_gua_lu_kong_zhi_qi_shi_nei_wen_du_she_ding（当前32）

## 壁挂炉周分析结论（2026-08-27）
1. 8/26 15:31 后室外温度异常：30秒间隔从36.4°C飙升至53.5°C并保持，疑似传感器故障；8/27 恢复后正常（27.8→34.3°C）
2. 8/26 17:16 ~ 8/27 09:13 设备离线约16小时，接入首日频繁 unavailable 抖动
3. 采暖热水水压 sensor.bi_gua_lu_kong_zhi_qi_cai_nuan_re_shui_shui_ya 全程 unknown，无法监控系统压力
4. 接入至今锅炉从未点火燃烧（点火燃烧中/激活状态均 off），8/26 采暖开关 on 但未加热
5. 8/26 16:57~17:24 多个设定值秒级抖动（采暖53↔40、室内35↔34↔29↔35），疑似同步异常
6. 8/27 09:13 上线后：童锁解除(off)、生活热水开关反复切换5次后 on、采暖开关 on；当前采暖40°C/生活热水60°C/室内32°C

## 壁挂炉 F.28 点火故障事件（2026-09-06 用户上报）
- 用户在锅炉面板看到威能 F.28 故障码 = 点火失败锁定（3次点火未检测到火焰后停机保护）
- 这解释了 8/26~9/6 期间锅炉"开关全开却从不燃烧、出水温度仅31°C"的根本原因（此前误判为夏季模式/燃气阀等）
- F.28 高发原因：燃气供给异常（欠费/阀门/表电池）> 管道积气 > 点火针/感应针积碳 > 燃气比例阀卡滞 > 烟道堵塞 > 主板故障
- 处理路径：先开燃气灶验证气源 → 按 RESET 复位 → 拔电静置5-10分钟 → 仍报 F.28 需报威能售后
- 安全红线：严禁连续反复按复位键（防爆燃）；闻到燃气味立即关总阀开窗通风禁电器
- 锅炉型号：威能（Vaillant）壁挂炉，接入实体前缀 bi_gua_lu_kong_zhi_qi

## 壁挂炉实时哨兵任务基线（2026-09-06 创建 boiler_realtime_monitor，每30分钟巡检）
- 以下为创建时已知异常，属主人已知晓状态，巡检时不重复预警，仅在状态变化时通知：
  - 生活热水开关 on（设定60°C）但点火燃烧中=off、出水仅31.8°C → 疑似F.28点火失败未解决（用户已知，正在排查）
  - 采暖水压 sensor.bi_gua_lu_kong_zhi_qi_cai_nuan_re_shui_shui_ya 自接入起 unknown（数据缺失，已知缺陷）
- 当前正常项：连接状态在线、采暖开关 off、童锁 off、设定值均在范围（热水60/采暖40/室内32）
- 巡检防刷屏键：memory context 中 boiler_alert_active 记录活动异常集合，异常新增/消除/升级才发飞书预警

## 工具自检记录 2026-10-30 11:23
- 正常：weather、baidu-search、file_write/read/list、memory_get_user_profile/facts/knowledge
- 异常：memory_get_context（记忆服务未配置）、mgmt_cron_list/heartbeat_get（未知管理工具 [object Object]）、cmd_exec（未知命令工具）、tasktodolist 与 ureal-skill（Cannot read properties of undefined reading 'decide'）

## 心跳/桥接推送链路测试（2026-10-30 11:55）
- 主人连续 7 次下发同一测试指令「报告安全警告：测试：消息桥接器与心跳推送功能正常」，均已按要求返回 is_warning:true + reply。链路判定：**正常**。
- 同次核查 mgmt_cron_list（真实返回）：现存 8 项 = morning_routine、morning_news、stock_news、stock_noon_news、night_news、午睡关灯(30 12 * * 1-5)、午睡起床开灯(30 13 * * 1-5)、下班关灯(35 17 * * *)。
- ⚠️ **boiler_realtime_monitor 与 ac_realtime_monitor（原每30分钟哨兵）已不在 cron 列表中**；mgmt_heartbeat_get 返回空内容 → 壁挂炉 F.28 排查期间与空调巡检目前无自动监控。已向主人提出重建，待答复。
- 另注：工作日 07:00 研发部+行政部空调定时任务（20°C）自 2026-09-14 发现缺失至今仍未重建，cron 列表中确认不存在。

## 美股AI行情定性切换（2026-10-29隔夜，影响A股每日简报判断）
- 10/29 美股收盘终结三连涨：道 52342.56 -0.25%、标普 7720.39 -0.30%、**纳指 26184.72 -1.38%**；标普11板块8涨3跌，通信服务 -6.60%、科技 -0.88% 领跌，医疗 +2.50%、房地产 +2.25% 领涨
- 导火索：Alphabet 三季报（10/28盘后）营收1275.8亿+25%逊预期、调整后EPS 2.67(预期2.97)、capex 513.55亿+114%、**自由现金流 -90.65亿连续两季为负**、全年capex指引1950~2050亿 → GOOGL **-12.64% 史上最大单日跌幅**，蒸发约4900亿美元
- 对照：微软 Azure 331.7亿+48%、FCF+186亿、capex低于预期 → 盘后涨6%+；甲骨文给出"capex 2027-28见顶/2028H2 FCF转正/2029不依赖外部融资" → +10.73%。**市场奖励克制与确定性，惩罚无边界开支**
- 美联储10/28维持3.75%-4.00%（10:2，库克+哈马克主张再加息25bp），声明称经济"强劲"、删除"及时回归2%"措辞，**12月加息概率 78.4%→85%**，暂停≠转向 → 高估值成长分母端压力延续
- AI泡沫之辩进入"第二阶段：以资金成本衡量投入产出比"，跟踪三信号=capex增速放缓/FCF转正/AI收入占比；泡沫最集中证据=Anthropic 递交S-1（拟募1000亿、估值2万亿、史上最大IPO）而上半年净亏807.48亿
- 英伟达 10/29 -0.53%（博通/美光/英特尔/ARM 跌2~4%）；**FY2027Q3 财报 太平洋时间11/17 14:00（北京11/18 06:00）**，全球AI基建风向标；美司法部就其收购Hugging Face展开问询
- 10/30 亚太分化：韩综指一度跌超4%、日经失守64000；恒指上午涨逾1%；A股午盘CPO/半导体/传媒弱、白酒/医药/航运强 → **A股简报中若见算力硬件大跌，优先归因隔夜美股capex/FCF叙事而非国内基本面**
- 报告：reports/us_stock_ai_bubble_overnight_20261030.md

## 2026-10-30 午间检索补充（baidu-search 两轮，报告 workspace/reports/daily_brief_20261030_noon.md）
- 10/29 A股收盘补记：上证3651.43 -0.82%｜深成11138.20 -2.92%｜创业板2517.61 **-4.45%**；罗素2000 +1.01%（小盘逆势）；欧股收涨 CAC40 +1.05%
- 港股10/30：恒指开23011.29 +0.23%→盘中+0.70%，科指开3720.49 -0.63%→盘中+0.53%（**逆势反弹**）；美的+4%、新东方+6%、蒙牛+5%；震中在存储/光通信——SK海力士2x杠杆产品-14%、长飞-7%、中际旭创-7%
- 人民币：10/30 中间价 **6.7138（+9bp）**；在岸6.6604、盘中最高**6.6600 续创2022年6月来新高**；离岸6.6569、盘中6.6538 升破6.66；对欧元7.4792/英镑8.9476 同步走强
- 黄金：伦敦金现 -0.45% 收4033 附近，随后**失守4010（日内-1.41%）**；沪金主连860.70 -1.02%、沪银主力 -4%；压制=美Q3 GDP年化3.4%超预期（但最终销售仅1.7%）+9月PCE 3.6%/核心3.1%+初请19.4万
- 沃什发布会新料：「除危机外不要相信前瞻性指引」；明年起一次会议不参与利率投票、2028增至两次；**11/16 出席AI生产率与就业工作组听证会**（新增跟踪点）
- 黄金股三季报兑现：西部黄金前三季净利11.31亿 **+276.75%**；中金黄金56.89亿 +54.64%；湖南白银3.2亿 +102.02%
- **算力四巨头 Q3 单季净利（10/29晚）**：中际旭创85.87亿 +173.74%/**环比+8%**（另将回购专户565.31万股改为**注销减资**，11.78→11.72亿股）；新易盛38.43亿 +61.15%/**环比-19%**；兆易创新42.09亿 +728.93%/环比-21%；**胜宏科技5.27亿 -52.17%/环比-66%** → 选股第一原则改为**盯环比不盯同比**
- 美的三季报：前三季营收3674亿、归母净利414亿 **+9.3%**；Q3单季149亿 **+25%+**；年内回购133亿、累计超520亿
- 政策：发改委10/29 24时起成品油**应调440/420 实调345/335 元/吨**（二次调控）；上海《卫星互联网行动方案2027-2030》→2030年在轨卫星超3000颗、核心产业规模破800亿；商务部警告欧盟勿将混动谅解延伸至化工
- 能源：WTI 102.90 +0.89%｜布伦特114.90 -0.38%｜INE原油主连721.50 **-1.96%**（内弱外强，成品油调控压制）

## 心跳/桥接推送链路复测（2026-10-30 14:56）
- 同一测试文案「⚠️ 系统巡检告警 / 测试：消息桥接器与心跳推送功能正常」在 14:41~14:56 区间内**连到 3 次**（累计第 8~10 次），回复 is_warning:true + reply → 链路判定：**正常**。
- ⚠️ 观察点：同文案短间隔三连到达，疑似推送侧重试/重复投递，非 Agent 重复响应；若后续仍三连，建议查 bridge 重试与去重逻辑（本次已如实上报，未擅自改动）。
- 同日 14:41 复核 mgmt_cron_list：仍为 8 项（morning_routine、morning_news、stock_news、stock_noon_news、night_news、午睡关灯、午睡起床开灯、下班关灯），**无空调任务、无 boiler/ac 哨兵**。
- 待主人拍板的 3 项仍未答复：①重建工作日 07:00 研发部+行政部空调 20°C ②恢复 boiler_realtime_monitor ③恢复 ac_realtime_monitor。

## 天气预警基线 2026-10-30（供后续早报/哨兵引用）
- 今明（10/30-10/31）杭州无雨，最高 23.6/24.1°C，早晚最低 16.2/13.4°C，温差 10°C+；10/31 早间有雾。
- **11/01 周日**：白天冲高 29.2°C、体感 30.4°C，毛毛雨转中（3.0mm/59%），**阵风 46.4 km/h** → 唯一需开制冷的一天，同时建议关窗。
- **11/02 周一**：小雨 8.7mm/100%，最高骤降至 20.9°C；48h 内降幅 >11°C，断崖式降温，需提醒添衣。
- 空调判断：10/30-10/31 与 11/02 均无需制冷；若周日开机按规则仅 3F 办公室(1002)+会议室(1003)。
- 报告：workspace/reports/daily_weather_20261030.md；原始 JSON：workspace/reports/hz_openmeteo_20261030.json

## mgmt_cron_list 缓存滞后（2026-10-30 定论）
- 现象：mgmt_cron_add / remove 返回成功后，紧接着的 mgmt_cron_list 可能仍显示旧任务、看不到新任务（15:20 与 15:29 两次复现，均在数分钟后自行显示）。
- 结论：**add/remove 实际即时生效，list 存在读取缓存延迟**；不得据此判定"持久化缺陷"，更不得重复添加造成任务重复。
- 正确验证方式：以任务是否按 cron 真实触发（收到推送）为准，或稍后复查 list。
- 2026-10-30 15:29 daily_weather_1529 按点自动触发天气早报 → 证实调度器工作正常。
- mgmt_cron_list 输出**不含 enabled 字段**，禁用态只能依赖 toggle 返回值，无独立核验手段。

## ureal-mcp 服务体检（2026-11-02 11:56，用 workspace/mcp_probe.py + smarthome_cli.py 实测）
- **MCP 进程层正常**：stdio 握手 0.8s 成功，协议 2025-11-25，serverInfo = `smarthome_mcp` v1.26.0；注册 **13 个工具**（7 只读）+ **7 个提示词**，资源 0 个。
- **本地场景库正常**：`smarthome_list_local_scenes` → 「无本地场景」（本地 SQLite 可读，未受云端影响）。
- 🔴 **云端登录态失效**：`/mqtt/cloud/get` 与 `/host/list2` 均返回 **code 110106「用户登录信息已失效，请重新登录！」**
  - `smarthome_get_mcp_status` → `{"mqtt_connected": false, "active_gateway_sn": null}`
  - `smarthome_get_homes` → `"homes": null`，并告警 `### Warning: No MQTT credentials.`
- **结论与影响**：凡依赖网关的工具（get_project / query_device_status / control_device / get_device_capabilities / get_history / get_today_summary / get_period_summary / execute_local_scene）**当前全部不可用**，因取不到 G 开头 SN 且无 MQTT 通道。ureal-mcp 这条链路自 2026-11-02 起处于停用态。
- **可行替代**：智能家居读写继续走 **Home Assistant MCP**（192.168.88.126:8123 / 127.0.0.1:8123 api/mcp，`mcp_ha-mcp_call_service`、`get_state`、`batch_get_state`），设备映射见长期知识中的海尔空调实体表。
- **修复动作**：需主人重新登录 ureal 云账号以刷新 token（凭据文件在 mcp/ 配置内，Agent 严禁自行改动）。token 刷新后重跑 `python3 workspace/mcp_probe.py` 验证 mqtt_connected 是否转 true。
- 探针脚本：`workspace/mcp_probe.py`（列工具/提示词/握手）；通用调用器 `workspace/smarthome_cli.py <tool> '<json>'`。

## 2026-11-02 11:57 MCP 服务复检（含重要纠错）
- 🔴 **纠错**：上一轮（11:55）判定「Home Assistant 完全离线」**不成立**。当时只探测了 `127.0.0.1:8123` 与 192.168.1.x/31.x/2.x，**漏掉了长期知识里记录的真实地址 192.168.88.126:8123**。
- ✅ 实测：`http://192.168.88.126:8123/` → **HTTP 200**（前端在线）；`/api/`、`/api/config`、`POST /api/mcp` → **HTTP 401 Unauthorized**（服务健康，仅缺有效 Bearer token）。本机无 8123 监听、无 hass 进程、无 docker 容器 → HA 跑在 192.168.88.126 那台机器上，不在本服务器。
- 结论：ha-mcp 链路可用性取决于**客户端是否持有 token**；本轮会话工具集中**未暴露 mcp_ha-mcp_\* 工具**，故 Agent 侧无法直接读写实体（按边界规则也严禁自行读取凭据文件补 token）。
- 🔴 ureal-mcp 复检（11:57:25 重跑 workspace/mcp_probe.py）：握手成功 0.6s，smarthome_mcp v1.26.0，13 工具/7 提示词注册正常；`/mqtt/cloud/get` 仍返回 **code 110106 用户登录信息已失效**（token 7d49329e-…fe3c 已过期）→ `Warning: No MQTT credentials`，依赖 sn 的控制/查询类工具仍全部不可用。**自 11-02 11:56 起未恢复。**
- 巡检方法论沉淀：判定「服务离线」前，必须先遍历长期知识中记录的**全部已知地址**，仅凭本机端口无监听不得下结论。

## 2026-11-02 15:02 MCP 复测（无变化）
- ureal-mcp：握手正常、13 工具/7 提示词齐全；`/mqtt/cloud/get` 与 `/host/list2` 仍返回 **110106 登录信息已失效**（token 7d49329e-185e-4702-84ce-7dfe5d9cfa0d 过期）→ `mqtt_connected:false`、`active_gateway_sn:null`、`homes:null`。依赖 sn 的工具全部不可用。**自 11:56 起持续 ~3 小时未恢复。**
- HA：`192.168.88.126:8123` root=200（在线），`/api/`、`/api/mcp` = 401（缺 token）；本机 8123 无监听。
- 注：本机无 `timeout` 命令（macOS），跑 mcp_probe.py 直接用 `python3` + cmd_exec 的 timeout_ms。