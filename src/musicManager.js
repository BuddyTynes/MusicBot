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
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const { resolveStreamUrlForTrack } = require("./sunoResolver");
const logger = require("./logger");

function readPositiveIntEnv(name, fallback) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}

const MAX_CONSECUTIVE_PLAYBACK_FAILURES = readPositiveIntEnv(
  "MAX_CONSECUTIVE_PLAYBACK_FAILURES",
  3,
);
const MIN_PLAYBACK_SUCCESS_MS = readPositiveIntEnv("MIN_PLAYBACK_SUCCESS_MS", 3000);
let ffmpegCommand = null;

function canRunFfmpeg(command) {
  const result = spawnSync(command, ["-version"], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
  return result.status === 0;
}

function resolveFfmpegCommand() {
  if (ffmpegCommand) return ffmpegCommand;

  if (process.env.FFMPEG_PATH?.trim()) {
    ffmpegCommand = process.env.FFMPEG_PATH.trim();
    return ffmpegCommand;
  }

  if (canRunFfmpeg("ffmpeg")) {
    ffmpegCommand = "ffmpeg";
    return ffmpegCommand;
  }

  const ffmpegStatic = require("ffmpeg-static");
  if (ffmpegStatic && fs.existsSync(ffmpegStatic)) {
    ffmpegCommand = ffmpegStatic;
    return ffmpegCommand;
  }

  ffmpegCommand = "ffmpeg";
  return ffmpegCommand;
}

function formatPlaybackError(error) {
  const message = error?.message || "Unknown playback error";
  return message.length <= 700 ? message : `${message.slice(0, 700)}...`;
}

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
        consecutivePlaybackFailures: 0,
        playbackStartedAtMs: null,
        skipRequested: false,
      });

      logger.info("Created guild music state", { guildId });

      player.on("stateChange", (oldState, newState) => {
        const state = this.getState(guildId);
        logger.debug("Audio player state change", {
          guildId,
          from: oldState.status,
          to: newState.status,
          current: state.current ? state.current.title : null,
        });

        if (
          oldState.status !== AudioPlayerStatus.Idle &&
          newState.status === AudioPlayerStatus.Idle
        ) {
          this.handlePlayerIdle(guildId, oldState).catch((error) => {
            logger.error("Failed to handle audio player idle", {
              guildId,
              error: logger.serializeError(error),
            });
          });
        }
      });

      player.on("error", async (error) => {
        logger.error("Audio player error", {
          guildId,
          error: logger.serializeError(error),
        });
        const state = this.getState(guildId);
        await this.handlePlaybackFailure(guildId, state.current, error);
      });
    }

    return this.states.get(guildId);
  }

  async handlePlayerIdle(guildId, oldState) {
    const state = this.getState(guildId);
    const finishedTrack = state.current;
    const elapsedMs = state.playbackStartedAtMs
      ? Date.now() - state.playbackStartedAtMs
      : null;
    const ffmpegClose = oldState.resource?.metadata?.ffmpegClose || null;

    logger.info("Audio player became idle", {
      guildId,
      title: finishedTrack ? finishedTrack.title : null,
      elapsedMs,
      skipRequested: state.skipRequested,
      ffmpegClose,
      remainingQueue: state.queue.length,
    });

    if (state.skipRequested) {
      state.skipRequested = false;
      state.current = null;
      state.playbackStartedAtMs = null;
      await this.playNext(guildId);
      return;
    }

    if (
      finishedTrack &&
      elapsedMs !== null &&
      elapsedMs < MIN_PLAYBACK_SUCCESS_MS
    ) {
      const reason = ffmpegClose
        ? `FFmpeg ended after ${elapsedMs}ms (code ${ffmpegClose.code}, signal ${ffmpegClose.signal || "none"}).`
        : `Playback ended after ${elapsedMs}ms.`;
      await this.handlePlaybackFailure(guildId, finishedTrack, new Error(reason));
      return;
    }

    state.current = null;
    state.playbackStartedAtMs = null;
    state.consecutivePlaybackFailures = 0;
    await this.playNext(guildId);
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
      state.consecutivePlaybackFailures = 0;
      logger.info("Queue ended", { guildId });
      return;
    }

    try {
      logger.info("Resolving track stream URL", {
        guildId,
        title: nextTrack.title,
        sourceUrl: nextTrack.sourceUrl,
      });
      const streamUrl = await resolveStreamUrlForTrack(nextTrack);
      logger.debug("Resolved stream URL", {
        guildId,
        title: nextTrack.title,
        streamUrl,
      });
      const resourceMetadata = {
        guildId,
        title: nextTrack.title,
        sourceUrl: nextTrack.sourceUrl,
        streamUrl,
        ffmpegClose: null,
      };
      let playbackStartedAtMs = null;
      const ffmpegArgs = [
        "-reconnect",
        "1",
        "-reconnect_streamed",
        "1",
        "-reconnect_delay_max",
        "5",
        "-fflags",
        "+genpts",
        "-probesize",
        "32M",
        "-analyzeduration",
        "10M",
        "-i",
        streamUrl,
        "-vn",
        "-loglevel",
        "warning",
        "-af",
        "aresample=async=1:first_pts=0",
        "-f",
        "s16le",
        "-ar",
        "48000",
        "-ac",
        "2",
        "pipe:1",
      ];
      const ffmpegCommand = resolveFfmpegCommand();
      const ffmpeg = spawn(ffmpegCommand, ffmpegArgs, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      logger.info("Starting FFmpeg", {
        guildId,
        title: nextTrack.title,
        command: ffmpegCommand,
        args: ffmpegArgs,
      });

      ffmpeg.stderr.on("data", (d) => {
        const msg = d.toString().trim();
        if (msg) logger.warn("FFmpeg stderr", { guildId, title: nextTrack.title, msg });
      });

      ffmpeg.on("error", (error) => {
        logger.error("FFmpeg process error", {
          guildId,
          title: nextTrack.title,
          error: logger.serializeError(error),
        });
      });

      ffmpeg.on("close", (code, signal) => {
        const elapsedMs = playbackStartedAtMs
          ? Date.now() - playbackStartedAtMs
          : null;
        resourceMetadata.ffmpegClose = { code, signal, elapsedMs };
        const level = elapsedMs !== null && elapsedMs < MIN_PLAYBACK_SUCCESS_MS ? "warn" : "info";
        logger[level]("FFmpeg process closed", {
          guildId,
          title: nextTrack.title,
          code,
          signal,
          elapsedMs,
        });
      });

      const resource = createAudioResource(ffmpeg.stdout, {
        inputType: StreamType.Raw,
        metadata: resourceMetadata,
      });

      state.current = nextTrack;
      playbackStartedAtMs = Date.now();
      state.playbackStartedAtMs = playbackStartedAtMs;
      state.skipRequested = false;
      state.consecutivePlaybackFailures = 0;
      state.player.play(resource);
      logger.info("Playback started", {
        guildId,
        title: nextTrack.title,
        minPlaybackSuccessMs: MIN_PLAYBACK_SUCCESS_MS,
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
      await this.handlePlaybackFailure(guildId, nextTrack, error);
    }
  }

  async handlePlaybackFailure(guildId, track, error) {
    const state = this.getState(guildId);
    const previousFailures = Number.isFinite(state.consecutivePlaybackFailures)
      ? state.consecutivePlaybackFailures
      : 0;
    const failureCount = previousFailures + 1;
    state.consecutivePlaybackFailures = failureCount;
    state.current = null;
    state.playbackStartedAtMs = null;
    state.skipRequested = false;

    const title = track?.title || "current track";
    const reason = formatPlaybackError(error);

    if (failureCount >= MAX_CONSECUTIVE_PLAYBACK_FAILURES) {
      const skippedCount = state.queue.length;
      state.queue = [];
      state.consecutivePlaybackFailures = 0;
      state.player.stop(true);

      logger.warn("Stopping after consecutive playback failures", {
        guildId,
        failureCount,
        maxFailures: MAX_CONSECUTIVE_PLAYBACK_FAILURES,
        skippedCount,
        lastTrack: title,
        reason,
      });

      await this.notify(
        guildId,
        `Stopped after ${failureCount} playback failures in a row. Last error: ${reason}`,
      );
      return;
    }

    await this.notify(
      guildId,
      `Could not play ${title} (${failureCount}/${MAX_CONSECUTIVE_PLAYBACK_FAILURES}): ${reason}`,
    );
    await this.playNext(guildId);
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
    state.skipRequested = true;
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
    state.playbackStartedAtMs = null;
    state.skipRequested = false;
    state.consecutivePlaybackFailures = 0;
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
