#!/usr/bin/env python3
"""
Lyrics Ingest Script
====================
Reads a list of songs (CSV or JSON) and fetches lyrics from the free lrclib.net API.
Outputs a songs.json file for the frontend game.

Supported input formats:
  1. Spotify CSV export (must have 'Track Name' and 'Artist Name(s)' columns)
  2. Simple CSV with columns: title, artist
  3. JSON array of objects: [{"title": "...", "artist": "..."}, ...]
  4. Plain text file with "Artist - Title" per line

Usage:
  python ingest.py <input_file> [--output ../data/songs.json]
"""

import argparse
import csv
import json
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests

LRCLIB_SEARCH_URL = "https://lrclib.net/api/search"
LRCLIB_GET_URL = "https://lrclib.net/api/get"

HEADERS = {"User-Agent": "LyricsGuessingGame/1.0"}
TIMEOUT = 10

# Max parallel requests – be reasonable with the free API
MAX_WORKERS = 6


def split_artists(artist_str: str) -> list[str]:
    """
    Split a combined artist string into individual artists.
    Handles separators: ; , & feat. ft. featuring x vs. with and /
    """
    normalized = artist_str
    for sep in [" featuring ", " feat. ", " feat ", " ft. ", " ft "]:
        normalized = normalized.replace(sep, ";")
    for sep in [" x ", " vs. ", " vs ", " with ", " & ", ", ", "/"]:
        normalized = normalized.replace(sep, ";")

    artists = [a.strip() for a in normalized.split(";") if a.strip()]
    return artists if artists else [artist_str]


