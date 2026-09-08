require('dotenv').config();

const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const express = require('express');
const multer = require('multer');
const ffmpegPath = require('ffmpeg-static');
const {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
} = require('discord.js');
const {
  AudioPlayerStatus,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} = require('@discordjs/voice');
const rootDir = __dirname;
const audioDir = path.join(rootDir, 'audio');
const port = Number(process.env.PORT) || 10000;
const adminKey = process.env.WEB_ADMIN_KEY;
const guildId = /^\d{17,20}$/.test(process.env.GUILD_ID || '') ? process.env.GUILD_ID : undefined;
const logs = [];
fs.mkdirSync(audioDir, { recursive: true });

function addLog(level, message) {
  const entry = { time: new Date().toISOString(), level, message };
  logs.push(entry);
  if (logs.length > 100) logs.shift();
  console[level === 'error' ? 'error' : 'log'](`[${level.toUpperCase()}] ${message}`);
}

function configuredBots() {
  return Array.from({ length: 5 }, (_, index) => ({
    number: index + 1,
    token: process.env[`DISCORD_TOKEN_${index + 1}`],
    status: process.env[`DISCORD_TOKEN_${index + 1}`] && !process.env[`DISCORD_TOKEN_${index + 1}`].startsWith('replace-with-') ? 'starting' : 'missing-token',
  }));
}

const sessions = new Map();
const bots = [];

function getAudioPath(filename) {
  if (!filename || path.basename(filename) !== filename) return null;
  const filePath = path.join(audioDir, filename);
  return fs.existsSync(filePath) ? filePath : null;
}

async function playInDiscord(bot, session, filename) {
  const audioPath = getAudioPath(filename);
  if (!audioPath) throw new Error(`Audio file ${filename} was not found.`);
  if (session.audioProcess) session.audioProcess.kill();
  const ffmpeg = spawn(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-i', audioPath,
    '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1',
  ]);
  session.audioProcess = ffmpeg;
  let ffmpegError = '';
  ffmpeg.stderr.on('data', (data) => {
    ffmpegError += data.toString();
    addLog('error', `Bot ${bot.number} audio: ${data.toString().trim()}`);
  });
  ffmpeg.on('error', (error) => addLog('error', `Bot ${bot.number} audio process failed: ${error.message}`));
  session.player.play(createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw }));
  const started = new Promise((resolve) => {
    if (session.player.state.status === AudioPlayerStatus.Playing) resolve();
    else session.player.once(AudioPlayerStatus.Playing, resolve);
  });
  const failed = new Promise((_, reject) => session.player.once('error', reject));
  try {
    await Promise.race([started, failed, new Promise((_, reject) => setTimeout(() => reject(new Error(`Audio did not start${ffmpegError ? `: ${ffmpegError.trim()}` : '.'}`)), 15_000))]);
    addLog('info', `Bot ${bot.number} started playing ${filename}.`);
  } finally {
    session.audioProcess = null;
  }
}

async function connectToMemberChannel(bot, member) {
  if (!member.voice.channel) throw new Error('Join a voice channel first.');
  return connectToChannel(bot, member.guild, member.voice.channel);
}

async function connectToChannel(bot, guild, channel) {
  if (!channel.isVoiceBased()) throw new Error(`Channel ${channel.id} is not a voice channel.`);
  const botMember = guild.members.me || await guild.members.fetchMe();
  const permission = channel.permissionsFor(botMember);
  const missingPermissions = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]
    .filter((permissionFlag) => !permission?.has(permissionFlag));
  if (missingPermissions.length) {
    throw new Error(`Missing permissions: ${missingPermissions.join(', ')}.`);
  }

  const key = `${bot.number}:${guild.id}`;
  const existing = sessions.get(key);
  if (existing && existing.channelId === channel.id && existing.connection.state.status !== VoiceConnectionStatus.Destroyed) return existing;
  if (existing) safelyDestroy(existing.connection);

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    // Each bot is a separate Discord client, so it needs its own voice connection group.
    group: `bot-${bot.number}`,
    selfDeaf: false,
    selfMute: false,
  });
  const player = createAudioPlayer();
  connection.subscribe(player);
  connection.on('error', (error) => console.error(`Bot ${bot.number} voice error:`, error));
  connection.on('debug', (message) => addLog('info', `Bot ${bot.number} voice debug: ${message}`));
  const session = { channelId: channel.id, connection, player };
  sessions.set(key, session);
  connection.on('stateChange', (oldState, newState) => {
    addLog('info', `Bot ${bot.number} voice state: ${oldState.status} -> ${newState.status}.`);
    if (newState.status === VoiceConnectionStatus.Destroyed && sessions.get(key) === session) {
      sessions.delete(key);
      addLog('info', `Bot ${bot.number} voice session ended.`);
    }
  });
  addLog('info', `Bot ${bot.number} is joining voice channel ${channel.id}.`);

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    await confirmVoicePresence(bot, guild, channel.id);
    addLog('info', `Bot ${bot.number} confirmed in voice channel ${channel.id}.`);
    return session;
  } catch (error) {
    addLog('error', `Bot ${bot.number} voice handshake failed in state ${connection.state.status}: ${error.message}. Retrying once.`);
    try {
      connection.rejoin({ channelId: channel.id, selfDeaf: false, selfMute: false });
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
      await confirmVoicePresence(bot, guild, channel.id);
      addLog('info', `Bot ${bot.number} voice reconnect confirmed in channel ${channel.id}.`);
      return session;
    } catch (retryError) {
      addLog('error', `Bot ${bot.number} voice retry failed in state ${connection.state.status}: ${retryError.message}.`);
    safelyDestroy(connection);
    sessions.delete(key);
      throw new Error(retryError.code === 'ABORT_ERR'
        ? 'Discord voice UDP handshake timed out. Check Connect/Speak permissions and use a Render Background Worker; Web Services may not support the voice connection reliably.'
        : retryError.message);
    }
  }
}

