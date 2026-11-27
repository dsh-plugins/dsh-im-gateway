<div align="center">

<img src="icon.svg" width="256" height="256" alt="dsh-im-gateway icon">

# dsh-im-gateway

**Send requests to Prism in a private chat and receive updates there as delegated tasks progress.**

English | [简体中文](README.zh_CN.md)

</div>

## Install in the DSH web app

Open **Plugins → Add plugin** and install and enable the five `@dsh-prism` packages in the order shown in the guide. To install this package, enter `@dsh-prism/dsh-im-gateway@0.1.1`. [Illustrated installation guide](https://prism.dsh-plug.in/guide/start)

Open **Settings → Prism/IM → Add IM** and choose Telegram, WeChat, Feishu / Lark, WeCom, QQ Bot, OneBot or Discord. For Feishu, use **QR binding** to select or create a bot on the authorization page, or use **Manual binding** to enter an existing app’s credentials. Once the channel is enabled, users can message the bot directly. The first message creates a request under **Pending approvals**, and Prism processes the message after you choose **Approve**. [Messaging channel walkthrough](https://prism.dsh-plug.in/guide/im)

Authorized private chats can accept downloadable JPEG, PNG, WebP, GIF, MP4, WebM, and MOV files. Each message can include up to eight files of 16 MiB each. Feishu apps need permission to read message resources. WeChat and WeCom encrypted downloads expire, and OneBot accepts media from recognized Tencent CDN hosts. If a file cannot be read, Prism asks you to upload it in the web app and still processes any accompanying text.

## Run the standalone host from source

Use Node.js 24.9 or later, npm, Git and credentials with read access to the five private plugin repositories. The checkout script places matching plugins and launcher files in a local `runtime/` directory. Run subsequent installation, configuration and launch commands there. The public guide is available without signing in. To use the example models, configure your DeepSeek credentials in DSH or set the `DEEPSEEK_API_KEY` environment variable. [Installation guide](https://prism.dsh-plug.in/)

```sh
git clone https://github.com/dsh-plugins/dsh-prism.git
cd dsh-prism
node scripts/checkout.mjs
cd runtime
npm ci
npm run build
npm start
```

## Configure a chat app on the standalone host

Before connecting a service, copy the sample configuration in your local `runtime/` directory. Each transport verifies the platform identity before handing a message to the conversation agent.

```sh
cp prism.example.json prism.config.json
```

| Chat service | Configuration key |
| --- | --- |
| Telegram | `im.telegram` |
| WeChat | `im.wechat` |
| Feishu / Lark | `im.feishu` |
| WeCom | `im.wecom` |
| QQ Bot | `im.qq` |
| OneBot | `im.onebot` |
| Discord | `im.discord` |

## Link a private chat on the standalone host

For WeChat or Feishu, run the appropriate login command on the Prism host and follow the QR login instructions. Using the same `--config` file for setup and startup stores the registration in the configured gateway database and enables that channel.

```sh
npm run im -- login wechat --config prism.config.json
```

Use `feishu` instead of `wechat` to set up Feishu. To authorize a user with a one-time code, run the pairing command for their channel and have them send the printed `/pair` command in a private chat before the code expires. Their channel, bot, private chat and sender determine which conversation they return to.

```sh
npm run im -- pair telegram --config prism.config.json
```

## Try a Telegram conversation

Create a bot with BotFather and store its token in the environment variable `TELEGRAM_BOT_TOKEN` on the Prism host. Run the setup command below. For WeCom, QQ Bot, OneBot or Discord, replace `telegram` with the channel key in the table. Setup asks for the public identifiers that channel needs and prints the credential environment variables and a private pairing command.

```sh
npm run im -- setup telegram --config prism.config.json
```

Start or restart Prism with the updated configuration. Open the bot’s private chat and send the printed `/pair` command within ten minutes. An operator can also explicitly allow known Telegram numeric user IDs under `im.telegram.allowedUserIds`.

```sh
npm start -- prism.config.json --host 127.0.0.1 --port 3080 --no-open
```

Send a request such as “Find the files that implement the login screen.” Use `/models` to read model descriptions and `/model 2` to choose the second entry. Use `/tasks` to see your tasks. Tap the task’s read-only session button or use `/inspect` with its task ID to see the underlying messages. Use `/language en` to change the language of gateway commands and status text. The supported codes are `de`, `en`, `es`, `fr`, `ja`, `pt`, `ru` and `zh`.

[Prism documentation](https://prism.dsh-plug.in/) · [Technical reference](docs/TECH.md)
