import { createContext, useContext, useState, useEffect } from 'react'

const LanguageContext = createContext()

const translations = {
  en: {
    // Navigation
    nav_sessions: 'Sessions',
    nav_config: 'Configuration',
    nav_cron: 'Cron Tasks',
    nav_heartbeat: 'Heartbeat',
    nav_mcp: 'MCP Servers',
    logo_admin: 'ureal',

    // Language Toggle Button Text
    lang_label: '中文',

    // SessionView
    session_title: 'Active Session',
    session_subtitle: 'Monitor and interact with the agent in real-time (Session: {id})',
    btn_new_session: 'New Session',
    msg_init: 'Agent initialized and ready. Please type a message to interact.',
    msg_restarted: 'Session restarted.',
    thinking_title: 'AI Reasoning',
    thinking_status_active: '(Thinking...)',
    thinking_status_finished: '(Completed)',
    tool_call_prefix: 'Calling tool: ',
    tool_status_running: 'running',
    tool_status_done: 'completed',
    tool_section_args: 'Arguments:',
    tool_section_result: 'Output:',
    lightbox_title: 'Image Preview',
    lightbox_hover: 'Click to view full image',
    chat_placeholder: 'Type a command or message...',
    system_error: 'System execution error: ',
    request_error: 'Request error: ',
    stream_error: 'Your browser does not support Stream reading.',

    // CronView
    cron_title: 'Cron Tasks',
    cron_subtitle: 'Scheduled tasks — {active} active / {total} total',
    btn_add_task: 'Add Task',
    btn_save: 'Save',
    btn_saving: 'Saving...',
    cron_empty: 'No tasks. Click "Add Task" to create one.',
    cron_unnamed: 'Unnamed Task',
    cron_id: 'Task ID',
    cron_name: 'Task Name',
    cron_expr: 'Cron Expression',
    cron_prompt: 'Prompt',
    cron_prompt_placeholder: 'Agent instruction...',
    cron_id_placeholder: 'unique_id',
    cron_name_placeholder: 'e.g. Morning Report',
    cron_expr_placeholder: '0 9 * * *',
    save_ok: '✓ Saved',
    save_ok_restart: '✓ Saved · restart required: {modules}',
    save_err: 'Error: ',
    restart_btn: 'Restart Agent',
    restart_confirm: 'Restart the agent? Running tasks and live connections will be interrupted.',
    restart_running: 'Restarting...',
    restart_ok: '✓ Restarted',
    restart_fail: 'Restart timeout — please check backend logs',

    // HeartbeatView
    hb_title: 'Heartbeat',
    hb_subtitle: 'Periodic health checks — {count} checks configured',
    hb_global_settings: 'Global Settings',
    hb_enabled: 'Enabled',
    hb_active: 'Active',
    hb_disabled: 'Disabled',
    hb_interval: 'Check Interval (Cron)',
    hb_interval_hint: 'e.g. */10 * * * * = every 10 minutes',
    hb_check_items: 'Check Items',
    btn_add_check: 'Add Check',
    hb_empty: 'No checks. Click "Add Check" to add one.',
    hb_name: 'Name',
    hb_name_placeholder: 'e.g. System Health',
    hb_prompt: 'Prompt',
    hb_prompt_placeholder: 'Check instruction for agent...',

    // MCPView
    mcp_title: 'MCP Servers',
    mcp_subtitle: 'Model Context Protocol servers — {count} enabled',
    btn_add_server: 'Add Server',
    mcp_empty: 'No MCP servers configured.',
    btn_login: 'Login',
    btn_login_qr: 'Login',
    btn_login_qr_title: 'Xiaomi Login QR Code',
    mcp_server_name: 'Server Name (key)',
    mcp_url: 'URL',
    mcp_command: 'Command',
    mcp_args: 'Args (one per line)',
    mcp_env: 'Environment Variables',
    mcp_headers: 'Headers',
    qr_modal_title: 'Login with Xiaomi Account',
    qr_modal_close: 'Close',
    qr_state_loading: 'Generating QR code, please wait...',
    qr_state_loading_hint: '(Calling prepare_login, takes about 5-15s)',
    qr_state_error: 'Generation failed',
    qr_state_error_hint: 'Please confirm that the miot-mcp service is enabled and running.',
    qr_state_ok_hint: 'Please use Xiaomi App to scan and login',
    qr_state_ok_hint_2: 'miot-mcp will save login information automatically after scanning',
    qr_gen_time: '⏱ Generated at: ',

    // ConfigView
    cfg_title: 'Configuration',
    cfg_subtitle: 'Manage agent settings, memory and model providers',
    btn_save_changes: 'Save Changes',
    cfg_tab_agent: 'Agent',
    cfg_tab_memory: 'Memory',
    cfg_tab_providers: 'Model Providers',
    cfg_tab_env: 'Environment',
    cfg_agent_title: 'Agent Parameters',
    cfg_agent_name: 'Agent Name',
    cfg_agent_workspace: 'Workspace Path',
    cfg_default_model: 'Default Model',
    cfg_fallback_model: 'Fallback Model',
    cfg_model_hint: 'Format: provider_name/model_id',
    cfg_system_prompt: 'System Prompt',
    cfg_mem_title: 'Memory Files',
    cfg_mem_dir: 'Directory:',
    btn_back: 'Back',
    cfg_mem_empty: 'No content yet in {filename}...',
    cfg_providers_title: 'Model Providers',
    btn_add_provider: 'Add Provider',
    cfg_providers_empty: 'No providers configured. Click "Add Provider" to start.',
    cfg_provider_unnamed: 'Unnamed Provider',
    cfg_provider_name: 'Provider Name',
    cfg_provider_api_key_env: 'API Key Env',
    cfg_provider_base_url: 'Base URL',
    cfg_provider_models: 'Models',
    btn_add_model: 'Add Model',
    cfg_model_id: 'model-id',
    cfg_model_thinking: 'Thinking',
    cfg_model_stream: 'Stream',
    cfg_env_title: 'Environment Variables',
    btn_add_var: 'Add Variable',
    btn_save_env: 'Save .env',
    cfg_env_loading: 'Loading environment variables...',
    cfg_env_key: 'KEY',
    cfg_env_val: 'value',
    cfg_loading_config: 'Loading configuration...',

    // Memory keys translations
    mem_user_profile: 'User Profile',
    mem_user_profile_desc: 'User preferences & profiling',
    mem_knowledge: 'Knowledge',
    mem_knowledge_desc: 'Long-term experience & guidelines',
    mem_facts: 'Facts',
    mem_facts_desc: 'Facts registry & tabular items',
    mem_context: 'Context',
    mem_context_desc: 'Instant context & temporary session info',
  },
  zh: {
    // Navigation
    nav_sessions: '会话记录',
    nav_config: '系统配置',
    nav_cron: '定时任务',
    nav_heartbeat: '心跳检测',
    nav_mcp: 'MCP 服务',
    logo_admin: '舒适精灵',

    // Language Toggle Button Text
    lang_label: 'English',

    // SessionView
    session_title: '当前会话',
    session_subtitle: '实时监控与智能agent交互 (会话 ID: {id})',
    btn_new_session: '新建会话',
    msg_init: '智能agent已初始化完毕，请输入消息开始对话。',
    msg_restarted: '会话已重置。',
    thinking_title: 'AI 思考过程',
    thinking_status_active: '(正在思考...)',
    thinking_status_finished: '(已完成)',
    tool_call_prefix: '调用工具: ',
    tool_status_running: '正在执行',
    tool_status_done: '执行完成',
    tool_section_args: '参数:',
    tool_section_result: '输出:',
    lightbox_title: '大图预览',
    lightbox_hover: '点击查看大图',
    chat_placeholder: '输入命令或消息...',
    system_error: '系统执行出错: ',
    request_error: '请求出错: ',
    stream_error: '浏览器不支持 Stream 流式读取。',

    // CronView
    cron_title: '定时任务',
    cron_subtitle: '计划任务 — {active} 个启用 / {total} 个总数',
    btn_add_task: '添加任务',
    btn_save: '保存',
    btn_saving: '保存中...',
    cron_empty: '没有配置定时任务。点击“添加任务”创建一个。',
    cron_unnamed: '未命名任务',
    cron_id: '任务 ID',
    cron_name: '任务名称',
    cron_expr: 'Cron 表达式',
    cron_prompt: '提示词',
    cron_prompt_placeholder: '执行的指令...',
    cron_id_placeholder: '唯一标识符',
    cron_name_placeholder: '例如：早报',
    cron_expr_placeholder: '0 9 * * *',
    save_ok: '✓ 保存成功',
    save_ok_restart: '✓ 已保存 · 需重启生效：{modules}',
    save_err: '错误: ',
    restart_btn: '重启 Agent',
    restart_confirm: '确定要重启 Agent 吗？正在运行的任务与实时连接会被中断。',
    restart_running: '正在重启…',
    restart_ok: '✓ 重启完成',
    restart_fail: '重启超时，请查看后端日志',

    // HeartbeatView
    hb_title: '心跳检测',
    hb_subtitle: '定期健康检查 — 已配置 {count} 个检查项',
    hb_global_settings: '全局设置',
    hb_enabled: '启用状态',
    hb_active: '启用',
    hb_disabled: '禁用',
    hb_interval: '检查间隔 (Cron 表达式)',
    hb_interval_hint: '例如: */10 * * * * = 每10分钟',
    hb_check_items: '检查项',
    btn_add_check: '添加检查项',
    hb_empty: '没有配置检查项。点击“添加检查项”创建一个。',
    hb_name: '名称',
    hb_name_placeholder: '例如：系统健康状况',
    hb_prompt: '提示词',
    hb_prompt_placeholder: '给 Agent 的检查指令...',

    // MCPView
    mcp_title: 'MCP 服务',
    mcp_subtitle: 'Model Context Protocol 服务 — 已启用 {count} 个',
    btn_add_server: '添加服务',
    mcp_empty: '没有配置 MCP 服务。',
    btn_login: '登录',
    btn_login_qr: '登录',
    btn_login_qr_title: '小米账号扫码登录',
    mcp_server_name: '服务名称 (Key)',
    mcp_url: 'URL 地址',
    mcp_command: '启动命令',
    mcp_args: '启动参数 (每行一个)',
    mcp_env: '环境变量',
    mcp_headers: '请求头 (Headers)',
    qr_modal_title: '小米账号扫码登录',
    qr_modal_close: '关闭',
    qr_state_loading: '正在生成二维码，请稍候…',
    qr_state_loading_hint: '（调用 prepare_login 中，约需 5–15 秒）',
    qr_state_error: '生成失败',
    qr_state_error_hint: '请确认 miot-mcp 服务已启用并正常运行。',
    qr_state_ok_hint: '请使用小米账号 App 扫码登录',
    qr_state_ok_hint_2: '扫码后 miot-mcp 将自动保存登录信息',
    qr_gen_time: '⏱ 图片生成时间: ',

    // ConfigView
    cfg_title: '系统配置',
    cfg_subtitle: '管理agent参数、记忆库和模型服务商配置',
    btn_save_changes: '保存修改',
    cfg_tab_agent: 'agent',
    cfg_tab_memory: '记忆库',
    cfg_tab_providers: '模型服务商',
    cfg_tab_env: '环境变量',
    cfg_agent_title: 'agent参数设置',
    cfg_agent_name: 'agent名称',
    cfg_agent_workspace: '工作区路径',
    cfg_default_model: '默认模型',
    cfg_fallback_model: '备用模型',
    cfg_model_hint: '格式: 服务商名称/模型ID',
    cfg_system_prompt: '系统提示词 (System Prompt)',
    cfg_mem_title: '记忆文件',
    cfg_mem_dir: '存储目录:',
    btn_back: '返回',
    cfg_mem_empty: '文件 {filename} 尚无内容...',
    cfg_providers_title: '模型服务商列表',
    btn_add_provider: '添加服务商',
    cfg_providers_empty: '未配置任何服务商。点击“添加服务商”开始。',
    cfg_provider_unnamed: '未命名服务商',
    cfg_provider_name: '服务商名称',
    cfg_provider_api_key_env: 'API 密钥环境变量',
    cfg_provider_base_url: '接口 Base URL',
    cfg_provider_models: '支持的模型',
    btn_add_model: '添加模型',
    cfg_model_id: '模型 ID',
    cfg_model_thinking: '推理/思考',
    cfg_model_stream: '流式输出',
    cfg_env_title: '环境变量配置',
    btn_add_var: '添加变量',
    btn_save_env: '保存 .env 文件',
    cfg_env_loading: '正在加载环境变量...',
    cfg_env_key: '变量名',
    cfg_env_val: '值',
    cfg_loading_config: '正在加载系统配置...',

    // Memory keys translations
    mem_user_profile: '用户画像',
    mem_user_profile_desc: '用户偏好与画像',
    mem_knowledge: '经验与常识',
    mem_knowledge_desc: '长期知识库与经验',
    mem_facts: '事实数据库',
    mem_facts_desc: '事实记录与重要数据',
    mem_context: '当前上下文',
    mem_context_desc: '当前上下文与即时背景信息',
  }
}

export function LanguageProvider({ children }) {
  const [language, setLanguage] = useState(() => {
    return localStorage.getItem('webui_lang') || 'zh' // Default to Chinese
  })

  useEffect(() => {
    localStorage.setItem('webui_lang', language)
  }, [language])

  const toggleLanguage = () => {
    setLanguage(prev => (prev === 'en' ? 'zh' : 'en'))
  }

  const t = (key, variables = {}) => {
    let text = translations[language][key] || translations['en'][key] || key
    Object.entries(variables).forEach(([k, v]) => {
      text = text.replaceAll(`{${k}}`, v)
    })
    return text
  }

  return (
    <LanguageContext.Provider value={{ language, setLanguage, toggleLanguage, t }}>
      {children}
    </LanguageContext.Provider>
  )
}

export function useLanguage() {
  const context = useContext(LanguageContext)
  if (!context) {
    throw new Error('useLanguage must be used within a LanguageProvider')
  }
  return context
}
