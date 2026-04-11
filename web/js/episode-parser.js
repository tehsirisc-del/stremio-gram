/**
 * EpisodeParserPipeline — v1.0
 *
 * Shared, pure-function parser that converts raw Telegram file names
 * into structured episode metadata WITH a confidence score.
 *
 * No side effects. No DB access. No global state.
 * Used by both the Android TV client indexer and the Node.js server indexer.
 *
 * Output format:
 *   { seriesTitle: string, season: number, episode: number,
 *     confidence: number (0.0–1.0), patternUsed: string }
 */

// ── Stage 1: Input Normalizer ──────────────────────────────────────────────
// Strips noise tokens so pattern matching has the cleanest possible input.
// Optimized for Android TV: no heavy regex lookaheads, no backtracking risk.

function _normalizeInput(raw) {
  if (!raw || typeof raw !== 'string') return '';

  let t = raw;

  // Strip file extension (.mkv, .mp4, .avi, .m4v, etc.)
  t = t.replace(/\.[a-zA-Z0-9]{2,4}$/, '');

  // Strip technical quality/codec tokens that appear after real title info
  // Written as simple alternations — fast on V8
  t = t.replace(
    /\b(4k|2160p|1080p|720p|480p|360p|x264|x265|h264|h265|h\.264|h\.265|hevc|avc|aac|ac3|dts|mp3|flac|bluray|blu-ray|bdrip|brrip|webrip|web-dl|webdl|hdtv|hdrip|dvdrip|dvdscr|proper|repack|extended|theatrical|directors\.cut|unrated)\b/gi,
    ''
  );

  // Strip bracketed release group tags: [GROUP], (YIFY), {tag}
  t = t.replace(/[\[\(\{][^\]\)\}]{1,25}[\]\)\}]/g, '');

  // Strip trailing year in parens: " (2023)" or " [2021]"
  t = t.replace(/[\[\(]\s*(?:19|20)\d{2}\s*[\]\)]/g, '');

  // Normalize separators: dots and underscores → spaces
  // IMPORTANT: do this AFTER stripping brackets, so "S01.E05" becomes "S01 E05"
  t = t.replace(/[._]/g, ' ');

  // Collapse runs of spaces/hyphens
  t = t.replace(/\s*-{2,}\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();

  return t;
}

// ── Stage 2: Multi-Pattern Detector ───────────────────────────────────────
// Tries patterns from highest to lowest confidence.
// Each pattern returns { seriesTitle, season, episode, patternName } or null.

const _FULL_PATTERNS = [

  // ① S01E01 / s1e1 / S01.E01 / S01 E01 / Season 1 Episode 1 / עונה 1 פרק 1
  {
    name: 'SxEy',
    score: 0.95,
    re: /(.*?)(?:season|עונה|s)\s*[-.]?\s*(\d+)\s*[-.]?\s*(?:episode|פרק|פ|e|ep|ep\.)\s*[-.]?\s*(\d+)(.*)/i,
  },

  // ② 01x01 / 1x01 (NxN format)
  {
    name: 'NxN',
    score: 0.90,
    re: /(.*?)(?:^|\s|[-_]|–)(\d{1,2})\s*x\s*(\d{1,3})(?:\s|[-_]|$)(.*)/i,
  },

  // ③ Hebrew: ע01 פ01 (עונה / פרק abbreviations)
  {
    name: 'HebrewFull',
    score: 0.90,
    re: /(.*?)(?:ע)\s*[-.]?\s*(\d+)\s*[-.]?\s*(?:פ)\s*[-.]?\s*(\d+)(.*)/i,
  },

  // ④ "Season 2 - 05" or "Season 2, 05" (word + number + bare number)
  {
    name: 'SeasonWord',
    score: 0.78,
    re: /(.*?)(?:season|עונה)\s+(\d+)\s*[-,]?\s+(\d+)(.*)/i,
  },

  // ⑤ High-Accuracy Embedded Season: "נמלטים3 פרק 4" or "PrisonBreak2 Ep 5"
  // Catches numeric suffix on the series name word.
  {
    name: 'SeriesSeasonNum',
    score: 0.88,
    re: /^(.*?[a-zA-Z\u05d0-\u05ea]+)\s*(\d{1,2})\s+(?:episode|ep\.?|פרק)\s*[-.]?\s*(\d+)(.*)/i,
  },
];

const _EP_ONLY_PATTERNS = [

  // ⑤ "Episode 5" / "Ep.5" / "ep 5" / "פרק 5"
  {
    name: 'EpOnly',
    score: 0.60,
    re: /(.*?)(?:episode|ep\.?|פרק)\s*[-.]?\s*(\d+)(.*)/i,
  },

  // ⑥ Trailing bare number: "Show Name 05" — lowest confidence, ambiguous
  {
    name: 'TrailingNum',
    score: 0.35,
    re: /^(.+?)\s+(\d{1,3})\s*$/,
  },
];

