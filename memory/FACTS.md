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