async function confirmVoicePresence(bot, guild, channelId) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const cachedVoiceState = guild.voiceStates.cache.get(bot.client.user.id);
    if (cachedVoiceState?.channelId === channelId) return;
    const member = await guild.members.fetch(bot.client.user.id).catch(() => null);
    if (member?.voice?.channelId === channelId) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Discord did not confirm Bot ${bot.number} in voice channel ${channelId}. Check the bot's server membership and channel permissions.`);
}

function safelyDestroy(connection) {
  if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) return;
  try {
    connection.destroy();
  } catch (error) {
    if (!/already been destroyed/i.test(error.message)) throw error;
  }
}

async function runWebControl(action, guildIdToControl, channelIdToControl, filename) {
  const activeBots = bots.filter((bot) => bot.status === 'online');
  if (!activeBots.length) {
    const details = bots.map((bot) => `Bot ${bot.number}: ${bot.statusMessage || bot.status}`).join(' | ');
    throw new Error(`No bots are online. ${details || 'Add DISCORD_TOKEN_1 through DISCORD_TOKEN_5 in Render.'}`);
  }
  const results = await Promise.all(activeBots.map(async (bot) => {
    try {
      if (action === 'join') {
        // Give Discord a moment between gateway voice-state handshakes.
        await new Promise((resolve) => setTimeout(resolve, (bot.number - 1) * 500));
      }
      const requestedChannel = channelIdToControl
        ? await bot.client.channels.fetch(channelIdToControl).catch(() => null)
        : null;
      const guild = (requestedChannel?.guild) || bot.client.guilds.cache.get(guildIdToControl);
      if (action === 'disconnect' && !guildIdToControl && !requestedChannel) {
        const completed = [...sessions.keys()]
          .filter((key) => key.startsWith(`${bot.number}:`))
          .map((key) => disconnect(bot.number, key.split(':')[1]))
          .some(Boolean);
        return { bot: bot.number, completed };
      }
      if (action === 'stop' && !guildIdToControl && !requestedChannel) {
        const completed = [...sessions.entries()]
          .filter(([key]) => key.startsWith(`${bot.number}:`))
          .map(([, session]) => { session.player.stop(); if (session.audioProcess) session.audioProcess.kill(); return true; }).length > 0;
        return { bot: bot.number, completed };
      }
      if (!guild) throw new Error(`Cannot access channel ${channelIdToControl}. Invite Bot ${bot.number} to the channel's server.`);
      if (action === 'disconnect') return { bot: bot.number, completed: disconnect(bot.number, guild.id) };
      const session = sessions.get(`${bot.number}:${guild.id}`);
      if (action === 'stop') {
        session?.player.stop();
        if (session?.audioProcess) session.audioProcess.kill();
        return { bot: bot.number, completed: Boolean(session) };
      }
      const channel = requestedChannel || guild.channels.cache.get(channelIdToControl);
      const connected = await connectToChannel(bot, guild, channel);
      if (action === 'play') await playInDiscord(bot, connected, filename);
      return { bot: bot.number, completed: true, state: sessions.get(`${bot.number}:${guild.id}`)?.connection.state.status };
    } catch (error) {
      return { bot: bot.number, completed: false, error: error.message };
    }
  }));
  const failed = results.filter((result) => result.error);
  const summary = {
    completed: results.filter((result) => result.completed).length,
    total: results.length,
    errors: failed.map((result) => `Bot ${result.bot}: ${result.error}`),
    results,
  };
  const detail = summary.errors.length ? ` Errors: ${summary.errors.join(' | ')}` : '';
  addLog(failed.length ? 'error' : 'info', `Web control ${action}: ${summary.completed}/${summary.total} bots completed.${detail}`);
  return summary;
}

