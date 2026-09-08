require('dotenv').config();

const {
	Client,
	GatewayIntentBits,
	REST,
	Routes,
	SlashCommandBuilder,
} = require('discord.js');
const {
	StreamType,
	VoiceConnectionStatus,
	createAudioPlayer,
	createAudioResource,
	entersState,
	joinVoiceChannel,
} = require('@discordjs/voice');
const { spawn } = require('node:child_process');
const path = require('node:path');
const ffmpegPath = require('ffmpeg-static');

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token || token === 'replace-with-a-new-token') {
	throw new Error('DISCORD_TOKEN is missing. Add a newly generated token to .env.');
}

if (!clientId) {
	throw new Error('CLIENT_ID is missing. Add your application client ID to .env.');
}

const commands = [
	new SlashCommandBuilder().setName('ping').setDescription('Check whether the bot is responding.'),
	new SlashCommandBuilder().setName('help').setDescription('Show the commands available in this bot.'),
	new SlashCommandBuilder().setName('server').setDescription('Show information about this server.'),
].map((command) => command.toJSON());

const rest = new REST({ version: '10' }).setToken(token);
const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildVoiceStates,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
	],
});
const voiceSessions = new Map();
const audioFiles = { '!j1': '1.mp3', '!j2': '2.mp3', '!j3': '4.mp3', '!j4': '5.mp3', '!j5': '6.mp3' };

async function connectToMemberChannel(member) {
	if (!member.voice.channel) throw new Error('Join a voice channel first.');

	const existingSession = voiceSessions.get(member.guild.id);
	if (existingSession && existingSession.channelId === member.voice.channel.id) return existingSession;
	if (existingSession) existingSession.connection.destroy();

	const connection = joinVoiceChannel({
		channelId: member.voice.channel.id,
		guildId: member.guild.id,
		adapterCreator: member.guild.voiceAdapterCreator,
	});
	const player = createAudioPlayer();
	connection.subscribe(player);
	const session = { channelId: member.voice.channel.id, connection, player };
	voiceSessions.set(member.guild.id, session);

	try {
		await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
	} catch (error) {
		connection.destroy();
		voiceSessions.delete(member.guild.id);
		throw error;
	}
	return session;
}

function playAudio(session, filename) {
	const audioPath = path.join(__dirname, filename);
	const ffmpeg = spawn(ffmpegPath, [
		'-hide_banner', '-loglevel', 'error', '-i', audioPath,
		'-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1',
	]);
	ffmpeg.stderr.on('data', (data) => console.error(`FFmpeg error: ${data}`));
	ffmpeg.on('error', (error) => console.error('Audio process failed:', error));
	session.player.play(createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw }));
}

function disconnectFromGuild(guildIdToDisconnect) {
	const session = voiceSessions.get(guildIdToDisconnect);
	if (!session) return false;
	session.player.stop();
	session.connection.destroy();
	voiceSessions.delete(guildIdToDisconnect);
	return true;
}

async function registerCommands() {
	const route = guildId ? Routes.applicationGuildCommands(clientId, guildId) : Routes.applicationCommands(clientId);
	await rest.put(route, { body: commands });
	console.log(guildId ? 'Registered commands in the test server.' : 'Registered global commands.');
}

client.once('ready', (readyClient) => console.log(`Logged in as ${readyClient.user.tag}`));

client.on('messageCreate', async (message) => {
	if (message.author.bot || !message.guild || !message.content.startsWith('!')) return;
	const command = message.content.trim().toLowerCase();

	try {
		if (command === '!j') {
			await connectToMemberChannel(message.member);
			await message.reply('Joined your voice channel.');
		} else if (command === '!d') {
			await message.reply(disconnectFromGuild(message.guild.id) ? 'Disconnected.' : 'I am not in a voice channel.');
		} else if (command === '!s') {
			const session = voiceSessions.get(message.guild.id);
			session?.player.stop();
			await message.reply(session ? 'Stopped.' : 'I am not playing audio.');
		} else if (audioFiles[command]) {
			const session = await connectToMemberChannel(message.member);
			playAudio(session, audioFiles[command]);
			await message.reply(`Playing ${audioFiles[command]}.`);
		}
	} catch (error) {
		console.error('Command failed:', error);
		await message.reply(`I could not complete that command: ${error.message}`);
	}
});

client.on('interactionCreate', async (interaction) => {
	if (!interaction.isChatInputCommand()) return;
	if (interaction.commandName === 'ping') await interaction.reply(`Pong! Gateway latency: ${client.ws.ping}ms`);
	if (interaction.commandName === 'help') {
		await interaction.reply({ content: '**Commands**\n`/ping` Check bot latency\n`/help` List commands\n`/server` Show server details', ephemeral: true });
	}
	if (interaction.commandName === 'server') {
		if (!interaction.guild) return interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
		await interaction.reply(`**${interaction.guild.name}**\nMembers: ${interaction.guild.memberCount}\nCreated: ${interaction.guild.createdAt.toDateString()}`);
	}
});

registerCommands()
	.then(() => client.login(token))
	.catch((error) => {
		console.error('Bot failed to start:', error);
		process.exitCode = 1;
	});