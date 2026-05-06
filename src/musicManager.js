const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  entersState,
  StreamType,
} = require("@discordjs/voice");
const prism = require("prism-media");
const { resolveStreamUrl } = require("./sunoResolver");
const logger = require("./logger");

class MusicManager {
  constructor(client) {
    this.client = client;
    this.states = new Map();
  }

  getState(guildId) {
    if (!this.states.has(guildId)) {
      const player = createAudioPlayer({
        behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
      });

      this.states.set(guildId, {
        player,
        connection: null,
        queue: [],
        current: null,
        textChannelId: null,
      });

      logger.info("Created guild music state", { guildId });

      player.on("stateChange", (oldState, newState) => {
        logger.debug("Audio player state change", {
          guildId,
          from: oldState.status,
          to: newState.status,
        });
      });

      player.on(AudioPlayerStatus.Idle, async () => {
        await this.playNext(guildId);
      });

      player.on("error", async (error) => {
        logger.error("Audio player error", {
          guildId,
          error: logger.serializeError(error),
        });
        await this.notify(guildId, `Playback error: ${error.message}`);
        await this.playNext(guildId);
      });
    }

    return this.states.get(guildId);
  }

  async ensureConnection(guild, voiceChannel, textChannelId) {
    const state = this.getState(guild.id);
    logger.info("Ensuring voice connection", {
      guildId: guild.id,
      voiceChannelId: voiceChannel.id,
      hasExistingConnection: Boolean(state.connection),
    });

    if (
      state.connection &&
      state.connection.joinConfig.channelId === voiceChannel.id
    ) {
      state.textChannelId = textChannelId;
      return;
    }

    if (state.connection) {
      state.connection.destroy();
      state.connection = null;
    }

    const connection = joinVoiceChannel({
      guildId: guild.id,
      channelId: voiceChannel.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      debug: true,
    });

    connection.on("stateChange", (oldState, newState) => {
      const oldNetworking = Reflect.get(oldState, "networking");
      const newNetworking = Reflect.get(newState, "networking");
      logger.debug("Voice connection state change", {
        guildId: guild.id,
        from: oldState.status,
        to: newState.status,
        oldNetworkingCode: oldNetworking?.state?.code,
        newNetworkingCode: newNetworking?.state?.code,
      });
    });

    connection.on("debug", (message) => {
      logger.debug("Voice connection debug", {
        guildId: guild.id,
        message,
      });
    });

    connection.on("error", (error) => {
      logger.error("Voice connection error", {
        guildId: guild.id,
        voiceChannelId: voiceChannel.id,
        error: logger.serializeError(error),
      });
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (error) {
      logger.error("Voice connection did not become ready", {
        guildId: guild.id,
        voiceChannelId: voiceChannel.id,
        timeoutMs: 20000,
        error: logger.serializeError(error),
      });
      connection.destroy();
      throw error;
    }

    state.connection = connection;
    state.textChannelId = textChannelId;
    connection.subscribe(state.player);

    logger.info("Voice connection ready", {
      guildId: guild.id,
      voiceChannelId: voiceChannel.id,
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      logger.warn("Voice connection disconnected — attempting reconnect", {
        guildId: guild.id,
        voiceChannelId: voiceChannel.id,
      });
      try {
        // Discord may have sent us to a new server (VOICE_SERVER_UPDATE) — wait briefly for it to recover
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        // Now wait for it to become ready again
        await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
        logger.info("Voice connection recovered", {
          guildId: guild.id,
          voiceChannelId: voiceChannel.id,
        });
      } catch {
        logger.warn("Voice connection could not recover — stopping", {
          guildId: guild.id,
          voiceChannelId: voiceChannel.id,
        });
        this.stop(guild.id, true);
      }
    });
  }

  async enqueue(guildId, tracks) {
    const state = this.getState(guildId);
    state.queue.push(...tracks);
    logger.info("Enqueued tracks", {
      guildId,
      added: tracks.length,
      queueLength: state.queue.length,
      currentlyPlaying: state.current ? state.current.title : null,
    });
    if (!state.current) {
      await this.playNext(guildId);
    }
  }

  async playNext(guildId) {
    const state = this.getState(guildId);

    if (!state.connection) {
      state.current = null;
      state.queue = [];
      return;
    }

    const nextTrack = state.queue.shift();
    if (!nextTrack) {
      state.current = null;
      logger.info("Queue ended", { guildId });
      return;
    }

    try {
      logger.info("Resolving track stream URL", {
        guildId,
        title: nextTrack.title,
        sourceUrl: nextTrack.sourceUrl,
      });
      const streamUrl = await resolveStreamUrl(nextTrack.sourceUrl);
      logger.debug("Resolved stream URL", {
        guildId,
        title: nextTrack.title,
        streamUrl,
      });
      const ffmpeg = new prism.FFmpeg({
        args: [
          "-i",
          streamUrl,
          "-analyzeduration",
          "0",
          "-loglevel",
          "warning",
          "-f",
          "s16le",
          "-ar",
          "48000",
          "-ac",
          "2",
        ],
      });

      ffmpeg.process.stderr.on("data", (d) => {
        const msg = d.toString().trim();
        if (msg) logger.warn("FFmpeg stderr", { guildId, msg });
      });

      const resource = createAudioResource(ffmpeg, {
        inputType: StreamType.Raw,
      });

      state.current = nextTrack;
      state.player.play(resource);
      logger.info("Playback started", {
        guildId,
        title: nextTrack.title,
        remainingQueue: state.queue.length,
      });
      await this.notify(guildId, `Now playing: ${nextTrack.title}`);
    } catch (error) {
      logger.error("Track playback failed", {
        guildId,
        title: nextTrack.title,
        sourceUrl: nextTrack.sourceUrl,
        error: logger.serializeError(error),
      });
      await this.notify(guildId, `Could not play track: ${nextTrack.title}`);
      await this.notify(guildId, `Reason: ${error.message}`);
      await this.playNext(guildId);
    }
  }

  playNextTrack(guildId, track) {
    const state = this.getState(guildId);
    state.queue.unshift(track);
    logger.info("Track moved to front of queue", {
      guildId,
      title: track.title,
      queueLength: state.queue.length,
    });
  }

  shuffle(guildId) {
    const state = this.getState(guildId);
    const q = state.queue;
    for (let i = q.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [q[i], q[j]] = [q[j], q[i]];
    }
    logger.info("Queue shuffled", { guildId, queueLength: q.length });
  }

  skip(guildId) {
    const state = this.getState(guildId);
    logger.info("Skipping current track", {
      guildId,
      current: state.current ? state.current.title : null,
    });
    state.player.stop();
  }

  stop(guildId, clearConnection = true) {
    const state = this.getState(guildId);
    logger.info("Stopping playback", {
      guildId,
      clearConnection,
      queueLength: state.queue.length,
      current: state.current ? state.current.title : null,
    });
    state.queue = [];
    state.current = null;
    state.player.stop(true);

    if (clearConnection && state.connection) {
      state.connection.destroy();
      state.connection = null;
    }
  }

  getQueueInfo(guildId) {
    const state = this.getState(guildId);
    return {
      current: state.current,
      upcoming: [...state.queue],
    };
  }

  async notify(guildId, content) {
    const state = this.getState(guildId);
    if (!state.textChannelId) {
      logger.debug("Skipping notify due to missing text channel", {
        guildId,
        content,
      });
      return;
    }

    try {
      const channel = await this.client.channels.fetch(state.textChannelId);
      if (channel && channel.isTextBased()) {
        await channel.send(content);
      }
    } catch (error) {
      logger.error("Failed to send text notification", {
        guildId,
        textChannelId: state.textChannelId,
        content,
        error: logger.serializeError(error),
      });
    }
  }
}

module.exports = {
  MusicManager,
};
