# Discord Bot Starter

A five-bot Discord audio system using Node.js and discord.js. Every configured bot responds to the same voice commands and shares a web-managed audio library.

## Setup

1. Revoke every token previously shared in chat and generate a new token for each bot.
2. Create a `.env` file by copying `.env.example`.
3. Fill in `DISCORD_TOKEN_1` through `DISCORD_TOKEN_5`, matching `CLIENT_ID_1` through `CLIENT_ID_5`.
4. Set a private `WEB_ADMIN_KEY` for the audio dashboard. Leave `GUILD_ID` empty unless it is a real numeric server ID.
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
| `!j1` through `!j5` | Join and play the assigned audio slot |
| `!s` | Stop the current audio |

Each command is handled once and broadcast concurrently to every online bot. One reply reports how many bots completed the action.

In the Developer Portal, enable the **Message Content Intent** under **Bot → Privileged Gateway Intents**. The bot also needs the `View Channel`, `Connect`, and `Speak` permissions in the voice channel.

When `GUILD_ID` is set, slash commands are registered in that server and appear quickly. Without it, commands are registered globally and can take up to an hour to appear.

## Deploy on Render

Create a **Background Worker** from this repository. Set **Root Directory** to blank (the repository root), **Build Command** to `npm install`, and **Start Command** to `npm start`. Do not use `node src/index.js` as the Render start command. Do not set the root directory to `src`; `src` is a folder containing the implementation, not the project root. Add `DISCORD_TOKEN` and `CLIENT_ID` as Render environment variables. Add `GUILD_ID` only when it is the real numeric ID of your Discord server; otherwise leave it empty.

If the Render service is configured as a **Web Service**, the bot now exposes a health endpoint on Render's `PORT` at `/health`. A **Background Worker** is still the better service type for a Discord bot because it does not require an HTTP endpoint.

The included `render.yaml` contains the same worker configuration for Blueprint deploys.

## Invite the bot

In the Developer Portal, create an OAuth2 invite URL with these scopes:

- `bot`
- `applications.commands`

The bot only needs the `Send Messages` permission for the included commands.

## Web audio dashboard

Open the deployed service URL with `?key=YOUR_WEB_ADMIN_KEY`, for example `https://your-service.onrender.com/?key=...`. Upload audio files and assign them to `!j1` through `!j5`. The dashboard key is stored in the browser after the first visit. Uploaded files are runtime data; configure persistent storage in Render if uploads must survive redeploys.
