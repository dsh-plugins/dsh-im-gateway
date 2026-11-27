<div align="center">

<img src="icon.svg" width="256" height="256" alt="dsh-im-gateway 图标">

# dsh-im-gateway

**在私聊中向棱镜提出请求，并在任务推进时收到主动更新。**

[English](README.md) | 简体中文

</div>

## 在 DSH 网页端安装

在 DSH 的 **插件 → 添加插件** 中按安装指南列出的顺序安装并启用五个 `@dsh-prism` 包。此包可按完整包名 `@dsh-prism/dsh-im-gateway@0.1.1` 安装。[前端安装图解](https://prism.dsh-plug.in/zh/guide/start)

进入 **设置 → 棱镜/IM → 添加 IM**，选择 Telegram、微信、飞书 / Lark、企业微信、QQ 机器人、OneBot 或 Discord。飞书的 **扫码绑定** 支持在授权页面选择已有机器人或创建机器人，**手动绑定** 用于填写已有应用的凭据。启用渠道后，用户直接私聊机器人。首次私聊会出现在 **待审批用户** 中，选择 **同意** 后棱镜处理首条消息。[各渠道配置图解](https://prism.dsh-plug.in/zh/guide/im)

已授权的私聊支持接收平台可下载的 JPEG、PNG、WebP、GIF、MP4、WebM 和 MOV，每条消息最多 8 个媒体文件，每个文件最多 16 MiB。飞书应用需有读取消息资源的权限。微信和企业微信的加密媒体下载链接有时限。OneBot 只读取可识别的腾讯 CDN 媒体。无法读取的媒体会提示到棱镜网页上传，消息中的文字仍会处理。

## 从源码运行独立宿主

需要 Node.js 24.9 或更高版本、npm、Git，以及对五个私有插件仓库的 Git 读取权限。检出脚本把匹配的插件和启动文件放入本机的 `runtime/` 目录，后续安装、配置和运行命令均在该目录执行。公开使用指南可直接阅读。需要调用示例模型时，请先在 DSH 凭据存储中配置 DeepSeek 凭据，或设置环境变量 `DEEPSEEK_API_KEY`。[安装指南](https://prism.dsh-plug.in/zh/)

```sh
git clone https://github.com/dsh-plugins/dsh-prism.git
cd dsh-prism
node scripts/checkout.mjs
cd runtime
npm ci
npm run build
npm start
```

## 在独立宿主中配置聊天应用

接入通道前，先在本机的 `runtime/` 中复制示例配置。各适配器会先认证平台上的用户身份，再将消息交给对话代理。

```sh
cp prism.example.json prism.config.json
```

| 聊天服务 | 配置键 |
| --- | --- |
| Telegram | `im.telegram` |
| 微信 | `im.wechat` |
| 飞书 / Lark | `im.feishu` |
| 企业微信 | `im.wecom` |
| QQ 机器人 | `im.qq` |
| OneBot | `im.onebot` |
| Discord | `im.discord` |

## 在独立宿主中绑定私聊

使用微信或飞书时，请在棱镜宿主上运行对应登录命令，并按提示扫码。使用同一个 `--config` 文件配置和启动网关后，注册信息会写入所配置的网关数据库，相应通道会启用。

```sh
npm run im -- login wechat --config prism.config.json
```

如需接入飞书，将 `wechat` 换为 `feishu`。如需用一次性配对码授权用户，在宿主上为该通道运行配对命令，请用户在有效期内将终端打印的 `/pair` 命令发到私聊中。通道、机器人、私聊和发送者共同决定用户返回哪段对话。

```sh
npm run im -- pair telegram --config prism.config.json
```

## 在 Telegram 中试用

通过 BotFather 创建机器人，在棱镜宿主的环境变量 `TELEGRAM_BOT_TOKEN` 中保存令牌，然后运行以下设置命令。如需接入企业微信、QQ 机器人、OneBot 或 Discord，把 `telegram` 换为表中的通道键。配置向导会询问该平台所需的公开标识，列出凭据环境变量并打印私聊配对命令。

```sh
npm run im -- setup telegram --config prism.config.json
```

使用更新后的配置启动或重启棱镜。打开机器人私聊，在十分钟内发送终端打印的 `/pair` 命令。管理员也可直接在 `im.telegram.allowedUserIds` 中允许已知的 Telegram 数字用户 ID。

```sh
npm start -- prism.config.json --host 127.0.0.1 --port 3080 --no-open
```

发送一条请求，例如「找出实现登录页的文件」。使用 `/models` 阅读模型介绍，使用 `/model 2` 选择第 2 项。通过 `/tasks` 查看自己的任务，点击任务的只读会话按钮，或在 `/inspect` 后填写任务 ID，即可阅读底层消息。使用 `/language zh` 可以切换网关命令和状态文字的语言。可选语言代码为 `de`、`en`、`es`、`fr`、`ja`、`pt`、`ru` 和 `zh`。

[棱镜使用指南](https://prism.dsh-plug.in/zh/) · [技术参考](docs/TECH.md)
