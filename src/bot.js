require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  PermissionsBitField,
} = require("discord.js");
const { MusicManager } = require("./musicManager");
const { isSunoUrl, extractTracksFromUrl } = require("./sunoResolver");
const logger = require("./logger");

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

client.once("clientReady", () => {
  logger.info("Bot connected", {
    userTag: client.user.tag,
    userId: client.user.id,
    prefix,
    nodeVersion: process.version,
  });
});

client.on("error", (error) => {
  logger.error("Discord client error", { error: logger.serializeError(error) });
});

client.on("warn", (message) => {
  logger.warn("Discord client warning", { message });
});

client.on("shardError", (error, shardId) => {
  logger.error("Discord shard error", {
    shardId,
    error: logger.serializeError(error),
  });
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", {
    reason:
      reason instanceof Error ? logger.serializeError(reason) : { value: String(reason) },
  });
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", { error: logger.serializeError(error) });
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
  logger.info("Received command", {
    command,
    guildId: message.guild.id,
    channelId: message.channelId,
    userId: message.author.id,
    hasVoiceChannel: Boolean(message.member.voice.channel),
  });

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

      logger.info("Starting play request", {
        guildId: message.guild.id,
        channelId: message.channelId,
        voiceChannelId: memberVoice.id,
        input,
      });

      await music.ensureConnection(message.guild, memberVoice, message.channelId);

      await message.reply("Reading link with yt-dlp...");
      const tracks = await extractTracksFromUrl(input);

      logger.info("Resolved tracks from input", {
        guildId: message.guild.id,
        input,
        trackCount: tracks.length,
      });

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
    logger.error("Command execution failed", {
      command,
      guildId: message.guild?.id,
      channelId: message.channelId,
      userId: message.author.id,
      args,
      error: logger.serializeError(error),
    });

    if (error.message === "The operation was aborted") {
      await message.reply(
        "Error: Could not connect to voice in time. Check Connect/Speak permissions and outbound UDP on your server.",
      );
      return;
    }

    await message.reply(`Error: ${error.message}`);
  }
});

client.login(token);
