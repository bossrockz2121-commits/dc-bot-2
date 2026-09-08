# Discord Bot Starter

A five-bot Discord voice system using Node.js and discord.js. Every configured bot responds to the same voice commands and can be controlled from the web dashboard.

## Setup

1. Revoke every token previously shared in chat and generate a new token for each bot.
2. Create a `.env` file by copying `.env.example`.
3. Fill in `DISCORD_TOKEN_1` through `DISCORD_TOKEN_5`. Client IDs are not required for this bot runtime.
4. Set a private `WEB_ADMIN_KEY` for the voice-control dashboard. Leave `GUILD_ID` empty unless it is a real numeric server ID.
5. Install dependencies:

   ```powershell
   npm install
   ```

6. Start the bot:

   ```powershell
   npm start
   ```

## Voice commands

The user and bot must be in the same server. Use these commands in a text channel:

| Command | Action |
| --- | --- |
| `!j` | Join your voice channel |
| `!d` | Disconnect from voice |
| `!s` | Stop all bot voice players |

Each command is handled once and broadcast concurrently to every online bot. One reply reports how many bots completed the action.

In the Developer Portal, enable the **Message Content Intent** under **Bot → Privileged Gateway Intents**. The bot also needs the `View Channel`, `Connect`, and `Speak` permissions in the voice channel.

## Deploy on Render

Create a **Web Service** from this repository. Set **Root Directory** to blank (the repository root), **Build Command** to `npm install`, and **Start Command** to `npm start`. Do not use `node src/index.js` as the Render start command. Do not set the root directory to `src`; `src` is a folder containing the implementation, not the project root. Add all five `DISCORD_TOKEN_1` through `DISCORD_TOKEN_5` and `WEB_ADMIN_KEY` as Render environment variables. Client IDs are not required. Add `GUILD_ID` only when it is the real numeric ID of your Discord server; otherwise leave it empty.

The dashboard is available at the deployed service URL. Open it and log in with the exact `WEB_ADMIN_KEY` from Render. The page shows the status of all five bot slots before enabling controls. If a bot says `missing-token`, add its matching `DISCORD_TOKEN_1` through `DISCORD_TOKEN_5` environment variable in Render. Paste a Discord voice channel ID and click **Join All Bots**. Every online bot will join that channel. **Stop All** and **Disconnect All** control every active voice session. The bot accounts must already be invited to the channel's server and have `Connect` and `Speak` permissions.

The included `render.yaml` contains the same Web Service configuration for Blueprint deploys.

## Invite the bot

In the Developer Portal, create an OAuth2 invite URL with these scopes:

- `bot`
- `applications.commands`

The bot only needs the `Send Messages` permission for the included commands.

