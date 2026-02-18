# Discord Guide (Morpheus)

Language: **English** | [Português (pt-BR)](discord.pt-BR.md)

This guide covers the full Morpheus Discord setup and operation:

- connecting the bot to one or more servers;
- allowing guilds in `.env`;
- enabling specific channels for fixed-task mode;
- understanding `DISCORD_INSTANCE_ID`;
- validating that the bot is working.

## How Discord works in Morpheus

- One bot (Discord app) can join multiple servers.
- Morpheus only processes messages from guilds listed in `DISCORD_ALLOWED_GUILD_IDS`.
- In each allowed guild, channels start disabled.
- An admin enables a channel using `/channel-enable`.
- Each enabled channel gets its own fixed task context.
- Non-enabled channels remain silent.

## 1) Create/use a Discord app (bot)

1. Open the [Discord Developer Portal](https://discord.com/developers/applications).
2. Select your existing app (or create a new one).
3. In `Bot`, copy the token.
4. In `Bot > Privileged Gateway Intents`, enable `Message Content Intent`.

## 2) Invite the bot to a server

1. In the app, open `OAuth2 > URL Generator`.
2. Under `Scopes`, select `bot`.
3. Under `Bot Permissions`, grant at least:
   - `View Channels`
   - `Send Messages`
   - `Read Message History`
4. Open the generated URL and choose the server.

## 3) Get Guild ID and User ID

1. In Discord, enable `User Settings > Advanced > Developer Mode`.
2. `Guild ID`: right-click server name -> `Copy Server ID`.
3. `User ID`: right-click your user -> `Copy User ID`.

## 4) Configure `.env`

File: `/Users/matheus/development/development/morpheus/.env`

```env
DISCORD_ENABLED=true
DISCORD_BOT_TOKEN=YOUR_TOKEN
DISCORD_ALLOWED_GUILD_IDS=111111111111111111,222222222222222222
DISCORD_ADMIN_USER_IDS=999999999999999999
DISCORD_INSTANCE_ID=morpheus-discord
DISCORD_MESSAGE_MAX_LENGTH=1900
```

Notes:

- `DISCORD_ALLOWED_GUILD_IDS`: supports multiple servers (CSV).
- `DISCORD_ADMIN_USER_IDS`: users allowed to run admin commands in Discord.
- `DISCORD_INSTANCE_ID`: internal message deduplication identifier.
  - It is not provided by Discord.
  - You can keep `morpheus-discord`.
  - Change it only if you run multiple Morpheus instances on the same database.

## 5) Restart Morpheus

From the project directory:

```bash
npm run dev
```

Confirm in logs that Discord client is connected.

## 6) Enable channels (fixed task per channel)

In the channel that should run tasks:

```text
/channel-enable
```

Optionally set project and runner at the same time:

```text
/channel-enable <projectId> <runnerKind>
```

Example:

```text
/channel-enable morpheus codex-cli
```

Useful commands:

- `/channel-info` -> shows channel status, focused task, project, and runner.
- `/channel-disable` -> disables the channel.
- `/new` -> resets channel context by creating a new focused task.

## 7) One bot across many servers

You can use the same Discord app/bot in multiple servers:

1. Invite the bot to each server.
2. Add new guild IDs to `DISCORD_ALLOWED_GUILD_IDS`.
3. Restart Morpheus.
4. Run `/channel-enable` in desired channels of each server.

## 8) Important behavior

- The bot does not run automatically in all channels.
- Only channels enabled with `/channel-enable` are processed.
- Non-enabled channels stay silent.
- WhatsApp keeps working in parallel.

## 9) Quick troubleshooting

- Bot is online but does not reply anywhere:
  - check `DISCORD_ENABLED=true`;
  - check `DISCORD_BOT_TOKEN`;
  - check `DISCORD_ALLOWED_GUILD_IDS`;
  - check that `Message Content Intent` is enabled.
- It replies in one server and ignores another:
  - likely missing guild ID in `.env`.
- Admin command denied:
  - your user ID is not in `DISCORD_ADMIN_USER_IDS`.
- Duplicate replies:
  - avoid running multiple Morpheus instances with the same bot token at once.
