# Discord Guide (Morpheus)

Language: **English** | [Português (pt-BR)](discord.pt-BR.md)

This guide covers the full Morpheus Discord setup and operation:

- connecting the bot to one or more servers;
- allowing guilds in `.env`;
- registering native slash commands;
- enabling specific channels for fixed-task mode;
- sending and receiving media (image/audio/file);
- understanding `DISCORD_INSTANCE_ID`;
- validating that the bot is working.

## How Discord works in Morpheus

- One bot (Discord app) can join multiple servers.
- Morpheus only processes messages from guilds listed in `DISCORD_ALLOWED_GUILD_IDS`.
- Native slash commands are registered automatically for each allowed guild when Morpheus starts.
- `channel-enable` supports autocomplete for project and runner selection.
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
2. Under `Scopes`, select `bot` and `applications.commands`.
3. Under `Bot Permissions`, grant at least:
   - `View Channels`
   - `Send Messages`
   - `Attach Files`
   - `Read Message History`
4. Open the generated URL and choose the server.

## 3) Get Guild ID and User ID

1. In Discord, enable `User Settings > Advanced > Developer Mode`.
2. `Guild ID`: right-click server name -> `Copy Server ID`.
3. `User ID`: right-click your user -> `Copy User ID`.

## 4) Configure `.env`

File: `<morpheus-root>/.env`

```env
DISCORD_ENABLED=true
DISCORD_BOT_TOKEN=YOUR_TOKEN
DISCORD_ALLOWED_GUILD_IDS=111111111111111111,222222222222222222
DISCORD_ADMIN_USER_IDS=999999999999999999
DISCORD_INSTANCE_ID=morpheus-discord
DISCORD_MESSAGE_MAX_LENGTH=1900
DISCORD_MEDIA_MAX_BYTES=8388608
WHATSAPP_ENABLED=false
```

Notes:

- `DISCORD_ALLOWED_GUILD_IDS`: supports multiple servers (CSV).
- `DISCORD_ADMIN_USER_IDS`: users allowed to run admin commands in Discord.
- `DISCORD_MEDIA_MAX_BYTES`: max attachment size for Discord upload/download (default: 8 MB).
- `WHATSAPP_ENABLED=false`: optional, useful when you want Discord-only operation.
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
When Morpheus starts, it registers slash commands for every guild listed in `DISCORD_ALLOWED_GUILD_IDS`.

## 6) Enable channels (fixed task per channel)

In the channel that should run tasks:

```text
/channel-enable
```

Optionally set project and runner at the same time. Both fields support autocomplete in Discord:

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
- `/projects` -> lists the available projects.
- `/project` -> shows or changes the current project.
- `/task` -> shows or changes the focused task.

## 7) One bot across many servers

You can use the same Discord app/bot in multiple servers:

1. Invite the bot to each server.
2. Add new guild IDs to `DISCORD_ALLOWED_GUILD_IDS`.
3. Restart Morpheus so the slash commands register for the new guilds.
4. Run `/channel-enable` in desired channels of each server.

## 8) Important behavior

- The bot does not run automatically in all channels.
- Only channels enabled with `/channel-enable` are processed.
- Non-enabled channels stay silent.
- Slash commands are the primary entrypoint. Text commands remain compatible where supported.
- Outbound media is supported on Discord (image/audio/file) with text fallback on upload errors.
- Inbound Discord attachments are processed together with text (except slash commands).
- WhatsApp only runs in parallel when `WHATSAPP_ENABLED=true`.

## 9) Quick troubleshooting

- Bot is online but does not reply anywhere:
  - check `DISCORD_ENABLED=true`;
  - check `DISCORD_BOT_TOKEN`;
  - check `DISCORD_ALLOWED_GUILD_IDS`;
  - check that `Message Content Intent` is enabled.
- Slash commands are missing from Discord:
  - restart Morpheus after updating `DISCORD_ALLOWED_GUILD_IDS`;
  - confirm the bot is installed in that guild;
  - if needed, reinstall the bot with the `applications.commands` scope;
  - confirm the command registration step completed in logs.
- It replies in one server and ignores another:
  - likely missing guild ID in `.env`.
- Admin command denied:
  - your user ID is not in `DISCORD_ADMIN_USER_IDS`.
- Duplicate replies:
  - avoid running multiple Morpheus instances with the same bot token at once.
- Attachment upload/download failing:
  - check `DISCORD_MEDIA_MAX_BYTES` and Discord channel permission to attach files.
