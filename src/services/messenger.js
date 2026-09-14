/**
 * MessengerBridge - 消息桥接服务
 * 统一管理不同平台（飞书、钉钉、微信等）的消息发送
 */
class MessengerBridge {
  constructor() {
    this.channels = new Map(); // name -> service
  }

  /**
   * 注册消息渠道
   * @param {string} name - 渠道名称 (如 'feishu')
   * @param {object} service - 插件实例
   */
  register(name, service) {
    this.channels.set(name, service);
    console.log(`[Messenger] Registered channel: ${name}`);
  }

  /**
   * 向指定渠道的指定会话发送消息
   */
  async send(channelName, chatId, text) {
    const channel = this.channels.get(channelName);
    if (!channel) {
      console.warn(`[Messenger] Channel not found: ${channelName}`);
      return;
    }

    try {
      return await channel.send(chatId, text);
    } catch (error) {
      console.error(`[Messenger] Failed to send message via ${channelName}:`, error.message);
    }
  }

  /**
   * 全局广播通知（向所有已启用平台的通知渠道发送）
   * @param {string} text - 通知内容
   */
  async broadcast(text) {
    console.log(`[Messenger] Broadcasting: ${text.substring(0, 50)}...`);
    
    const results = [];
    for (const [name, service] of this.channels) {
      try {
        if (typeof service.broadcast === 'function') {
          results.push(service.broadcast(text));
        } else if (typeof service.send === 'function' && service.notificationChatId) {
          results.push(service.send(service.notificationChatId, text));
        } else {
          console.warn(`[Messenger] Channel ${name} does not support broadcasting`);
        }
      } catch (error) {
        console.error(`[Messenger] Broadcast failed on channel ${name}:`, error.message);
      }
    }
    
    return Promise.all(results);
  }
}

export default MessengerBridge;
