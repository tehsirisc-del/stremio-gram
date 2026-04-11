/**
 * IdentityResolver — v1.1
 *
 * Maps parsed series titles → canonical series entities (DB IDs).
 * Supports Episode Graph Overlap Matching for cross-source merging.
 *
 * Design principles for Android TV:
 *  - In-memory LRU Map (no DB round-trip hot path)
 *  - Levenshtein distance: O(m×n) but catalog is typically < 200 entries → < 1ms/call
 *  - No external dependencies — pure JS
 *  - warmCache() called ONCE before each indexing batch, not per-episode
 *
 * Requires: EpisodeParser (episode-parser.js) — for normalizeSeriesTitle()
 */

// ── Lightweight Levenshtein Distance ──────────────────────────────────────
function _levenshtein(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  if (a.length > b.length) { const tmp = a; a = b; b = tmp; }

  const m = a.length;
  const n = b.length;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);

  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev; prev = curr; curr = tmp;
  }
  return prev[n];
}

function _similarity(normA, normB) {
  if (normA === normB) return 1.0;
  if (!normA || !normB) return 0.0;
  if (normA.includes(normB) || normB.includes(normA)) {
    const shorter = Math.min(normA.length, normB.length);
    const longer  = Math.max(normA.length, normB.length);
    return Math.max(0.85, shorter / longer);
  }
  const dist   = _levenshtein(normA, normB);
  const maxLen = Math.max(normA.length, normB.length);
  return parseFloat((1 - dist / maxLen).toFixed(4));
}

// ── IdentityResolver ──────────────────────────────────────────────────────
class IdentityResolver {
  constructor(db) {
    this.db = db;
    this._cache = new Map();
    this._seriesEpisodes = new Map();

    // Tunable thresholds
    this.MERGE_THRESHOLD        = 0.85;
    this.HIGH_CONFIDENCE_BONUS  = 0.05;
    this.LOW_CONFIDENCE_PENALTY = 0.10;
    this.GRAPH_OVERLAP_BONUS    = 0.40;

    this._cacheWarmed = false;
  }

  async warmCache() {
    console.log('[IdentityResolver] Warming cache...');
    const [allCanonical, allSeasons, allEpisodes] = await Promise.all([
      this.db.getAllCanonicalSeries(),
      window.DB.db.seasons.toArray(),
      window.DB.db.episodes.toArray()
    ]);

    this._cache.clear();
    this._seriesEpisodes.clear();

    for (const cs of allCanonical) {
      this._cache.set(cs.canonical_title, cs.id);
      this._seriesEpisodes.set(cs.id, new Set());
    }

    const episodesBySeason = new Map();
    for (const ep of allEpisodes) {
      if (!ep.seasonId || ep.episodeNumber <= 0) continue;
      if (!episodesBySeason.has(ep.seasonId)) episodesBySeason.set(ep.seasonId, []);
      episodesBySeason.get(ep.seasonId).push(ep);
    }

    for (const s of allSeasons) {
      const cId = s.canonicalSeriesId || s.seriesId;
      if (!this._seriesEpisodes.has(cId)) this._seriesEpisodes.set(cId, new Set());
      const eps = episodesBySeason.get(s.id) || [];
      const graph = this._seriesEpisodes.get(cId);
      for (const ep of eps) {
        graph.add(`S${s.seasonNumber}E${ep.episodeNumber}`);
      }
    }

    this._cacheWarmed = true;
    console.log(`[IdentityResolver] Cache warmed: ${this._cache.size} series, graph built.`);
  }

  invalidate() {
    this._cacheWarmed = false;
    this._cache.clear();
    this._seriesEpisodes.clear();
  }

  async resolve(parsedTitle, sourceId, confidence = 1.0, season = null, episode = null) {
    if (!this._cacheWarmed) {
      await this.warmCache();
    }

    const normalized = window.EpisodeParser.normalizeSeriesTitle(parsedTitle);

    if (this._cache.has(normalized)) {
      const existingId = this._cache.get(normalized);
      await this.db.linkSourceToSeries(sourceId, existingId);
      if (season > 0 && episode > 0 && this._seriesEpisodes.has(existingId)) {
        this._seriesEpisodes.get(existingId).add(`S${season}E${episode}`);
      }
      return existingId;
    }

    let effectiveThreshold = this.MERGE_THRESHOLD;
    if (confidence >= 0.9) effectiveThreshold -= this.HIGH_CONFIDENCE_BONUS;
    else if (confidence < 0.5) effectiveThreshold += this.LOW_CONFIDENCE_PENALTY;

    let bestId    = null;
    let bestScore = 0;
    let overlapApplied = false;

    const checkEpisode = season > 0 && episode > 0;
    const epKey = `S${season}E${episode}`;

    for (const [cachedNorm, seriesId] of this._cache.entries()) {
      let score = _similarity(normalized, cachedNorm);
      
      if (checkEpisode && score >= 0.40 && score < effectiveThreshold) {
        const graph = this._seriesEpisodes.get(seriesId);
        if (graph && graph.has(epKey)) {
          score += this.GRAPH_OVERLAP_BONUS;
          if (score > bestScore) {
            bestScore = score;
            bestId = seriesId;
            overlapApplied = true;
          }
          continue;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestId    = seriesId;
      }
      if (score >= 0.99) break;
    }

    if (bestId !== null && bestScore >= effectiveThreshold) {
      this._cache.set(normalized, bestId);
      if (season > 0 && episode > 0) {
        if (!this._seriesEpisodes.has(bestId)) this._seriesEpisodes.set(bestId, new Set());
        this._seriesEpisodes.get(bestId).add(epKey);
      }
      await this.db.linkSourceToSeries(sourceId, bestId);
      if (overlapApplied) {
        console.log(`[IdentityResolver] MERGE via GRAPH OVERLAP "${parsedTitle}" -> canonical #${bestId} (score boosted to ${bestScore.toFixed(3)}) on ${epKey}`);
      } else {
        console.log(`[IdentityResolver] MERGE "${parsedTitle}" -> canonical #${bestId} (score=${bestScore.toFixed(3)})`);
      }
      return bestId;
    }

    if (bestId !== null) {
      console.log(`[IdentityResolver] NO MERGE: Best candidate for "${parsedTitle}" was #${bestId} with score ${bestScore.toFixed(3)}, below threshold ${effectiveThreshold.toFixed(2)}`);
    }

    const displayTitle = parsedTitle.replace(/\b\w/g, l => l.toUpperCase());
    const newId = await this.db.createCanonicalSeries(displayTitle, normalized);
    this._cache.set(normalized, newId);
    this._seriesEpisodes.set(newId, new Set());
    if (season > 0 && episode > 0) this._seriesEpisodes.get(newId).add(epKey);
    
    await this.db.linkSourceToSeries(sourceId, newId);
    console.log(`[IdentityResolver] NEW canonical series "${displayTitle}" id=${newId}`);
    return newId;
  }

  async runAddons(canonicalSeriesId, displayTitle) {
    return;
  }
}

window.IdentityResolver = IdentityResolver;
