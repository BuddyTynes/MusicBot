require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  PermissionsBitField,
} = require("discord.js");
const { MusicManager } = require("./musicManager");
const {
  isSunoUrl,
  isYouTubeUrl,
  isSpotifyUrl,
  isValidUrl,
  isSunoProfileInput,
  extractTracksFromUrl,
  fetchSunoProfileTracks,
  fetchRadioTracks,
  fetchRadioSongTracks,
} = require("./sunoResolver");
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

client.ws.on("VOICE_STATE_UPDATE", (payload) => {
  logger.debug("WS VOICE_STATE_UPDATE", {
    guildId: payload.guild_id,
    userId: payload.user_id,
    channelId: payload.channel_id,
    sessionId: payload.session_id,
  });
});

client.ws.on("VOICE_SERVER_UPDATE", (payload) => {
  logger.debug("WS VOICE_SERVER_UPDATE", {
    guildId: payload.guild_id,
    endpoint: payload.endpoint,
    hasToken: Boolean(payload.token),
  });
});

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

function parseProfileRequest(args) {
  const input = args[0];
  let count;
  let sort = "new";

  for (const rawArg of args.slice(1)) {
    const arg = rawArg.toLowerCase();
    if (arg === "top") {
      sort = "top";
    } else if (arg === "recent" || arg === "new") {
      sort = "new";
    } else if (arg === "all") {
      count = "all";
    } else if (/^\d+$/.test(arg)) {
      count = Number(arg);
    } else {
      throw new Error(`Unknown profile option: ${rawArg}`);
    }
  }

  return { input, count, sort };
}

function isSupportedPlayUrl(input) {
  return isSunoUrl(input) || isYouTubeUrl(input) || isSpotifyUrl(input);
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
    if (command === "play" || command === "playlist") {
      const input = args[0];
      if (!input) {
        await message.reply(`Usage: ${prefix}play <url>  — works with Suno, YouTube, and Spotify links`);
        return;
      }

      if (!isValidUrl(input) || !isSupportedPlayUrl(input)) {
        await message.reply("Please provide a Suno, YouTube, or Spotify URL.");
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

      await message.reply("Reading link...");
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

    if (command === "profile") {
      const { input, count, sort } = parseProfileRequest(args);
      if (!input) {
        await message.reply(`Usage: ${prefix}profile <@handle|profile-url> [count|all] [top|recent]`);
        return;
      }

      if (!isSunoProfileInput(input)) {
        await message.reply("Please provide a Suno profile handle or profile URL.");
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
      await message.reply(`Fetching ${sort === "top" ? "top" : "recent"} public Suno songs...`);

      const { tracks, profile } = await fetchSunoProfileTracks(input, { count, sort });
      if (tracks.length === 0) {
        await message.reply(`No public songs found for @${profile.handle}.`);
        return;
      }

      await music.enqueue(message.guild.id, tracks);
      await message.reply(`Queued ${tracks.length} public song(s) from ${profile.displayName} (@${profile.handle}).`);
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

    if (command === "next") {
      const input = args[0];
      if (!input) {
        await message.reply(`Usage: ${prefix}next <url>  — force a song to play next in queue`);
        return;
      }

      if (!isValidUrl(input) || !isSupportedPlayUrl(input)) {
        await message.reply("Please provide a Suno, YouTube, or Spotify URL.");
        return;
      }

      const memberVoice = message.member.voice.channel;
      if (!memberVoice) {
        await message.reply("Join a voice channel first.");
        return;
      }

      await message.reply("Reading link...");
      const tracks = await extractTracksFromUrl(input);

      if (tracks.length === 0) {
        await message.reply("Could not resolve any tracks from that URL.");
        return;
      }

      const track = tracks[0];
      music.playNextTrack(message.guild.id, track);
      await message.reply(`**${track.title}** will play next.`);
      return;
    }

    if (command === "shuffle") {
      const info = music.getQueueInfo(message.guild.id);
      if (info.upcoming.length === 0) {
        await message.reply("Nothing in the queue to shuffle.");
        return;
      }
      music.shuffle(message.guild.id);
      await message.reply(`Shuffled ${info.upcoming.length} track(s).`);
      return;
    }

    if (command === "radio") {
      const memberVoice = message.member.voice.channel;
      if (!memberVoice) {
        await message.reply("Join a voice channel first.");
        return;
      }

      const me = message.guild.members.me;
      const permissions = memberVoice.permissionsFor(me);
      if (!permissions?.has(PermissionsBitField.Flags.Connect) || !permissions?.has(PermissionsBitField.Flags.Speak)) {
        await message.reply("I need Connect and Speak permissions in your voice channel.");
        return;
      }

      await message.reply("Fetching 10 random trending Suno tracks...");
      const tracks = await fetchRadioTracks(10);
      await music.ensureConnection(message.guild, memberVoice, message.channelId);
      await music.enqueue(message.guild.id, tracks);
      await message.reply(`Queued ${tracks.length} tracks:\n${tracks.map((t, i) => `${i + 1}. ${t.title}`).join("\n")}`);
      return;
    }

    if (command === "radio-song") {
      const input = args[0];
      if (!input || !isSunoUrl(input)) {
        await message.reply(`Usage: ${prefix}radio-song <suno-song-url>`);
        return;
      }

      const memberVoice = message.member.voice.channel;
      if (!memberVoice) {
        await message.reply("Join a voice channel first.");
        return;
      }

      const me = message.guild.members.me;
      const permissions = memberVoice.permissionsFor(me);
      if (!permissions?.has(PermissionsBitField.Flags.Connect) || !permissions?.has(PermissionsBitField.Flags.Speak)) {
        await message.reply("I need Connect and Speak permissions in your voice channel.");
        return;
      }

      await message.reply("Finding similar tracks...");
      const { tracks, seedTitle, seedTags } = await fetchRadioSongTracks(input, 10);
      const tagNote = seedTags.length > 0 ? ` (matched on: ${seedTags.slice(0, 3).join(", ")})` : " (no tags — using random trending)";
      await music.ensureConnection(message.guild, memberVoice, message.channelId);
      await music.enqueue(message.guild.id, tracks);
      await message.reply(
        `Radio based on **${seedTitle}**${tagNote}:\n${tracks.map((t, i) => `${i + 1}. ${t.title}`).join("\n")}`
      );
      return;
    }

    if (command === "help") {
      await message.reply(
        [
          "```",
          `${prefix}play <url>     — play a song or playlist (Suno, YouTube, or Spotify)`,
          `${prefix}playlist <url> — alias for ${prefix}play`,
          `${prefix}profile <@handle|url> [count|all] [top|recent] — queue public Suno profile songs`,
          `${prefix}next <url>     — force a song to play next in queue`,
          `${prefix}radio          — queue 10 random trending Suno songs`,
          `${prefix}radio-song <url> — queue 10 songs similar to a Suno song`,
          `${prefix}shuffle        — shuffle the current queue`,
          `${prefix}queue          — show the current queue`,
          `${prefix}now            — show the currently playing track`,
          `${prefix}skip           — skip to the next track`,
          `${prefix}stop           — stop playback and clear the queue`,
          `${prefix}help           — show this message`,
          "```",
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
