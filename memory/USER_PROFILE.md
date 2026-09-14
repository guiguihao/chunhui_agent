## 基本信息
- 姓名: 主人
- 作息时间: 7:00起床
- 温度偏好: 
- 所在城市: 杭州

## 图片生成偏好
- 所有图片生成必须使用 `custom_gemini_action` 工具，禁止使用截图或其他方式代替,除非用户指定其他方式

## 空调使用规则
- 当说"打开空调"时，仅指打开 **3F办公室（1002）** 和 **3F会议室（1003）** 两台空调，不包括1F区域的空调
- 如需开启1F空调，须主人明确指定"把1F空调也打开"或逐一点名

## 空调定时任务
- 工作日（周一至周五）07:00 自动开启 **研发部** 和 **行政部** 空调，设定温度 **20°C**
- 研发部空调开关：`switch.wei_te_qi_xin_feng_kai_guan_ji`，设定温度：`number.hai_er_kong_diao_she_ding_wen_du`
- 行政部空调开关：`switch.hai_er_kong_diao_kai_guan_ji`，设定温度：`number.hai_er_kong_diao_she_ding_wen_du_2`