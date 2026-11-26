# dsh-im-gateway
接入飞书、Telegram、Slack 或企业微信等通道，把外部消息统一映射到本地 L1 Flash 的持久化会话中。

## Telegram 私聊

本插件在协调节点上运行，通过 Bot API 长轮询接收消息。为每个 Bot 运行一个轮询实例并关闭该 Bot 既有的 webhook。将 BotFather 提供的令牌放进环境变量，在插件配置中填写可访问此系统的 Telegram 数字用户 ID。

```yaml
telegram:
  tokenEnv: TELEGRAM_BOT_TOKEN
  allowedUserIds: ["123456789"]
```

同一 Bot、私聊及发送者的组合绑定同一持久化 L1。普通文本提交给 L1。用户收到显式发信产生的消息，以及随任务状态就地更新的精简卡片。点击「查看只读会话」可按需读取该任务的记录。

| 命令 | 操作 |
| --- | --- |
| `/models` | 查看可选 L1 模型及介绍 |
| `/model 序号` 或 `/model 模型ID` | 切换当前会话的 L1 模型 |
| `/tasks` | 查看本对话的任务 |
| `/inspect 任务ID` | 阅读本对话所属任务的底层会话 |

投递凭据和 Telegram 更新游标默认保存在 `$DSH_HOME/data/prism/im.sqlite`，可通过 `statePath` 覆盖。重启后网关从已确认的位置继续，补发离线期间的主动消息。Bot API 发送和本地 SQLite 提交分别完成，若进程在两者之间中断，一条已送达的消息有可能重复。

接入其他 IM 时，使用导出的 `ImTransport`、`ImGateway` 和 `GatewayState`。通道适配器负责验证发送者、用户授权和私聊归属，并为每条入站事件提供稳定的 ID。将确认过的事件传给 `gateway.receive`，在其成功后向平台确认接收。启动时调用 `gateway.start()` 以恢复已有订阅。
