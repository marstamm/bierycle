/**
 * Lyricle – Guess the Song from its Lyrics
 * Pure frontend game engine with Daily + Practice modes
 */

(function () {
  'use strict';

  // ===== Constants =====
  const MAX_GUESSES = 6;
  const STORAGE_KEY_STATS = 'lyricle_stats';
  const STORAGE_KEY_SONGS = 'lyricle_songs';
  const STORAGE_KEY_DAILY = 'lyricle_daily';
  const DATA_PATH = 'data/songs.json';
  // Epoch for daily numbering (arbitrary fixed start date)
  const DAILY_EPOCH = new Date('2026-02-01T00:00:00');

  // ===== State =====
  let songs = [];
  let currentSong = null;
  let revealedLines = [];
  let guesses = [];
  let round = 0;
  let gameOver = false;
  let selectedAutocompleteIndex = -1;
  let playedSongIndices = new Set();
  let mode = 'daily'; // 'daily' or 'practice'

  // ===== Seeded RNG (mulberry32) =====
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function getTodayString() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }

  function getDailyNumber(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    const diff = d - DAILY_EPOCH;
    return Math.floor(diff / (1000 * 60 * 60 * 24));
  }

  function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + ch;
      hash |= 0;
    }
    return hash;
  }

  // ===== DOM Elements =====
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const elLoading = $('#loading');
  const elNoData = $('#no-data');
  const elGame = $('#game');
  const elResult = $('#result');
  const elLyricsArea = $('#lyrics-area');
  const elGuessInput = $('#guess-input');
  const elAutocomplete = $('#autocomplete-list');
  const elGuessHistory = $('#guesses-history');
  const elSongCount = $('#song-count');

  // ===== Init =====
  async function init() {
    setupEventListeners();
    await loadSongs();
  }

  // ===== Song Loading =====
  async function loadSongs() {
    showScreen('loading');

    // Try loading from localStorage first
    const cached = localStorage.getItem(STORAGE_KEY_SONGS);
    if (cached) {
      try {
        songs = JSON.parse(cached);
        if (songs.length > 0) {
          onSongsLoaded();
          return;
        }
      } catch (e) { /* ignore */ }
    }

    // Try fetching from data/songs.json
    try {
      const resp = await fetch(DATA_PATH);
      if (resp.ok) {
        songs = await resp.json();
        if (songs.length > 0) {
          localStorage.setItem(STORAGE_KEY_SONGS, JSON.stringify(songs));
          onSongsLoaded();
          return;
        }
      }
    } catch (e) { /* ignore */ }

    // No data available
    showScreen('no-data');
  }

  function onSongsLoaded() {
    elSongCount.textContent = songs.length;
    playedSongIndices.clear();
    setMode('daily');
  }

  function handleFileUpload(file) {
    if (!file || !file.name.endsWith('.json')) {
      showToast('Please provide a .json file');
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result);
        if (Array.isArray(data) && data.length > 0 && data[0].lines) {
          songs = data;
          localStorage.setItem(STORAGE_KEY_SONGS, JSON.stringify(songs));
          onSongsLoaded();
          showToast(`Loaded ${songs.length} songs!`);
        } else {
          showToast('Invalid format. Expected array with {title, artist, lines}.');
        }
      } catch (err) {
        showToast('Error parsing JSON file.');
      }
    };
    reader.readAsText(file);
  }

  // ===== Mode Management =====
  function setMode(newMode) {
    mode = newMode;

    // Update mode buttons
    $('#btn-mode-daily').classList.toggle('active', mode === 'daily');
    $('#btn-mode-practice').classList.toggle('active', mode === 'practice');

    // Show/hide daily info
    const dailyInfo = $('#daily-info');
    if (mode === 'daily') {
      dailyInfo.classList.remove('hidden');
      const today = getTodayString();
      const num = getDailyNumber(today);
      $('#daily-date').textContent = new Date(today + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
      $('#daily-number').textContent = `#${num}`;
    } else {
      dailyInfo.classList.add('hidden');
    }

    if (mode === 'daily') {
      startDailyGame();
    } else {
      startPracticeRound();
    }
  }

  // ===== Daily Mode =====
  function getDailySave() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY_DAILY)) || {};
    } catch { return {}; }
  }

  function saveDailyState() {
    const today = getTodayString();
    const state = {
      date: today,
      songIndex: songs.indexOf(currentSong),
      guesses: guesses,
      round: round,
      gameOver: gameOver,
      won: guesses.some(g => g.correct),
      startLineIndex: currentSong._startLineIndex,
    };
    localStorage.setItem(STORAGE_KEY_DAILY, JSON.stringify(state));
  }

  function startDailyGame() {
    const today = getTodayString();
    const saved = getDailySave();

    // Resume or show completed daily
    if (saved.date === today && saved.songIndex !== undefined) {
      currentSong = songs[saved.songIndex];
      const startIdx = saved.startLineIndex || 0;
      currentSong._gameLines = currentSong.lines.slice(startIdx, startIdx + MAX_GUESSES);
      currentSong._startLineIndex = startIdx;
      guesses = saved.guesses || [];
      round = saved.round || 0;
      gameOver = saved.gameOver || false;

      if (gameOver) {
        // Already completed today — show result
        showResult(saved.won);
        return;
      }

      // Restore in-progress game
      restoreGameUI();
      return;
    }

    // Start a new daily game
    const seed = hashString('lyricle-daily-' + today);
    const rng = mulberry32(seed);

    const idx = Math.floor(rng() * songs.length);
    currentSong = songs[idx];

    const totalLines = currentSong.lines.length;
    const maxStart = Math.max(0, totalLines - MAX_GUESSES);
    const startIdx = Math.floor(rng() * (maxStart + 1));
    currentSong._startLineIndex = startIdx;
    currentSong._gameLines = currentSong.lines.slice(startIdx, startIdx + MAX_GUESSES);

    revealedLines = [];
    guesses = [];
    round = 0;
    gameOver = false;
    selectedAutocompleteIndex = -1;

    setupGameUI();
    saveDailyState();
  }

  function restoreGameUI() {
    showScreen('game');
    elLyricsArea.innerHTML = '';
    elGuessHistory.innerHTML = '';
    elGuessInput.value = '';
    elGuessInput.disabled = false;
    elAutocomplete.classList.add('hidden');
    $('#btn-guess').disabled = false;
    $('#btn-skip').disabled = false;
    revealedLines = [];

    // Replay all revealed lines and guesses
    for (let i = 0; i < round; i++) {
      // Reveal the line
      const line = currentSong._gameLines[i];
      if (line) {
        revealedLines.push(line);
        const el = document.createElement('div');
        el.className = 'lyric-line';
        el.innerHTML = `<span class="line-number">${i + 1}</span>${escapeHtml(line)}`;
        elLyricsArea.appendChild(el);
      }
    }

    // Restore progress steps
    updateProgressBar();
    for (let i = 0; i < guesses.length; i++) {
      const g = guesses[i];
      const type = g.correct ? 'correct' : g.skip ? 'skip' : 'wrong';
      updateProgressStep(i + 1, type);
      addGuessEntry(g.text, type);
    }

    // Now reveal the next line for the current guess
    revealNextLine();
    updatePlaceholders();
    elGuessInput.focus();
  }

  // ===== Practice Mode =====
  function startPracticeRound() {
    if (playedSongIndices.size >= songs.length) {
      playedSongIndices.clear();
    }

    let idx;
    do {
      idx = Math.floor(Math.random() * songs.length);
    } while (playedSongIndices.has(idx) && playedSongIndices.size < songs.length);

    playedSongIndices.add(idx);
    currentSong = songs[idx];

    const totalLines = currentSong.lines.length;
    const maxStart = Math.max(0, totalLines - MAX_GUESSES);
    const startIdx = Math.floor(Math.random() * (maxStart + 1));
    currentSong._startLineIndex = startIdx;
    currentSong._gameLines = currentSong.lines.slice(startIdx, startIdx + MAX_GUESSES);

    revealedLines = [];
    guesses = [];
    round = 0;
    gameOver = false;
    selectedAutocompleteIndex = -1;

    setupGameUI();
  }

  // ===== Common Game Setup =====
  function setupGameUI() {
    showScreen('game');
    elLyricsArea.innerHTML = '';
    elGuessHistory.innerHTML = '';
    elGuessInput.value = '';
    elGuessInput.disabled = false;
    elAutocomplete.classList.add('hidden');
    $('#btn-guess').disabled = false;
    $('#btn-skip').disabled = false;

    updateProgressBar();
    revealNextLine();
    elGuessInput.focus();
  }

  function revealNextLine() {
    if (round >= MAX_GUESSES) return;

    const line = currentSong._gameLines[round];
    if (!line) return;

    revealedLines.push(line);

    // Remove previous "new" highlights
    elLyricsArea.querySelectorAll('.lyric-line.new').forEach(el => {
      el.classList.remove('new');
    });

    // Add the new line
    const el = document.createElement('div');
    el.className = 'lyric-line new';
    el.innerHTML = `<span class="line-number">${round + 1}</span>${escapeHtml(line)}`;
    elLyricsArea.appendChild(el);

    // Add placeholders for remaining lines
    updatePlaceholders();

    // Scroll to the latest line
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function updatePlaceholders() {
    // Remove existing placeholders
    elLyricsArea.querySelectorAll('.lyric-placeholder').forEach(el => el.remove());

    // Add placeholders for unrevealed lines
    const remaining = MAX_GUESSES - revealedLines.length;
    for (let i = 0; i < remaining; i++) {
      const ph = document.createElement('div');
      ph.className = 'lyric-placeholder';
      ph.textContent = `Line ${revealedLines.length + i + 1} — guess to reveal or skip`;
      elLyricsArea.appendChild(ph);
    }
  }

  function makeGuess(guessText) {
    if (gameOver || round >= MAX_GUESSES) return;
    if (!guessText.trim()) return;

    const isCorrect = normalizeForMatch(guessText) === normalizeForMatch(currentSong.title);

    guesses.push({ text: guessText, correct: isCorrect, skip: false });
    round++;

    // Update progress bar
    updateProgressStep(round, isCorrect ? 'correct' : 'wrong');

    // Add to guess history
    addGuessEntry(guessText, isCorrect ? 'correct' : 'wrong');

    // Clear input
    elGuessInput.value = '';
    hideAutocomplete();

    if (isCorrect) {
      endGame(true);
    } else if (round >= MAX_GUESSES) {
      endGame(false);
    } else {
      // Shake input on wrong guess
      elGuessInput.classList.add('shake');
      setTimeout(() => elGuessInput.classList.remove('shake'), 400);

      // Save daily progress
      if (mode === 'daily') saveDailyState();

      revealNextLine();
      elGuessInput.focus();
    }
  }

  function skipGuess() {
    if (gameOver || round >= MAX_GUESSES) return;

    guesses.push({ text: '(skipped)', correct: false, skip: true });
    round++;

    // Update progress bar
    updateProgressStep(round, 'skip');

    // Add to guess history
    addGuessEntry('Skipped', 'skip');

    if (round >= MAX_GUESSES) {
      endGame(false);
    } else {
      // Save daily progress
      if (mode === 'daily') saveDailyState();

      revealNextLine();
      elGuessInput.focus();
    }
  }

  function endGame(won) {
    gameOver = true;
    elGuessInput.disabled = true;
    $('#btn-guess').disabled = true;
    $('#btn-skip').disabled = true;

    // Save stats
    saveStats(won, round);

    // Save daily state if in daily mode
    if (mode === 'daily') {
      saveDailyState();
    }

    // Show result after a brief delay
    setTimeout(() => {
      showResult(won);
    }, 600);
  }

  function showResult(won) {
    showScreen('result');

    const resultIcon = $('#result-icon');
    const resultTitle = $('#result-title');
    const resultSubtitle = $('#result-subtitle');
    const resultSongInfo = $('#result-song-info');
    const btnNext = $('#btn-next');
    const dailyDoneMsg = $('#daily-done-msg');

    if (won) {
      resultIcon.textContent = '🎉';
      resultTitle.textContent = round === 1 ? 'Incredible!' :
                                 round <= 3 ? 'Great job!' :
                                 round <= 5 ? 'Nice!' : 'Phew!';
      resultSubtitle.textContent = `You got it in ${round} ${round === 1 ? 'guess' : 'guesses'}!`;
    } else {
      resultIcon.textContent = '😔';
      resultTitle.textContent = 'Better luck next time!';
      resultSubtitle.textContent = "You couldn't guess the song in 6 tries.";
    }

    resultSongInfo.innerHTML = `
      <div class="song-title">🎵 ${escapeHtml(currentSong.title)}</div>
      <div class="song-artist">by ${escapeHtml(currentSong.artist)}</div>
    `;

    // In daily mode: hide "Next Song", show "come back tomorrow" message
    if (mode === 'daily') {
      btnNext.textContent = '🔄 Play Practice Mode';
      btnNext.onclick = () => setMode('practice');
      dailyDoneMsg.classList.remove('hidden');
    } else {
      btnNext.textContent = 'Next Song →';
      btnNext.onclick = () => startPracticeRound();
      dailyDoneMsg.classList.add('hidden');
    }
  }

  // ===== Autocomplete =====
  function updateAutocomplete(query) {
    if (!query || query.length < 2) {
      hideAutocomplete();
      return;
    }

    const normalizedQuery = query.toLowerCase().trim();
    const matches = [];
    const seen = new Set();

    for (const song of songs) {
      const key = `${song.title}|||${song.artist}`.toLowerCase();
      if (seen.has(key)) continue;

      const titleLower = song.title.toLowerCase();
      const artistLower = song.artist.toLowerCase();

      if (titleLower.includes(normalizedQuery) || artistLower.includes(normalizedQuery)) {
        seen.add(key);
        matches.push(song);
        if (matches.length >= 8) break;
      }
    }

    if (matches.length === 0) {
      hideAutocomplete();
      return;
    }

    selectedAutocompleteIndex = -1;
    elAutocomplete.innerHTML = '';

    matches.forEach((song, i) => {
      const div = document.createElement('div');
      div.className = 'autocomplete-item';
      div.dataset.index = i;

      const titleHtml = highlightMatch(song.title, query);
      const artistHtml = highlightMatch(song.artist, query);

      div.innerHTML = `
        <span class="song-title">${titleHtml}</span>
        <span class="song-artist">${artistHtml}</span>
      `;

      div.addEventListener('click', () => {
        elGuessInput.value = song.title;
        hideAutocomplete();
        makeGuess(song.title);
      });

      elAutocomplete.appendChild(div);
    });

    elAutocomplete.classList.remove('hidden');
  }

  function highlightMatch(text, query) {
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return escapeHtml(text);

    const before = text.slice(0, idx);
    const match = text.slice(idx, idx + query.length);
    const after = text.slice(idx + query.length);

    return `${escapeHtml(before)}<span class="match-highlight">${escapeHtml(match)}</span>${escapeHtml(after)}`;
  }

  function hideAutocomplete() {
    elAutocomplete.classList.add('hidden');
    elAutocomplete.innerHTML = '';
    selectedAutocompleteIndex = -1;
  }

  function navigateAutocomplete(direction) {
    const items = elAutocomplete.querySelectorAll('.autocomplete-item');
    if (items.length === 0) return;

    items.forEach(item => item.classList.remove('active'));

    if (direction === 'down') {
      selectedAutocompleteIndex = Math.min(selectedAutocompleteIndex + 1, items.length - 1);
    } else {
      selectedAutocompleteIndex = Math.max(selectedAutocompleteIndex - 1, -1);
    }

    if (selectedAutocompleteIndex >= 0) {
      items[selectedAutocompleteIndex].classList.add('active');
      const song = songs.find(s =>
        s.title === items[selectedAutocompleteIndex].querySelector('.song-title').textContent.trim() ||
        items[selectedAutocompleteIndex].querySelector('.song-title').textContent.includes(s.title)
      );
      // Update input with selected autocomplete item title
      const titleEl = items[selectedAutocompleteIndex].querySelector('.song-title');
      elGuessInput.value = titleEl.textContent;
    }
  }

  function selectAutocompleteItem() {
    const items = elAutocomplete.querySelectorAll('.autocomplete-item');
    if (selectedAutocompleteIndex >= 0 && selectedAutocompleteIndex < items.length) {
      items[selectedAutocompleteIndex].click();
      return true;
    }
    return false;
  }

  // ===== UI Helpers =====
  function showScreen(name) {
    [elLoading, elNoData, elGame, elResult].forEach(el => el.classList.add('hidden'));

    switch (name) {
      case 'loading': elLoading.classList.remove('hidden'); break;
      case 'no-data': elNoData.classList.remove('hidden'); break;
      case 'game': elGame.classList.remove('hidden'); break;
      case 'result': elResult.classList.remove('hidden'); break;
    }
  }

  function updateProgressBar() {
    $$('.progress-step').forEach((step, i) => {
      step.className = 'progress-step';
      if (i === round) step.classList.add('active');
    });
  }

  function updateProgressStep(stepNum, type) {
    const step = $(`.progress-step[data-step="${stepNum}"]`);
    if (step) {
      step.classList.remove('active');
      step.classList.add(type);
    }

    // Highlight next step
    if (stepNum < MAX_GUESSES) {
      const next = $(`.progress-step[data-step="${stepNum + 1}"]`);
      if (next) next.classList.add('active');
    }
  }

  function addGuessEntry(text, type) {
    const div = document.createElement('div');
    div.className = `guess-entry ${type}`;

    const icon = type === 'correct' ? '✅' : type === 'skip' ? '⏭️' : '❌';

    div.innerHTML = `
      <span class="guess-icon">${icon}</span>
      <span class="guess-text">${escapeHtml(text)}</span>
    `;

    elGuessHistory.appendChild(div);
  }

  function showToast(msg) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2200);
  }

  // ===== Stats =====
  function getStats() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY_STATS)) || defaultStats();
    } catch {
      return defaultStats();
    }
  }

  function defaultStats() {
    return {
      played: 0,
      wins: 0,
      streak: 0,
      maxStreak: 0,
      distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 },
    };
  }

  function saveStats(won, guessCount) {
    const stats = getStats();
    stats.played++;

    if (won) {
      stats.wins++;
      stats.streak++;
      stats.maxStreak = Math.max(stats.maxStreak, stats.streak);
      stats.distribution[guessCount] = (stats.distribution[guessCount] || 0) + 1;
    } else {
      stats.streak = 0;
    }

    localStorage.setItem(STORAGE_KEY_STATS, JSON.stringify(stats));
  }

  function showStats() {
    const stats = getStats();

    $('#stat-played').textContent = stats.played;
    $('#stat-win-pct').textContent = stats.played ? Math.round((stats.wins / stats.played) * 100) : 0;
    $('#stat-streak').textContent = stats.streak;
    $('#stat-max-streak').textContent = stats.maxStreak;

    // Distribution
    const distEl = $('#distribution');
    distEl.innerHTML = '';

    const maxVal = Math.max(1, ...Object.values(stats.distribution));

    for (let i = 1; i <= 6; i++) {
      const count = stats.distribution[i] || 0;
      const pct = Math.max(8, (count / maxVal) * 100);

      const row = document.createElement('div');
      row.className = 'dist-row';
      row.innerHTML = `
        <div class="dist-label">${i}</div>
        <div class="dist-bar${round === i && gameOver ? ' highlight' : ''}" style="width: ${pct}%">${count}</div>
      `;
      distEl.appendChild(row);
    }

    openModal('modal-stats');
  }

  // ===== Share =====
  function shareResult() {
    const won = guesses.some(g => g.correct);
    const score = won ? round : 'X';

    let grid = '';
    for (const g of guesses) {
      if (g.correct) grid += '🟩';
      else if (g.skip) grid += '🟨';
      else grid += '🟥';
    }
    // Pad remaining
    for (let i = guesses.length; i < MAX_GUESSES; i++) {
      grid += '⬛';
    }

    let label = '🎵 Bierycle';
    if (mode === 'daily') {
      const num = getDailyNumber(getTodayString());
      label += ` #${num}`;
    }
    const text = `${label} ${score}/${MAX_GUESSES}\n${grid}`;

    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => {
        showToast('Copied to clipboard!');
      });
    } else {
      showToast(text);
    }
  }

  // ===== Modals =====
  function openModal(id) {
    $(`#${id}`).classList.remove('hidden');
  }

  function closeModal(id) {
    $(`#${id}`).classList.add('hidden');
  }

  function closeAllModals() {
    $$('.modal').forEach(m => m.classList.add('hidden'));
  }

  // ===== Utilities =====
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function normalizeForMatch(str) {
    return str
      .toLowerCase()
      .trim()
      .replace(/[^\w\s]/g, '')  // Remove punctuation
      .replace(/\s+/g, ' ');    // Normalize whitespace
  }

  // ===== Event Listeners =====
  function setupEventListeners() {
    // Guess input
    elGuessInput.addEventListener('input', (e) => {
      updateAutocomplete(e.target.value);
    });

    elGuessInput.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        navigateAutocomplete('down');
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        navigateAutocomplete('up');
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (!selectAutocompleteItem()) {
          makeGuess(elGuessInput.value);
        }
      } else if (e.key === 'Escape') {
        hideAutocomplete();
      }
    });

    // Click outside autocomplete
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.guess-input-wrapper')) {
        hideAutocomplete();
      }
    });

    // Buttons
    $('#btn-guess').addEventListener('click', () => makeGuess(elGuessInput.value));
    $('#btn-skip').addEventListener('click', () => skipGuess());
    $('#btn-next').addEventListener('click', () => {
      if (mode === 'daily') setMode('practice');
      else startPracticeRound();
    });
    $('#btn-share').addEventListener('click', () => shareResult());

    // Mode switcher
    $('#btn-mode-daily').addEventListener('click', () => setMode('daily'));
    $('#btn-mode-practice').addEventListener('click', () => setMode('practice'));

    // Header buttons
    $('#btn-help').addEventListener('click', () => openModal('modal-help'));
    $('#btn-stats').addEventListener('click', () => showStats());

    // File upload
    const dropZone = $('#drop-zone');
    const fileInput = $('#file-input');

    $('#btn-file-pick').addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', (e) => {
      if (e.target.files.length) handleFileUpload(e.target.files[0]);
    });

    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    });

    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('drag-over');
    });

    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      if (e.dataTransfer.files.length) handleFileUpload(e.dataTransfer.files[0]);
    });

    // Load different songs
    $('#btn-new-data').addEventListener('click', () => {
      localStorage.removeItem(STORAGE_KEY_SONGS);
      songs = [];
      showScreen('no-data');
    });

    // Modal close
    $$('.modal-backdrop').forEach(backdrop => {
      backdrop.addEventListener('click', closeAllModals);
    });

    $$('.modal-close').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.closest('.modal').classList.add('hidden');
      });
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeAllModals();
    });
  }

  // ===== Start =====
  document.addEventListener('DOMContentLoaded', init);
})();
