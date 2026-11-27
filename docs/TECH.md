# IM 网关技术参考

完整应用使用五个私有插件仓库，需要已获全部读取权限的 Git 凭据。在公开仓库根目录执行 `node scripts/checkout.mjs` 后进入 `runtime/`，再从该目录运行 npm、配置和启动命令。官网和使用文档可公开访问。[棱镜官网](https://prism.dsh-plug.in/)

## 会话绑定与本地设置

一个入站身份由通道及机器人、私聊和发送者共同标识。网关将这个组合映射为固定的 L1 所有者。从另一个机器人、通道或 Web 页面访问时会使用各自的会话历史。网关先验证平台事件和私聊归属，再检查身份是否获准。通道应只在其所属的协调节点上启用。

DSH 网页端安装模式下，新用户直接私聊机器人即可发起审批。待审批卡片只显示渠道、可获取的用户名及用户 ID。网关将批准和首条消息入队写入同一个事务，拒绝后清除待处理的消息。

在「棱镜/IM」中，飞书扫码授权页支持选择已有机器人。成功后网关保存 App ID 和 App Secret，从飞书读取机器人昵称，并向设置页返回 App ID、昵称和密钥保存状态。手动绑定会先校验应用凭据再保存。飞书和微信的扫码人首次私聊也须经审批。

独立部署可使用集成仓库中的 `npm run im`。先将 `prism.example.json` 复制为 `prism.config.json`，再用同一份文件完成配置和启动。微信和飞书的本地登录流程会提示扫码，把注册凭据写入所配置的私有网关状态库并启用相应通道。对登录前已经在运行的宿主，修改配置后重新启动。

```sh
npm run im -- login wechat --config prism.config.json
npm run im -- login feishu --config prism.config.json
```

为某个通道生成一次性配对码时，将下面命令中的 `telegram` 替换为实际的通道键。在平台的机器人私聊中发送 CLI 输出的 `/pair` 命令。配对码按通道限定、在十分钟后失效，成功消费一次即作废。已知平台用户 ID 也可直接写入相应通道的 `allowedUserIds`。这两种方法授权的是对应的私聊身份。

```sh
npm run im -- pair telegram --config prism.config.json
```

Telegram、企业微信、QQ 机器人、OneBot 和 Discord 可通过本地向导启用。将命令中的 `discord` 改为目标通道键。向导只询问公开标识，列出运行 DSH 的环境所需的凭据变量名，并打印一次性配对命令。使用修改后的文件重新启动 DSH。

```sh
npm run im -- setup discord --config prism.config.json
```

## 通道配置

内置通道覆盖的聊天平台参照 GugleComote，表中列出棱镜实际使用的协议、配置和任务更新方式。[GugleComote](https://github.com/Gu-ZT/Comote)

以下键均位于集成配置的 `im` 下。设置命令省略 `--config` 时，状态库默认使用 `$DSH_HOME/data/prism/im.sqlite`，通道还需在宿主配置中启用。自定义数据库通过 `im.statePath` 指定。

| 通道 | 入站和身份 | 配置与投递 |
| --- | --- | --- |
| `telegram` | Bot API 长轮询，按 Bot、私聊和数字用户 ID 识别 | 使用 BotFather 创建机器人。默认从 `TELEGRAM_BOT_TOKEN` 读取令牌，可用 `tokenEnv` 指定变量。每个 Bot 只运行一个轮询实例，并关闭该 Bot 既有 webhook。任务状态更新同一条卡片，按钮可打开只读会话。 |
| `wechat` | 微信 iLink 扫码注册，使用已绑定账户长轮询文本私聊 | 首次执行 `login wechat`，授权信息、收件游标与私聊上下文存于本地。回复依赖微信发来的有效上下文。状态变化会追加文本，凭据失效时重新登录。 |
| `feishu` | 飞书或 Lark 应用机器人私聊 | 首次执行 `login feishu` 扫码注册应用，或配置已有应用的 `appId`、`appSecretEnv`（默认 `FEISHU_APP_SECRET`）及 `domain`（`feishu` 或 `lark`）。使用 WebSocket 长连接订阅 `im.message.receive_v1`，以 open ID 识别 P2P 文本用户，按原消息更新折叠卡片。确保应用拥有读取相关私聊、以机器人身份发信及更新消息所需的租户权限，审批取决于租户设置。 |
| `wecom` | 企业微信智能机器人单聊 | 在企业微信管理端创建支持长连接的智能机器人，配置 `botId` 及 `secretEnv`（默认 `WECOM_BOT_SECRET`）。SDK 建立出站连接并接收单聊文本，按企业微信用户 ID 发送 Markdown 消息。主动发送返回请求回执，任务状态变化以新消息交付。 |
| `qq` | QQ 官方机器人 C2C 事件，签名回调 `POST /prism/im/qq` | 配置 `appId` 及 `appSecretEnv`（默认 `QQ_BOT_SECRET`），使用平台的 Ed25519 回调校验和事件订阅。被动回复采用五分钟窗口内的四个回复位，窗口外的主动投递取决于平台授权和额度。任务状态变化追加文本。 |
| `onebot` | OneBot 11 好友私聊，签名反向 HTTP 事件 `POST /prism/im/onebot` | 配置 `selfId`、`apiBase`、`accessTokenEnv`（默认 `ONEBOT_ACCESS_TOKEN`）和 `eventSecretEnv`（默认 `ONEBOT_EVENT_SECRET`）。接收端校验 `X-Self-ID` 及 HMAC-SHA1，发送端通过 HTTP API 调用 `send_private_msg`。状态变化追加文本。 |
| `discord` | Discord Gateway 的机器人 DM 和私聊按钮事件 | 默认读取 `DISCORD_BOT_TOKEN`，可覆盖 `tokenEnv`。按用户 ID 列表或配对记录授权。使用 Direct Messages intent 和出站网关连接，更新已有任务消息，提供查看按钮。 |

QQ 和 OneBot 使用不同的签名格式和连接协议。回调 URL 需要从平台或 OneBot 实例路由到相应 Prism 宿主。[QQ 与 OneBot 协议配置和来源](transport-protocols.md)

飞书应用订阅 `im.message.receive_v1`，并配置 `im:message.p2p_msg:readonly`、`im:message:send_as_bot` 和 `im:message:update` 三个权限。人工提供应用凭据时，检查租户已批准相应权限。[飞书私聊接收事件](https://github.com/larksuite/cli/blob/c5fbf1a52df77d5cb9cac2b1501770b2fb9af7d2/events/im/register.go#L17-L29) · [机器人发信](https://github.com/larksuite/cli/blob/c5fbf1a52df77d5cb9cac2b1501770b2fb9af7d2/skills/lark-im/references/lark-im-messages-send.md#L283) · [更新卡片](https://github.com/larksuite/cli/blob/c5fbf1a52df77d5cb9cac2b1501770b2fb9af7d2/skills/lark-im/SKILL.md#L261)

## 通用命令和主动投递

| 命令 | 用途 |
| --- | --- |
| `/models` | 查看本对话可选的 L1 模型与介绍。 |
| `/model 序号` 或 `/model 模型ID` | 切换后续轮次使用的 L1 模型。 |
| `/tasks` | 查看当前对话拥有的后台任务。 |
| `/inspect 任务ID` | 按任务归属读取正式 DSH 会话的只读记录。 |
| `/language` 或 `/language zh` | 查看当前语言及选项，或设置此私聊的命令与任务状态语言。 |
| `/pair 配对码` | 授权由本机 CLI 生成配对码的私聊。 |

网关根据通道提供的语言信息、私聊语言偏好及默认设置选择文案。支持 `de`、`en`、`es`、`fr`、`ja`、`pt`、`ru`、`zh`。普通私聊文本进入 L1，助手可见消息只来自 `send_user`。排队、进行中、已完成和失败等任务状态独立投递。通道支持编辑时更新已有消息，其他通道追加一条状态通知。平台开放的主动发送窗口、权限或配额会影响送达时间。

SQLite 保存目标身份、私聊授权、平台游标和投递回执。重启后恢复订阅并继续投递。发出平台消息与提交本地回执分两步完成，如果进程在中间退出，已送达的消息可能被重发。

## 接入新的传输实现

扩展接口为 `ImTransport`、`ImGateway` 和 `GatewayState`。平台适配器负责认证入站事件、核实目标私聊和稳定入站 ID，提供发送与编辑实现。验证后的事件传给 `gateway.receive`，成功后再向平台确认接收。运行时调用 `gateway.start()` 恢复订阅，并在宿主退出时关闭网关。这个扩展接口与上表列出的七个内置通道共用同一套鉴权、主体验证和任务归属规则。
