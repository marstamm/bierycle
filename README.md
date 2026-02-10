# 🎵 Lyricle – Guess the Song from its Lyrics

A Wordle-style guessing game where you identify songs from their lyrics, one line at a time.

## How It Works

1. You see **1 line** of lyrics from a random song
2. You type a guess — song titles autocomplete from your library
3. Wrong? Another line is revealed
4. You have **6 attempts** — fewer guesses = better score!

## Quick Start

### 1. Install Python dependencies

```bash
cd ingest
pip install -r requirements.txt
```

### 2. Prepare your song list

Create a file with your songs in any of these formats:

**Plain text** (`songs.txt`) — easiest:
```
Queen - Bohemian Rhapsody
Adele - Rolling in the Deep
Nirvana - Smells Like Teen Spirit
The Beatles - Yesterday
Radiohead - Creep
```

**Simple CSV** (`songs.csv`):
```csv
title,artist
Bohemian Rhapsody,Queen
Rolling in the Deep,Adele
```

**Spotify playlist CSV** (from [exportify.net](https://exportify.net)):
- Export any playlist — the script reads `Track Name` and `Artist Name(s)` columns automatically.

**Spotify extended streaming history JSON**:
- Request your data from Spotify Privacy settings → the script reads `master_metadata_track_name` and `master_metadata_album_artist_name`.

### 3. Run the ingest script

```bash
python ingest/ingest.py songs.txt
```

Options:
```
python ingest/ingest.py <input_file> [--output path/to/songs.json] [--min-lines 6]
```

- `--output` / `-o` — output path (default: `data/songs.json`)
- `--min-lines` — minimum lyric lines required per song (default: 6)

The script fetches lyrics from [lrclib.net](https://lrclib.net) (free, no API key needed) and shows progress:

```
[1/5] Queen - Bohemian Rhapsody ... ✅ (42 lines)
[2/5] Adele - Rolling in the Deep ... ✅ (28 lines)
[3/5] Nirvana - Smells Like Teen Spirit ... ✅ (18 lines)
...
✅ Success: 4 songs with lyrics
⏭ Skipped: 0 songs (too few lines)
❌ Failed:  1 songs (no lyrics found)
```

### 4. Start the game

Serve the project with any HTTP server:

```bash
# From the project root
python -m http.server 8000
```

Open **http://localhost:8000** in your browser.

### Alternative: Upload songs.json directly

If you already have a `songs.json` file, you can drag & drop it onto the game page — no server-side setup needed. The file must be a JSON array with this structure:

```json
[
  {
    "title": "Bohemian Rhapsody",
    "artist": "Queen",
    "lines": [
      "Is this the real life? Is this just fantasy?",
      "Caught in a landslide, no escape from reality",
      "..."
    ]
  }
]
```

## Project Structure

```
lyrics_guessing_game/
├── index.html          # Game page
├── css/style.css       # Wordle-inspired dark theme
├── js/game.js          # Frontend-only game engine
├── data/songs.json     # Generated song data (after ingest)
├── ingest/
│   ├── ingest.py       # Song ingestion + lyrics fetcher
│   └── requirements.txt
└── README.md
```

## Features

- 🎨 **Wordle-inspired UI** — dark theme, progress indicators, animations
- 🔍 **Autocomplete** — fuzzy search through your song library as you type
- 📊 **Statistics** — tracks games played, win %, streaks, guess distribution
- 📋 **Share results** — copy emoji grid to clipboard (🟩🟥🟨)
- 📁 **Drag & drop** — upload a new `songs.json` anytime
- 💾 **Offline-capable** — songs are cached in localStorage
- 📱 **Responsive** — works on desktop and mobile

## Tech Stack

- **Ingest**: Python 3 + requests (lrclib.net API)
- **Frontend**: Vanilla HTML/CSS/JS — no frameworks, no build step