function disconnect(botNumber, guildIdToDisconnect) {
  const key = `${botNumber}:${guildIdToDisconnect}`;
  const session = sessions.get(key);
  if (!session) return false;
  sessions.delete(key);
  session.player.stop();
  if (session.audioProcess) session.audioProcess.kill();
  safelyDestroy(session.connection);
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
  if (!bot.token || bot.token.startsWith('replace-with-')) {
    bots.push({ ...bot, client: null, status: 'missing-token', statusMessage: 'Add this bot token in Render.' });
    addLog('error', `Bot ${bot.number} is not started: DISCORD_TOKEN_${bot.number} is missing in Render.`);
    return;
  }
  addLog('info', `Bot ${bot.number} token configured. Attempting Discord login.`);
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
  const botState = { ...bot, client, status: bot.status };
  bots.push(botState);

  client.once('ready', (readyClient) => {
    botState.status = 'online';
    botState.statusMessage = 'Connected to Discord';
    botState.tag = readyClient.user.tag;
    addLog('info', `Bot ${bot.number} login successful as ${readyClient.user.tag}. Servers: ${readyClient.guilds.cache.size}.`);
  });

  client.on('voiceStateUpdate', (oldState, newState) => {
    if (newState.id !== client.user?.id) return;
    addLog('info', `Bot ${bot.number} Discord voice state: ${oldState.channelId || 'none'} -> ${newState.channelId || 'none'}.`);
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
    botState.statusMessage = error.code === 4004 ? 'Invalid token' : error.message;
    addLog('error', `Bot ${bot.number} login failed: ${botState.statusMessage}.`);
  });
}

function requireAdmin(request, response, next) {
  if (!adminKey) return response.status(503).json({ error: 'WEB_ADMIN_KEY is not configured in Render.' });
  if (request.get('x-admin-key') !== adminKey) return response.status(401).json({ error: 'Invalid dashboard key. Enter the exact WEB_ADMIN_KEY from Render.' });
  next();
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(rootDir, 'public')));
app.get('/health', (request, response) => response.json({ status: 'ok', bots: bots.map((bot) => ({ number: bot.number, status: bot.status })) }));
app.get('/api/bots', requireAdmin, (request, response) => response.json(bots.map((bot) => ({ number: bot.number, status: bot.status, message: bot.statusMessage || null, tag: bot.tag || null }))));
app.get('/api/logs', requireAdmin, (request, response) => response.json(logs));
app.get('/api/audio', requireAdmin, (request, response) => {
  const files = fs.readdirSync(audioDir).filter((file) => /\.(mp3|wav|ogg|m4a|webm)$/i.test(file));
  response.json(files.map((file) => ({ name: file, url: `/audio/${encodeURIComponent(file)}` })));
});
app.use('/audio', express.static(audioDir));
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
  const { action, guildId: targetGuildId, channelId: targetChannelId, filename } = request.body || {};
  if (!['join', 'stop', 'disconnect', 'play'].includes(action)) {
    return response.status(400).json({ error: 'Choose a valid server and action.' });
  }
  if (['join', 'play'].includes(action) && !/^\d{17,20}$/.test(targetChannelId || '')) {
    return response.status(400).json({ error: 'Choose a voice channel.' });
  }
  if (action === 'play' && !getAudioPath(filename)) return response.status(400).json({ error: 'Choose a valid uploaded audio file.' });
  try {
    response.json(await runWebControl(action, targetGuildId, targetChannelId, filename));
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
});

const upload = multer({
  dest: audioDir,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (request, file, callback) => callback(null, /^audio\//.test(file.mimetype) || /\.(mp3|wav|ogg|m4a|webm)$/i.test(file.originalname)),
});
app.post('/api/audio/upload', requireAdmin, upload.single('audio'), (request, response) => {
  if (!request.file) return response.status(400).json({ error: 'Choose an audio file.' });
  const extension = path.extname(request.file.originalname).toLowerCase() || '.mp3';
  const safeName = `${Date.now()}-${path.basename(request.file.originalname, extension).replace(/[^a-z0-9_-]/gi, '-')}${extension}`;
  fs.renameSync(request.file.path, path.join(audioDir, safeName));
  addLog('info', `Audio uploaded: ${safeName}.`);
  response.json({ name: safeName, url: `/audio/${encodeURIComponent(safeName)}` });
});

app.listen(port, '0.0.0.0', () => console.log(`Web dashboard listening on port ${port}`));

const configured = configuredBots();
const tokenCount = configured.filter((bot) => bot.token && !bot.token.startsWith('replace-with-')).length;
addLog('info', `Configured ${tokenCount}/5 Discord bot token(s).`);
if (!tokenCount) addLog('error', 'No Discord bot tokens configured. Add DISCORD_TOKEN_1 through DISCORD_TOKEN_5 in Render.');
configured.forEach(attachBot);
