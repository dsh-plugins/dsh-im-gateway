# OneBot v11 and official QQ Bot

Both transports receive authenticated callbacks at the Prism DSH Web host. Configure the host's trusted origin or reverse proxy for the callback hostname. The transport namespace includes the bot account ID. The gateway checks the recipient allowlist or a previously redeemed pairing code before delivering user content. A new contact can enroll by sending a one-time pairing command to the bot in private.

## OneBot v11

Configure the implementation's HTTP action server, reverse HTTP event reporter and the following Prism IM settings.

```json
{
  "onebot": {
    "selfId": "123456789",
    "apiBase": "http://127.0.0.1:5700",
    "accessTokenEnv": "ONEBOT_ACCESS_TOKEN",
    "eventSecretEnv": "ONEBOT_EVENT_SECRET",
    "allowedUserIds": ["987654321"]
  }
}
```

The action server's access token goes in `ONEBOT_ACCESS_TOKEN`. Set the reverse HTTP reporter's `secret` and the corresponding `ONEBOT_EVENT_SECRET` to the same value. Use HTTPS for an action service on another machine. Point the reporter to `/prism/im/onebot` on the DSH endpoint.

The webhook verifies the OneBot v11 `X-Self-ID` and HMAC-SHA1 `X-Signature` over the original bytes. It accepts friend private-message events. String and array message formats are supported for text. The outbound action client checks `get_login_info` against the configured account and calls `send_private_msg` with an explicit text segment so literal CQ codes in model output remain text. A task status change is delivered as a new message with its scoped `/inspect` command. OneBot v11 defines no edit-message action. Its send API also has no client-side idempotency key. Losing an HTTP success response can cause a repeated send when the gateway retries. [Reverse HTTP events](https://github.com/botuniverse/onebot-11/blob/master/communication/http-post.md) · [Public actions](https://github.com/botuniverse/onebot-11/blob/master/api/public.md)

## Official QQ Bot

Create a bot in the QQ open platform, enable C2C event subscription and direct text messaging, and register the public HTTPS callback at `/prism/im/qq`. Use the app ID and app secret from that bot. Allowlisted values are app-specific user OpenIDs.

```json
{
  "qq": {
    "appId": "123456789",
    "appSecretEnv": "QQ_BOT_SECRET",
    "allowedUserIds": ["YOUR_USER_OPENID"]
  }
}
```

The callback authenticates event dispatches using the Ed25519 signature over the timestamp and raw body. URL registration supports both Tencent’s documented OP 13 app ID and plain-token challenge and the signed challenge used by its SDK. C2C message events use the authenticated sender's OpenID and the platform message ID. The client obtains and caches an app access token from `https://api.bot.qq.com/app/getAppAccessToken`, then sends text via `POST /v2/users/{user_openid}/messages` with `Authorization: QQBot …`. [QQ authentication](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/api-use.html) · [Webhook event delivery](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html) · [Tencent webhook implementation](https://github.com/tencent-connect/botgo/blob/master/interaction/webhook/webhook.go)

Prism uses up to four numbered passive replies during the first five minutes after an accepted message. It persists the allocated message sequence for retries. Outside this window it uses the proactive C2C endpoint subject to the bot's permissions, platform quotas, friendship and the user's push preference. A rejected send remains pending in the gateway. An ambiguous proactive delivery can repeat after retry because the proactive endpoint offers no client message ID. Status updates appear as follow-up messages. Text cards include `/inspect` for read-only session access. [QQ C2C messages](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html) · [Incoming C2C event](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html)
