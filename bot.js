require('dotenv').config();

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const express = require('express');
const multer = require('multer');
const {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
} = require('discord.js');
const {
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} = require('@discordjs/voice');
const ffmpegPath = require('ffmpeg-static');

const rootDir = __dirname;
const audioDir = path.join(rootDir, 'audio');
const configPath = path.join(rootDir, 'audio-config.json');
const port = Number(process.env.PORT) || 10000;
const adminKey = process.env.WEB_ADMIN_KEY;
const guildId = /^\d{17,20}$/.test(process.env.GUILD_ID || '') ? process.env.GUILD_ID : undefined;
const audioSlots = ['j1', 'j2', 'j3', 'j4', 'j5'];
const defaultFiles = ['1.mp3', '2.mp3', '4.mp3', '5.mp3', '6.mp3'];

fs.mkdirSync(audioDir, { recursive: true });
if (!fs.existsSync(configPath)) {
  fs.writeFileSync(configPath, JSON.stringify({ j1: '1.mp3', j2: '2.mp3', j3: '4.mp3', j4: '5.mp3', j5: '6.mp3' }, null, 2));
}

function readAudioConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return Object.fromEntries(audioSlots.map((slot, index) => [slot, defaultFiles[index]]));
  }
}

function writeAudioConfig(config) {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function configuredBots() {
  return Array.from({ length: 5 }, (_, index) => ({
    number: index + 1,
    token: process.env[`DISCORD_TOKEN_${index + 1}`],
    clientId: process.env[`CLIENT_ID_${index + 1}`],
  })).filter((bot) => bot.token && !bot.token.startsWith('replace-with-'));
}

const sessions = new Map();
const bots = [];

function getAudioFile(slot) {
  const filename = readAudioConfig()[slot];
  if (!filename || filename.includes('..') || path.basename(filename) !== filename) return null;
  const filePath = path.join(audioDir, filename);
  if (fs.existsSync(filePath)) return filePath;
  const rootFilePath = path.join(rootDir, filename);
  return fs.existsSync(rootFilePath) ? rootFilePath : null;
}

async function connectToMemberChannel(bot, member) {
  if (!member.voice.channel) throw new Error('Join a voice channel first.');
  const permission = member.voice.channel.permissionsFor(member.guild.members.me);
  if (!permission?.has([PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
    throw new Error('I need Connect and Speak permissions in that voice channel.');
  }

  const key = `${bot.number}:${member.guild.id}`;
  const existing = sessions.get(key);
  if (existing && existing.channelId === member.voice.channel.id) return existing;
  if (existing) existing.connection.destroy();

  const connection = joinVoiceChannel({
    channelId: member.voice.channel.id,
    guildId: member.guild.id,
    adapterCreator: member.guild.voiceAdapterCreator,
  });
  const player = createAudioPlayer();
  connection.subscribe(player);
  connection.on('error', (error) => console.error(`Bot ${bot.number} voice error:`, error));
  const session = { channelId: member.voice.channel.id, connection, player };
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

function playAudio(bot, guildIdToPlay, session, slot) {
  const audioPath = getAudioFile(slot);
  if (!audioPath) throw new Error(`No audio file is assigned to !${slot}. Upload one in the web dashboard.`);
  const ffmpeg = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', audioPath, '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1']);
  ffmpeg.stderr.on('data', (data) => console.error(`Bot ${bot.number} FFmpeg: ${data}`));
  ffmpeg.on('error', (error) => console.error(`Bot ${bot.number} audio error:`, error));
  session.player.play(createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw }));
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

    if (/^!j[1-5]$/.test(command)) {
      const session = await connectToMemberChannel(bot, message.member);
      playAudio(bot, message.guild.id, session, command.slice(1));
      return `Bot ${bot.number} playing ${command}`;
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
      if (['!j', '!s', '!d'].includes(command) || /^!j[1-5]$/.test(command)) {
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

const upload = multer({
  dest: audioDir,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (request, file, callback) => callback(null, /^audio\//.test(file.mimetype) || /\.(mp3|wav|ogg|m4a)$/i.test(file.originalname)),
});
const app = express();
app.use(express.json());
app.use(express.static(path.join(rootDir, 'public')));
app.get('/health', (request, response) => response.json({ status: 'ok', bots: bots.map((bot) => ({ number: bot.number, status: bot.status })) }));
app.get('/api/bots', requireAdmin, (request, response) => response.json(bots.map((bot) => ({ number: bot.number, status: bot.status, tag: bot.tag || null }))));
app.get('/api/audio', requireAdmin, (request, response) => {
  const files = fs.readdirSync(audioDir).filter((file) => /\.(mp3|wav|ogg|m4a)$/i.test(file)).concat(defaultFiles.filter((file) => fs.existsSync(path.join(rootDir, file))));
  const config = readAudioConfig();
  response.json({ files: [...new Set(files)].sort(), slots: audioSlots.map((slot) => ({ slot, file: config[slot] || '', url: config[slot] ? `/audio/${encodeURIComponent(config[slot])}` : null })) });
});
app.use('/audio', express.static(audioDir));
app.get('/audio/:filename', (request, response) => {
  const filename = path.basename(request.params.filename);
  const rootFile = path.join(rootDir, filename);
  if (defaultFiles.includes(filename) && fs.existsSync(rootFile)) return response.sendFile(rootFile);
  response.sendStatus(404);
});
app.post('/api/audio/upload', requireAdmin, upload.single('audio'), (request, response) => {
  if (!request.file) return response.status(400).json({ error: 'Upload an audio file.' });
  const extension = path.extname(request.file.originalname).toLowerCase() || '.mp3';
  const safeName = `${Date.now()}-${path.basename(request.file.originalname, extension).replace(/[^a-z0-9_-]/gi, '-')}${extension}`;
  fs.renameSync(request.file.path, path.join(audioDir, safeName));
  response.json({ file: safeName });
});
app.post('/api/audio/assign', requireAdmin, (request, response) => {
  const { slot, file } = request.body || {};
  if (!audioSlots.includes(slot) || !file || path.basename(file) !== file || !getAudioFileForName(file)) return response.status(400).json({ error: 'Invalid audio assignment.' });
  const config = readAudioConfig();
  config[slot] = file;
  writeAudioConfig(config);
  response.json({ ok: true });
});

function getAudioFileForName(filename) {
  return fs.existsSync(path.join(audioDir, filename)) || fs.existsSync(path.join(rootDir, filename));
}

app.listen(port, '0.0.0.0', () => console.log(`Web dashboard listening on port ${port}`));

const configured = configuredBots();
if (!configured.length) console.warn('No bot tokens configured. Add DISCORD_TOKEN_1 through DISCORD_TOKEN_5 in Render.');
configured.forEach(attachBot);
