require('dotenv').config();

const path = require('node:path');
const express = require('express');
const {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
} = require('discord.js');
const {
  VoiceConnectionStatus,
  createAudioPlayer,
  entersState,
  joinVoiceChannel,
} = require('@discordjs/voice');
const rootDir = __dirname;
const port = Number(process.env.PORT) || 10000;
const adminKey = process.env.WEB_ADMIN_KEY;
const guildId = /^\d{17,20}$/.test(process.env.GUILD_ID || '') ? process.env.GUILD_ID : undefined;

function configuredBots() {
  return Array.from({ length: 5 }, (_, index) => ({
    number: index + 1,
    token: process.env[`DISCORD_TOKEN_${index + 1}`],
    clientId: process.env[`CLIENT_ID_${index + 1}`],
  })).filter((bot) => bot.token && !bot.token.startsWith('replace-with-'));
}

const sessions = new Map();
const bots = [];

async function connectToMemberChannel(bot, member) {
  if (!member.voice.channel) throw new Error('Join a voice channel first.');
  return connectToChannel(bot, member.guild, member.voice.channel);
}

async function connectToChannel(bot, guild, channel) {
  const permission = channel.permissionsFor(guild.members.me);
  if (!permission?.has([PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
    throw new Error('I need Connect and Speak permissions in that voice channel.');
  }

  const key = `${bot.number}:${guild.id}`;
  const existing = sessions.get(key);
  if (existing && existing.channelId === channel.id) return existing;
  if (existing) existing.connection.destroy();

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
  });
  const player = createAudioPlayer();
  connection.subscribe(player);
  connection.on('error', (error) => console.error(`Bot ${bot.number} voice error:`, error));
  const session = { channelId: channel.id, connection, player };
  sessions.set(key, session);

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    return session;
  } catch (error) {
    connection.destroy();
    sessions.delete(key);
    throw new Error(error.code === 'ABORT_ERR'
      ? 'Voice connection timed out. Check Connect and Speak permissions.'
      : error.message);
  }
}

async function runWebControl(action, guildIdToControl, channelIdToControl) {
  const activeBots = bots.filter((bot) => bot.status === 'online');
  if (!activeBots.length) throw new Error('No bots are online yet.');
  const results = await Promise.allSettled(activeBots.map(async (bot) => {
    const requestedChannel = channelIdToControl && bot.client.channels.cache.get(channelIdToControl);
    const guild = (requestedChannel?.guild) || bot.client.guilds.cache.get(guildIdToControl);
    if (action === 'disconnect' && !guildIdToControl && !requestedChannel) {
      const disconnected = [...sessions.keys()]
        .filter((key) => key.startsWith(`${bot.number}:`))
        .map((key) => disconnect(bot.number, key.split(':')[1]))
        .some(Boolean);
      return disconnected;
    }
    if (action === 'stop' && !guildIdToControl && !requestedChannel) {
      const stopped = [...sessions.entries()]
        .filter(([key]) => key.startsWith(`${bot.number}:`))
        .map(([, session]) => { session.player.stop(); return true; });
      return stopped.length > 0;
    }
    if (!guild) throw new Error(`Bot ${bot.number} is not in that server.`);

    if (action === 'disconnect') return disconnect(bot.number, guild.id);
    const session = sessions.get(`${bot.number}:${guild.id}`);
    if (action === 'stop') {
      session?.player.stop();
      return Boolean(session);
    }

    const channel = requestedChannel || guild.channels.cache.get(channelIdToControl);
    if (!channel?.isVoiceBased()) throw new Error(`Voice channel was not found for bot ${bot.number}.`);
    await connectToChannel(bot, guild, channel);
    return true;
  }));
  const failed = results.filter((result) => result.status === 'rejected');
  return {
    completed: results.length - failed.length,
    total: results.length,
    errors: failed.map((result) => result.reason?.message || 'Command failed'),
  };
}

function disconnect(botNumber, guildIdToDisconnect) {
  const key = `${botNumber}:${guildIdToDisconnect}`;
  const session = sessions.get(key);
  if (!session) return false;
  session.player.stop();
  session.connection.destroy();
  sessions.delete(key);
  return true;
}

