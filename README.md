# Discord Bot Starter

A Discord bot using Node.js and discord.js that can play the included MP3 files.

## Setup

1. In the Discord Developer Portal, revoke the token that was previously shared and generate a new one.
2. Create a `.env` file by copying `.env.example`.
3. Fill in `DISCORD_TOKEN`, `CLIENT_ID`, and optionally `GUILD_ID`.
4. Install dependencies:

   ```powershell
   npm install
   ```

5. Start the bot:

   ```powershell
   npm start
   ```

## Voice commands

The user and bot must be in the same server. Use these commands in a text channel:

| Command | Action |
| --- | --- |
| `!j` | Join your voice channel |
| `!d` | Disconnect from voice |
| `!j1` | Play `1.mp3` |
| `!j2` | Play `2.mp3` |
| `!j3` | Play `4.mp3` |
| `!j4` | Play `5.mp3` |
| `!j5` | Play `6.mp3` |
| `!s` | Stop the current audio |

In the Developer Portal, enable the **Message Content Intent** under **Bot → Privileged Gateway Intents**. The bot also needs the `View Channel`, `Connect`, and `Speak` permissions in the voice channel.

When `GUILD_ID` is set, slash commands are registered in that server and appear quickly. Without it, commands are registered globally and can take up to an hour to appear.

## Deploy on Render

Create a **Background Worker** from this repository. Set **Root Directory** to blank (the repository root), **Build Command** to `npm install`, and **Start Command** to `npm start`. Do not use `node src/index.js` as the Render start command. Do not set the root directory to `src`; `src` is a folder containing the implementation, not the project root. Add `DISCORD_TOKEN` and `CLIENT_ID` as Render environment variables. Add `GUILD_ID` only when it is the real numeric ID of your Discord server; otherwise leave it empty.

The included `render.yaml` contains the same worker configuration for Blueprint deploys.

## Invite the bot

In the Developer Portal, create an OAuth2 invite URL with these scopes:

- `bot`
- `applications.commands`

The bot only needs the `Send Messages` permission for the included commands.