function _detectPattern(normalizedTitle) {
  // Try full season+episode patterns first
  for (const { name, score, re } of _FULL_PATTERNS) {
    const m = normalizedTitle.match(re);
    if (m) {
      // For SeriesSeasonNum, we need to handle group order differently
      const isSeriesSeasonNum = (name === 'SeriesSeasonNum');
      return {
        rawSeriesTitle: m[1],
        season: parseInt(isSeriesSeasonNum ? m[2] : m[2], 10),
        episode: parseInt(isSeriesSeasonNum ? m[3] : m[3], 10),
        patternName: name,
        baseScore: score,
      };
    }
  }

  // Try episode-only patterns (season defaults to 1, unless embedded)
  for (const { name, score, re } of _EP_ONLY_PATTERNS) {
    const m = normalizedTitle.match(re);
    if (m) {
      let rawTitle = m[1];
      let season = 1;
      
      // Look for embedded numeric season suffix (e.g. "נמלטים3", "Series 2")
      // Ensures there is at least one letter before the digits to prevent edge cases.
      const embeddedMatch = rawTitle.match(/^(.*?[a-zA-Z\u05d0-\u05ea])\s*(\d{1,2})\s*$/);
      if (embeddedMatch) {
         rawTitle = embeddedMatch[1];
         season = parseInt(embeddedMatch[2], 10);
      }

      return {
        rawSeriesTitle: rawTitle,
        season: season,
        episode: parseInt(m[2], 10),
        patternName: name + (embeddedMatch ? ' (EmbeddedSeason)' : ''),
        baseScore: score,
      };
    }
  }

  return null;
}

// ── Stage 3: Title Cleaner ─────────────────────────────────────────────────
// Cleans the raw series title extracted by the regex group.

function _cleanTitle(raw) {
  if (!raw) return '';
  return raw
    .replace(/[-_.\s]+$/, '')          // Strip trailing separators
    .replace(/[-_.\s]+/g, ' ')         // Normalize internal separators
    .trim()
    .replace(/\b\w/g, l => l.toUpperCase()); // Title Case
}

// ── Stage 4: Confidence Scorer ─────────────────────────────────────────────
// Fine-tunes the base pattern score with heuristics.

function _scoreConfidence(detected) {
  let score = detected.baseScore;

  const title = (_cleanTitle(detected.rawSeriesTitle) || '').trim();

  // Bonus: title has meaningful length (≥ 3 chars, not just punctuation)
  if (title.length >= 3) score = Math.min(1.0, score + 0.03);

  // Penalty: suspiciously short title (e.g. "S" or "E") — likely regex false-positive
  if (title.length < 2) score *= 0.5;

  // Penalty: synthetic season 0 placeholder
  if (detected.season === 0) score *= 0.5;

  // Penalty: episode number is implausibly large (> 999)
  if (detected.episode > 999) score *= 0.6;

  return parseFloat(Math.min(1.0, score).toFixed(2));
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * parseEpisode(rawFileName, captionText, [fallback])
 *
 * Main entry point. Pass the raw fileName from a Telegram document attribute
 * and the message text (caption).
 *
 * @param {string} rawFileName  - e.g. "Breaking.Bad.S01E03.720p.mkv"
 * @param {string} [captionText] - e.g. "Here is Season 1 Episode 3 of Breaking Bad!"
 * @param {object|null} fallback - Returned as-is if all patterns fail (null by default)
 * @returns {{ seriesTitle, season, episode, confidence, patternUsed } | null}
 */
function parseEpisode(rawFileName, captionText = '', fallback = null) {
  let bestResult = null;

  // Helper to process a given input string
  const processInput = (inputStr, sourceLabel) => {
    if (!inputStr) return null;
    let cleanStr = inputStr;
    // Captions can be long; take the first few lines to avoid false positives deep in description
    if (sourceLabel === 'Caption') {
      cleanStr = cleanStr.split(/\r?\n/).slice(0, 3).join(' ');
    }
    const normalized = _normalizeInput(cleanStr);
    if (!normalized) return null;
    const detected = _detectPattern(normalized);
    if (!detected) return null;

    const seriesTitle = _cleanTitle(detected.rawSeriesTitle) || 'Unknown Series';
    const confidence  = _scoreConfidence(detected);

    return {
      seriesTitle,
      season:     detected.season,
      episode:    detected.episode,
      confidence,
      patternUsed: `${detected.patternName} (${sourceLabel})`,
    };
  };

  const fileResult = processInput(rawFileName, 'Filename');
  const captionResult = processInput(captionText, 'Caption');

  if (fileResult && captionResult) {
    // Prefer filename if scores are tied, as it's usually less noisy
    bestResult = captionResult.confidence > fileResult.confidence ? captionResult : fileResult;
  } else {
    bestResult = fileResult || captionResult;
  }

  if (bestResult) {
      return bestResult;
  }

  console.warn(`[EpisodeParser] UNRECOGNIZED: No patterns matched in filename ("${rawFileName}") or caption.`);
  return fallback;
}

/**
 * normalizeSeriesTitle(title)
 *
 * Exposed utility: normalize a series title for identity comparison.
 * Strips punctuation, lowercases, collapses spaces.
 * Used by IdentityResolver — kept here so both modules share the same logic.
 *
 * @param {string} title
 * @returns {string} normalized lowercase key
 */
function normalizeSeriesTitle(title) {
  if (!title) return '';
  return title
    .toLowerCase()
    // Keep ASCII letters, digits, Hebrew characters (U+05D0–U+05EA range)
    .replace(/[^a-z0-9\u05d0-\u05ea]/g, '')
    .trim();
}

// Export for browser globals (Android TV WebView / Capacitor)
window.EpisodeParser = { parseEpisode, normalizeSeriesTitle };
