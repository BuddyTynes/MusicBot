# Suno Discord Music Bot

A Discord bot that accepts Suno song links and playlist links, queues them, and plays them in voice chat.

## Features

- Queue a Suno song or playlist with one command
- Queue public songs from a Suno profile
- Basic queue controls (`play`, `queue`, `now`, `skip`, `stop`)
- Automatic next-track playback
- Uses `yt-dlp` for resolving Suno links

## Requirements

- Node.js 20+
- Python 3.7+ available as `python3` during `npm install` on Linux
- A Discord bot token

FFmpeg and yt-dlp are installed as project dependencies. If you need a custom yt-dlp binary, set `YT_DLP_PATH` in `.env`.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create `.env` from example and set your token:

```bash
cp .env.example .env
```

On Windows, use `copy .env.example .env`.

3. Fill in `.env`:

```env
DISCORD_TOKEN=your_bot_token_here
COMMAND_PREFIX=!
LOG_LEVEL=info
YT_DLP_TIMEOUT_MS=45000
# Optional: override the bundled yt-dlp binary path.
YT_DLP_PATH=
SUNO_MAX_PLAYLIST_TRACKS=1000
SUNO_DEFAULT_PROFILE_TRACKS=25
SUNO_MAX_PROFILE_TRACKS=500
MAX_CONSECUTIVE_PLAYBACK_FAILURES=3
YOUTUBE_MAX_PLAYLIST_TRACKS=100
```

4. Run the bot:

```bash
npm start
```

Optional runtime check before starting:

```bash
npm run check:runtime
```

## Commands

- `!play <suno-or-youtube-url>`: Add a Suno song/playlist or YouTube video/playlist URL to queue
- `!profile <@handle|profile-url> [count|all] [top|recent]`: Queue public songs from a Suno profile
- `!queue`: Show current queue
- `!now`: Show currently playing track
- `!skip`: Skip current track
- `!stop`: Stop playback, clear queue, and disconnect
- `!help`: Show command help

## Notes

- `!play` accepts Suno and YouTube URLs. `!profile` accepts Suno profile handles or profile URLs.
- If YouTube playback fails after install, run `npm install` again and check that Python 3.7+ is available as `python3`.
- Depending on Suno or extractor changes, `yt-dlp` support may need updates.

## Debug Logging

- Set `LOG_LEVEL=debug` in `.env` for verbose connection and playback logs.
- Start normally with `npm start` and watch terminal output.
