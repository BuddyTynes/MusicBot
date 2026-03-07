require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  PermissionsBitField,
} = require("discord.js");
const { MusicManager } = require("./musicManager");
const { isSunoUrl, extractTracksFromUrl } = require("./sunoResolver");

const token = process.env.DISCORD_TOKEN;
const prefix = process.env.COMMAND_PREFIX || "!";

if (!token) {
  throw new Error("Missing DISCORD_TOKEN in environment.");
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
});

const music = new MusicManager(client);

function formatQueue(info) {
  if (!info.current && info.upcoming.length === 0) {
    return "Queue is empty.";
  }

  const lines = [];
  if (info.current) {
    lines.push(`Now: ${info.current.title}`);
  }

  if (info.upcoming.length > 0) {
    lines.push("Up next:");
    info.upcoming.slice(0, 10).forEach((track, index) => {
      lines.push(`${index + 1}. ${track.title}`);
    });

    if (info.upcoming.length > 10) {
      lines.push(`...and ${info.upcoming.length - 10} more.`);
    }
  }

  return lines.join("\n");
}

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Command prefix: ${prefix}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) {
    return;
  }

  if (!message.content.startsWith(prefix)) {
    return;
  }

  const [rawCommand, ...args] = message.content
    .slice(prefix.length)
    .trim()
    .split(/\s+/);

  const command = rawCommand.toLowerCase();

  try {
    if (command === "play") {
      const input = args[0];
      if (!input) {
        await message.reply(`Usage: ${prefix}play <suno-song-or-playlist-url>`);
        return;
      }

      if (!isSunoUrl(input)) {
        await message.reply("Please provide a valid suno.com link.");
        return;
      }

      const memberVoice = message.member.voice.channel;
      if (!memberVoice) {
        await message.reply("Join a voice channel first.");
        return;
      }

      const me = message.guild.members.me;
      const permissions = memberVoice.permissionsFor(me);

      if (
        !permissions ||
        !permissions.has(PermissionsBitField.Flags.Connect) ||
        !permissions.has(PermissionsBitField.Flags.Speak)
      ) {
        await message.reply("I need Connect and Speak permissions in your voice channel.");
        return;
      }

      await music.ensureConnection(message.guild, memberVoice, message.channelId);

      await message.reply("Reading link with yt-dlp...");
      const tracks = await extractTracksFromUrl(input);

      await music.enqueue(message.guild.id, tracks);
      await message.reply(`Queued ${tracks.length} track(s).`);
      return;
    }

    if (command === "queue") {
      const info = music.getQueueInfo(message.guild.id);
      await message.reply(formatQueue(info));
      return;
    }

    if (command === "skip") {
      music.skip(message.guild.id);
      await message.reply("Skipped.");
      return;
    }

    if (command === "stop") {
      music.stop(message.guild.id);
      await message.reply("Stopped playback and cleared queue.");
      return;
    }

    if (command === "now") {
      const info = music.getQueueInfo(message.guild.id);
      await message.reply(info.current ? `Now playing: ${info.current.title}` : "Nothing is playing.");
      return;
    }

    if (command === "help") {
      await message.reply(
        [
          `Commands (${prefix}):`,
          `${prefix}play <url> - add Suno song or playlist`,
          `${prefix}queue - show queue`,
          `${prefix}now - show current track`,
          `${prefix}skip - skip current track`,
          `${prefix}stop - stop and clear queue`,
        ].join("\n"),
      );
    }
  } catch (error) {
    await message.reply(`Error: ${error.message}`);
  }
});

client.login(token);
