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
- `ffmpeg` installed and available in PATH
- `yt-dlp` installed and available in PATH
- A Discord bot token

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create `.env` from example and set your token:

```bash
copy .env.example .env
```

3. Fill in `.env`:

```env
DISCORD_TOKEN=your_bot_token_here
COMMAND_PREFIX=!
LOG_LEVEL=info
YT_DLP_TIMEOUT_MS=45000
SUNO_MAX_PLAYLIST_TRACKS=1000
SUNO_DEFAULT_PROFILE_TRACKS=25
SUNO_MAX_PROFILE_TRACKS=500
MAX_CONSECUTIVE_PLAYBACK_FAILURES=3
```

4. Run the bot:

```bash
npm start
```

## Commands

- `!play <suno-url>`: Add a Suno song or playlist URL to queue
- `!profile <@handle|profile-url> [count|all] [top|recent]`: Queue public songs from a Suno profile
- `!queue`: Show current queue
- `!now`: Show currently playing track
- `!skip`: Skip current track
- `!stop`: Stop playback, clear queue, and disconnect
- `!help`: Show command help

## Notes

- The bot expects Suno URLs (`suno.com`).
- If playback fails, ensure `ffmpeg` and `yt-dlp` both work from your terminal.
- Depending on Suno or extractor changes, `yt-dlp` support may need updates.

## Debug Logging

- Set `LOG_LEVEL=debug` in `.env` for verbose connection and playback logs.
- Start normally with `npm start` and watch terminal output.
