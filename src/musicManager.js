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

      player.on(AudioPlayerStatus.Idle, async () => {
        await this.playNext(guildId);
      });

      player.on("error", async (error) => {
        await this.notify(guildId, `Playback error: ${error.message}`);
        await this.playNext(guildId);
      });
    }

    return this.states.get(guildId);
  }

  async ensureConnection(guild, voiceChannel, textChannelId) {
    const state = this.getState(guild.id);

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
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);

    state.connection = connection;
    state.textChannelId = textChannelId;
    connection.subscribe(state.player);

    connection.on(VoiceConnectionStatus.Disconnected, () => {
      this.stop(guild.id, false);
    });
  }

  async enqueue(guildId, tracks) {
    const state = this.getState(guildId);
    state.queue.push(...tracks);
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
      return;
    }

    try {
      const streamUrl = await resolveStreamUrl(nextTrack.sourceUrl);
      const ffmpeg = new prism.FFmpeg({
        args: [
          "-i",
          streamUrl,
          "-analyzeduration",
          "0",
          "-loglevel",
          "0",
          "-f",
          "s16le",
          "-ar",
          "48000",
          "-ac",
          "2",
          "pipe:1",
        ],
      });

      const resource = createAudioResource(ffmpeg, {
        inputType: StreamType.Raw,
      });

      state.current = nextTrack;
      state.player.play(resource);
      await this.notify(guildId, `Now playing: ${nextTrack.title}`);
    } catch (error) {
      await this.notify(guildId, `Could not play track: ${nextTrack.title}`);
      await this.notify(guildId, `Reason: ${error.message}`);
      await this.playNext(guildId);
    }
  }

  skip(guildId) {
    const state = this.getState(guildId);
    state.player.stop();
  }

  stop(guildId, clearConnection = true) {
    const state = this.getState(guildId);
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
      return;
    }

    const channel = await this.client.channels.fetch(state.textChannelId);
    if (channel && channel.isTextBased()) {
      await channel.send(content);
    }
  }
}

module.exports = {
  MusicManager,
};
