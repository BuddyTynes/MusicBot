# Suno Discord Music Bot

A Discord bot that accepts Suno song links and playlist links, queues them, and plays them in voice chat.

## Features

- Queue a Suno song or playlist with one command
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
```

4. Run the bot:

```bash
npm start
```

## Commands

- `!play <suno-url>`: Add a Suno song or playlist URL to queue
- `!queue`: Show current queue
- `!now`: Show currently playing track
- `!skip`: Skip current track
- `!stop`: Stop playback, clear queue, and disconnect
- `!help`: Show command help

## Notes

- The bot expects Suno URLs (`suno.com`).
- If playback fails, ensure `ffmpeg` and `yt-dlp` both work from your terminal.
- Depending on Suno or extractor changes, `yt-dlp` support may need updates.