async function runForAllBots(command, message) {
  const activeBots = bots.filter((bot) => bot.status === 'online');
  if (!activeBots.length) throw new Error('No bots are online yet.');

  const results = await Promise.allSettled(activeBots.map(async (bot) => {
    if (command === '!j') {
      await connectToMemberChannel(bot, message.member);
      return `Bot ${bot.number} joined`;
    }

    if (command === '!d') {
      return disconnect(bot.number, message.guild.id) ? `Bot ${bot.number} disconnected` : `Bot ${bot.number} was not connected`;
    }

    if (command === '!s') {
      const session = sessions.get(`${bot.number}:${message.guild.id}`);
      session?.player.stop();
      return session ? `Bot ${bot.number} stopped` : `Bot ${bot.number} was not playing`;
    }

    return null;
  }));

  const failed = results.filter((result) => result.status === 'rejected');
  if (failed.length) {
    console.error('Some bot commands failed:', failed.map((result) => result.reason));
  }
  return `${results.length - failed.length}/${results.length} bots completed ${command}.${failed.length ? ` ${failed.length} failed; check bot permissions.` : ''}`;
}

function attachBot(bot) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
  const botState = { ...bot, client, status: 'starting' };
  bots.push(botState);

  client.once('ready', (readyClient) => {
    botState.status = 'online';
    botState.tag = readyClient.user.tag;
    console.log(`Bot ${bot.number} logged in as ${readyClient.user.tag}`);
  });

  client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild || !message.content.startsWith('!')) return;
    const command = message.content.trim().toLowerCase();
    const controller = bots.find((candidate) => candidate.status === 'online');
    if (controller && botState.number !== controller.number) return;
    try {
      if (['!j', '!s', '!d'].includes(command)) {
        await message.reply(await runForAllBots(command, message));
      }
    } catch (error) {
      console.error(`Bot ${bot.number} command failed:`, error);
      await message.reply(`I could not complete that command: ${error.message}`);
    }
  });

  client.login(bot.token).catch((error) => {
    botState.status = 'error';
    console.error(`Bot ${bot.number} failed to start:`, error.message);
  });
}

function requireAdmin(request, response, next) {
  if (!adminKey || request.get('x-admin-key') !== adminKey) return response.status(401).json({ error: 'Invalid dashboard key.' });
  next();
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(rootDir, 'public')));
app.get('/health', (request, response) => response.json({ status: 'ok', bots: bots.map((bot) => ({ number: bot.number, status: bot.status })) }));
app.get('/api/bots', requireAdmin, (request, response) => response.json(bots.map((bot) => ({ number: bot.number, status: bot.status, tag: bot.tag || null }))));
app.get('/api/discord-context', requireAdmin, (request, response) => {
  const controller = bots.find((bot) => bot.status === 'online');
  if (!controller) return response.json({ guilds: [] });
  const guilds = [...controller.client.guilds.cache.values()].map((guild) => ({
    id: guild.id,
    name: guild.name,
    channels: [...guild.channels.cache.values()]
      .filter((channel) => channel.isVoiceBased())
      .map((channel) => ({ id: channel.id, name: channel.name }))
  }));
  response.json({ guilds });
});
app.post('/api/control', requireAdmin, async (request, response) => {
  const { action, guildId: targetGuildId, channelId: targetChannelId } = request.body || {};
  if (!['join', 'stop', 'disconnect'].includes(action)) {
    return response.status(400).json({ error: 'Choose a valid server and action.' });
  }
  if (action === 'join' && !/^\d{17,20}$/.test(targetChannelId || '')) {
    return response.status(400).json({ error: 'Choose a voice channel.' });
  }
  try {
    response.json(await runWebControl(action, targetGuildId, targetChannelId));
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
});

app.listen(port, '0.0.0.0', () => console.log(`Web dashboard listening on port ${port}`));

const configured = configuredBots();
if (!configured.length) console.warn('No bot tokens configured. Add DISCORD_TOKEN_1 through DISCORD_TOKEN_5 in Render.');
configured.forEach(attachBot);