def parse_spotify_csv(filepath: str) -> list[dict]:
    """Parse Spotify export CSV format."""
    songs = []
    with open(filepath, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        headers = reader.fieldnames or []

        # Spotify extended streaming history format
        if "master_metadata_track_name" in headers:
            seen = set()
            for row in reader:
                title = row.get("master_metadata_track_name", "").strip()
                artist = row.get("master_metadata_album_artist_name", "").strip()
                if title and artist:
                    key = f"{title}".lower()
                    if key not in seen:
                        seen.add(key)
                        all_artists = split_artists(artist)
                        songs.append({
                            "title": title,
                            "artist": all_artists[0],
                            "all_artists": all_artists,
                            "display_artist": artist.replace(";", ", "),
                        })
        # Spotify playlist export (e.g., from exportify)
        elif "Track Name" in headers:
            for row in reader:
                title = row.get("Track Name", "").strip()
                artist_raw = row.get("Artist Name(s)", row.get("Artist", "")).strip()
                if title and artist_raw:
                    all_artists = split_artists(artist_raw)
                    songs.append({
                        "title": title,
                        "artist": all_artists[0],
                        "all_artists": all_artists,
                        "display_artist": artist_raw.replace(";", ", "),
                    })
        # Simple CSV: title, artist
        elif "title" in headers or "Title" in headers:
            for row in reader:
                title = row.get("title", row.get("Title", "")).strip()
                artist = row.get("artist", row.get("Artist", "")).strip()
                if title and artist:
                    all_artists = split_artists(artist)
                    songs.append({
                        "title": title,
                        "artist": all_artists[0],
                        "all_artists": all_artists,
                        "display_artist": artist,
                    })
        else:
            print(f"⚠ Unrecognized CSV columns: {headers}")
            print("  Expected: 'Track Name'+'Artist Name(s)', or 'title'+'artist'")
            sys.exit(1)

    return songs


def parse_json_input(filepath: str) -> list[dict]:
    """Parse JSON input: array of {title, artist} objects."""
    with open(filepath, "r", encoding="utf-8") as f:
        data = json.load(f)

    if isinstance(data, list):
        songs = []
        for item in data:
            title = item.get("title", item.get("name", item.get("track", ""))).strip()
            artist = item.get("artist", item.get("artists", ""))
            if isinstance(artist, list):
                all_artists = [a.strip() for a in artist if a.strip()]
                display = ", ".join(all_artists)
                artist = all_artists[0] if all_artists else ""
            else:
                artist = artist.strip()
                all_artists = split_artists(artist)
                display = artist
            if title and artist:
                songs.append({
                    "title": title,
                    "artist": all_artists[0],
                    "all_artists": all_artists,
                    "display_artist": display,
                })
        return songs
    else:
        print("⚠ JSON file must contain an array of song objects.")
        sys.exit(1)


def parse_text_input(filepath: str) -> list[dict]:
    """Parse plain text: 'Artist - Title' per line."""
    songs = []
    with open(filepath, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if " - " in line:
                parts = line.split(" - ", 1)
                artist_raw = parts[0].strip()
                title = parts[1].strip()
                if title and artist_raw:
                    all_artists = split_artists(artist_raw)
                    songs.append({
                        "title": title,
                        "artist": all_artists[0],
                        "all_artists": all_artists,
                        "display_artist": artist_raw,
                    })
            else:
                print(f"  Skipping unrecognized line: {line}")
    return songs


def load_songs(filepath: str) -> list[dict]:
    """Auto-detect format and load songs."""
    ext = Path(filepath).suffix.lower()

    if ext == ".json":
        return parse_json_input(filepath)
    elif ext in (".csv", ".tsv"):
        return parse_spotify_csv(filepath)
    elif ext in (".txt", ".text"):
        return parse_text_input(filepath)
    else:
        try:
            return parse_spotify_csv(filepath)
        except Exception:
            return parse_text_input(filepath)


def clean_lyrics_lines(plain_lyrics: str) -> list[str]:
    """
    Split lyrics into meaningful lines for the game.
    Removes empty lines, section headers like [Chorus], very short lines, etc.
    """
    if not plain_lyrics:
        return []

    lines = plain_lyrics.split("\n")
    cleaned = []

    for line in lines:
        line = line.strip()
        if not line:
            continue
        if re.match(r"^\[.*\]$", line):
            continue
        if len(line) < 10:
            continue
        if re.match(r"^[\W\d]+$", line):
            continue
        cleaned.append(line)

    return cleaned


def _normalize(text: str) -> str:
    """Normalize text for fuzzy comparison: lowercase, strip punctuation, collapse whitespace."""
    text = text.lower().strip()
    text = re.sub(r"[^\w\s]", "", text)  # remove punctuation
    text = re.sub(r"\s+", " ", text)      # collapse whitespace
    return text


def _matches_song(result: dict, title: str, all_artists: list[str]) -> bool:
    """
    Sanity-check that a search result actually belongs to our song.
    Checks that either:
      - The result track name contains our title (or vice versa), OR
      - At least one of our artists appears in the result's artist name
    """
    result_track = _normalize(result.get("trackName", ""))
    result_artist = _normalize(result.get("artistName", ""))
    norm_title = _normalize(title)

    # Check title match (either direction — one contains the other)
    title_match = (norm_title in result_track) or (result_track in norm_title)

    # Check if any of our artists appear in the result artist
    artist_match = any(
        _normalize(a) in result_artist or result_artist in _normalize(a)
        for a in all_artists
    )

    return title_match or artist_match


def _try_fetch(title: str, artist: str) -> str | None:
    """Single attempt: try exact GET then search for one artist."""
    try:
        resp = requests.get(
            LRCLIB_GET_URL,
            params={"track_name": title, "artist_name": artist},
            headers=HEADERS,
            timeout=TIMEOUT,
        )
        if resp.status_code == 200:
            plain = resp.json().get("plainLyrics", "")
            if plain:
                return plain

        resp = requests.get(
            LRCLIB_SEARCH_URL,
            params={"track_name": title, "artist_name": artist},
            headers=HEADERS,
            timeout=TIMEOUT,
        )
        if resp.status_code == 200:
            for result in resp.json():
                plain = result.get("plainLyrics", "")
                if plain:
                    return plain

        return None
    except requests.RequestException:
        return None


def _try_search_title_only(title: str, original_title: str = "", all_artists: list[str] | None = None) -> str | None:
    """Search by title only (track_name param), with optional validation."""
    try:
        resp = requests.get(
            LRCLIB_SEARCH_URL,
            params={"track_name": title},
            headers=HEADERS,
            timeout=TIMEOUT,
        )
        if resp.status_code == 200:
            for result in resp.json():
                plain = result.get("plainLyrics", "")
                if not plain:
                    continue
                # If validation context provided, check the result matches
                if all_artists is not None:
                    check_title = original_title or title
                    if not _matches_song(result, check_title, all_artists):
                        continue
                return plain
        return None
    except requests.RequestException:
        return None


def _try_search_freetext(query: str, original_title: str = "", all_artists: list[str] | None = None) -> str | None:
    """Search using the free-text q= parameter which matches across all fields."""
    try:
        resp = requests.get(
            LRCLIB_SEARCH_URL,
            params={"q": query},
            headers=HEADERS,
            timeout=TIMEOUT,
        )
        if resp.status_code == 200:
            for result in resp.json():
                plain = result.get("plainLyrics", "")
                if not plain:
                    continue
                # If validation context provided, check the result matches
                if all_artists is not None:
                    check_title = original_title or query
                    if not _matches_song(result, check_title, all_artists):
                        continue
                return plain
        return None
    except requests.RequestException:
        return None


def fetch_lyrics(song: dict) -> str | None:
    """
    Fetch lyrics with multiple fallback strategies:
    1. Try first (primary) artist
    2. Try each additional artist individually
    3. Try title-only search (track_name param)
    4. Try with cleaned title (remove parenthetical text)
    5. Free-text search with just the song name
    6. Free-text search with song name + primary artist
    """
    title = song["title"]
    all_artists = song.get("all_artists", [song["artist"]])

    # Strategy 1 & 2: try each artist
    for artist in all_artists:
        lyrics = _try_fetch(title, artist)
        if lyrics:
            return lyrics

    # Strategy 3: title-only search (track_name param) — with validation
    lyrics = _try_search_title_only(title, original_title=title, all_artists=all_artists)
    if lyrics:
        return lyrics

    # Strategy 4: try with cleaned title (remove text in parentheses) — with validation
    clean_title = re.sub(r"\s*\(.*?\)\s*", " ", title).strip()
    if clean_title != title:
        lyrics = _try_search_title_only(clean_title, original_title=title, all_artists=all_artists)
        if lyrics:
            return lyrics

    # Strategy 5: free-text search with just the song name — with validation
    lyrics = _try_search_freetext(title, original_title=title, all_artists=all_artists)
    if lyrics:
        return lyrics

    # Strategy 6: free-text search with song name + primary artist — with validation
    lyrics = _try_search_freetext(f"{all_artists[0]} {title}", original_title=title, all_artists=all_artists)
    if lyrics:
        return lyrics

    return None


def process_song(song: dict, index: int, total: int, min_lines: int):
    """Process a single song: fetch lyrics and return result dict or None."""
    title = song["title"]
    display_artist = song.get("display_artist", song["artist"])

    lyrics = fetch_lyrics(song)

    if lyrics:
        lines = clean_lyrics_lines(lyrics)
        if len(lines) >= min_lines:
            return {
                "status": "ok",
                "data": {
                    "title": title,
                    "artist": display_artist,
                    "lines": lines,
                },
                "msg": f"✅ ({len(lines)} lines)",
            }
        else:
            return {
                "status": "skip",
                "msg": f"⏭ Too few lines ({len(lines)}/{min_lines})",
            }
    else:
        return {
            "status": "fail",
            "msg": "❌ No lyrics found",
        }


def main():
    parser = argparse.ArgumentParser(
        description="Ingest songs and fetch lyrics for the guessing game."
    )
    parser.add_argument(
        "input_file",
        help="Path to input file (CSV, JSON, or TXT with 'Artist - Title' lines)",
    )
    parser.add_argument(
        "--output", "-o",
        default=os.path.join(os.path.dirname(__file__), "..", "data", "songs.json"),
        help="Output path for songs.json (default: ../data/songs.json)",
    )
    parser.add_argument(
        "--min-lines", type=int, default=6,
        help="Minimum number of lyric lines needed (default: 6)",
    )
    parser.add_argument(
        "--workers", "-w", type=int, default=MAX_WORKERS,
        help=f"Number of parallel requests (default: {MAX_WORKERS})",
    )

    args = parser.parse_args()

    if not os.path.exists(args.input_file):
        print(f"❌ Input file not found: {args.input_file}")
        sys.exit(1)

    print(f"📂 Loading songs from: {args.input_file}")
    songs = load_songs(args.input_file)
    print(f"   Found {len(songs)} songs")
    print(f"   Using {args.workers} parallel workers\n")

    if not songs:
        print("❌ No songs found in the input file.")
        sys.exit(1)

    output_songs = []
    success = 0
    skipped = 0
    failed = 0
    total = len(songs)

    # Process songs in parallel
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        future_to_song = {
            executor.submit(process_song, song, i, total, args.min_lines): (i, song)
            for i, song in enumerate(songs)
        }

        for future in as_completed(future_to_song):
            idx, song = future_to_song[future]
            title = song["title"]
            display_artist = song.get("display_artist", song["artist"])

            try:
                result = future.result()
            except Exception as e:
                result = {"status": "fail", "msg": f"❌ Error: {e}"}

            status_msg = result["msg"]
            print(f"[{idx + 1}/{total}] {display_artist} – {title} ... {status_msg}")

            if result["status"] == "ok":
                output_songs.append(result["data"])
                success += 1
            elif result["status"] == "skip":
                skipped += 1
            else:
                failed += 1

    # Sort output by title for consistency
    output_songs.sort(key=lambda s: s["title"].lower())

    # Write output
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(output_songs, f, ensure_ascii=False, indent=2)

    print(f"\n{'=' * 50}")
    print(f"✅ Success: {success} songs with lyrics")
    print(f"⏭ Skipped: {skipped} songs (too few lines)")
    print(f"❌ Failed:  {failed} songs (no lyrics found)")
    print(f"\n💾 Output saved to: {os.path.abspath(args.output)}")
    print(f"   Total songs in data pool: {len(output_songs)}")


if __name__ == "__main__":
    main()
