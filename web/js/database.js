/**
 * Dexie.js Database — Client-side IndexedDB layer
 * v4: Introduces canonical series identity layer for multi-source merging.
 *
 * Schema history:
 *   v2 – initial schema
 *   v3 – added seek_step to userSettings
 *   v4 – canonical_series + series_sources junction + sourceId on episodes
 *         + addon_metadata stub table
 */

const db = new Dexie('StreamCatzDB');

// ── v2: Base schema (preserved — Dexie requires all prior versions) ────────
db.version(2).stores({
  sources:       '++id, userId, link, name, is_single_series, photo_base64',
  series:        '++id, sourceId, title',
  seasons:       '++id, seriesId, seasonNumber',
  episodes:      '++id, seasonId, episodeNumber, messageId, channel, is_manual, is_video, is_audio',
  watchProgress: '[userId+episodeId], episodeId, is_watched, updated_at',
  favorites:     '[userId+itemType+itemId], userId, itemType, itemId',
  userSettings:  'userId',
});

// ── v3: seek_step ─────────────────────────────────────────────────────────
db.version(3).stores({
  userSettings: 'userId',
}).upgrade(tx => {
  return tx.userSettings.toCollection().modify(s => {
    if (s.seek_step === undefined) s.seek_step = 15;
  });
});

// ── v4: Canonical series identity layer ───────────────────────────────────
//
// New tables:
//   canonical_series  — source-independent series entity (the "truth")
//   series_sources    — junction: which sources feed into which canonical series
//   addon_metadata    — enrichment data from optional future addons (stub)
//
// Changed tables:
//   seasons           — now indexed by canonicalSeriesId (in addition to seriesId)
//   episodes          — sourceId column added for provenance tracking
//
// Migration: all existing series rows are converted to canonical_series +
//            series_sources entries. Seasons are re-linked to canonicalSeriesId.
//            All data (episodes, progress, favorites) is preserved.

db.version(4).stores({
  sources:          '++id, userId, link, name, is_single_series, photo_base64',
  // canonical_title is the normalized key (lowercase, stripped punctuation)
  canonicalSeries:  '++id, canonical_title, display_title',
  // series row still exists for legacy queries; gains canonicalSeriesId pointer
  series:           '++id, sourceId, canonicalSeriesId, title',
  // junction: many sources → one canonical series
  seriesSources:    '++id, [canonicalSeriesId+sourceId], canonicalSeriesId, sourceId',
  // seasons now indexed by canonicalSeriesId (primary hierarchy key)
  seasons:          '++id, canonicalSeriesId, seriesId, seasonNumber',
  // episodes gain sourceId for multi-source provenance
  episodes:         '++id, seasonId, episodeNumber, messageId, channel, sourceId, is_manual, is_video, is_audio',
  watchProgress:    '[userId+episodeId], episodeId, is_watched, updated_at',
  favorites:        '[userId+itemType+itemId], userId, itemType, itemId',
  userSettings:     'userId',
  // Addon metadata — isolated from all core queries, written only by addons
  addonMetadata:    '++id, canonicalSeriesId, addonName',
}).upgrade(async tx => {
  console.log('[DB Migration v4] Starting canonical series migration...');

  // Helper: same normalization as EpisodeParser.normalizeSeriesTitle
  // Redefined inline here because episode-parser.js may not be loaded during upgrade.
  const normalize = title => {
    if (!title) return '';
    return title.toLowerCase().replace(/[^a-z0-9\u05d0-\u05ea]/g, '').trim();
  };

  // titleMap: normalizedTitle → canonicalSeriesId (built during this migration)
  const titleMap = new Map();

  const allSeries = await tx.series.toArray();

  for (const s of allSeries) {
    const norm = normalize(s.title || '');
    const key  = norm || String(s.id); // Fallback: use id as key if title empty

    if (!titleMap.has(key)) {
      // Create canonical entry
      const cId = await tx.canonicalSeries.add({
        canonical_title: key,
        display_title:   s.title || 'Unknown Series',
      });
      titleMap.set(key, cId);
    }

    const canonicalId = titleMap.get(key);

    // Point the existing series row at its canonical parent
    await tx.series.update(s.id, { canonicalSeriesId: canonicalId });

    // Create junction entry
    const junctionExists = await tx.seriesSources
      .where({ canonicalSeriesId: canonicalId, sourceId: s.sourceId })
      .first();
    if (!junctionExists) {
      await tx.seriesSources.add({
        canonicalSeriesId: canonicalId,
        sourceId:          s.sourceId,
      });
    }

    // Migrate seasons: add canonicalSeriesId index column
    const seasons = await tx.seasons.where('seriesId').equals(s.id).toArray();
    for (const season of seasons) {
      await tx.seasons.update(season.id, { canonicalSeriesId: canonicalId });
    }
  }

  console.log(`[DB Migration v4] Complete. ${titleMap.size} canonical series created.`);
});

// ── Sources ──────────────────────────────────────────────────────────

async function addSource(name, link, isSingleSeries, userId) {
  const existing = await db.sources.where({ userId, link }).first();
  if (existing) throw new Error('Source link already exists for this user');
  return db.sources.add({ userId, name, link, is_single_series: isSingleSeries ? 1 : 0, photo_base64: null });
}

async function getSources(userId) {
  return db.sources.where('userId').equals(userId).toArray();
}

async function getSourceById(id) {
  return db.sources.get(id);
}

async function getSourceByLink(link, userId) {
  return db.sources.where({ userId, link }).first();
}

async function deleteSource(id) {
  await db.transaction(
    'rw',
    db.sources, db.canonicalSeries, db.seriesSources, db.series,
    db.seasons, db.episodes, db.watchProgress, db.favorites,
    async () => {

    // 1. Find all series rows belonging to this source
    const seriesList = await db.series.where('sourceId').equals(id).toArray();

    // 2. Collect all canonicalSeriesIds affected by this source
    const affectedCanonicalIds = new Set(
      seriesList.map(s => s.canonicalSeriesId).filter(Boolean)
    );
    // Also check seriesSources junction directly (covers v4 new-path data)
    const junctionRows = await db.seriesSources.where('sourceId').equals(id).toArray();
    junctionRows.forEach(j => affectedCanonicalIds.add(j.canonicalSeriesId));

    // 3. For each affected canonical series: delete episodes sourced from this source.
    //    If the canonical series becomes fully orphaned (no other sources), delete it entirely.
    for (const cId of affectedCanonicalIds) {

      // Remove this source's junction entry
      await db.seriesSources
        .where({ canonicalSeriesId: cId, sourceId: id })
        .delete();

      // Count remaining sources for this canonical series
      const remainingLinks = await db.seriesSources
        .where('canonicalSeriesId').equals(cId)
        .count();

      if (remainingLinks === 0) {
        // Fully orphaned: delete all seasons + episodes + favorites
        const seasons = await db.seasons.where('canonicalSeriesId').equals(cId).toArray();
        for (const s of seasons) {
          const epIds = (await db.episodes.where('seasonId').equals(s.id).toArray()).map(e => e.id);
          for (const epId of epIds) {
            await db.watchProgress.where('episodeId').equals(epId).delete();
            await db.favorites.filter(f => f.itemType === 'episode' && f.itemId === epId).delete();
          }
          await db.episodes.where('seasonId').equals(s.id).delete();
        }
        await db.seasons.where('canonicalSeriesId').equals(cId).delete();
        await db.favorites.filter(f => f.itemType === 'series' && f.itemId === cId).delete();
        await db.canonicalSeries.delete(cId);
      } else {
        // Other sources still exist: only delete episodes from this source
        const seasons = await db.seasons.where('canonicalSeriesId').equals(cId).toArray();
        for (const s of seasons) {
          const epIds = (await db.episodes
            .where('seasonId').equals(s.id)
            .filter(e => e.sourceId === id)
            .toArray()).map(e => e.id);
          for (const epId of epIds) {
            await db.watchProgress.where('episodeId').equals(epId).delete();
            await db.favorites.filter(f => f.itemType === 'episode' && f.itemId === epId).delete();
            await db.episodes.delete(epId);
          }
        }
      }
    }

    // 4. Delete legacy series rows and source record
    await db.series.where('sourceId').equals(id).delete();
    await db.sources.delete(id);
  });
}

async function updateSourcePhoto(id, photoBase64) {
  await db.sources.update(id, { photo_base64: photoBase64 });
}

async function setSourcesForUser(userId, sourcesList) {
  const existing = await db.sources.where('userId').equals(userId).toArray();
  const existingLinks = new Set(existing.map(s => s.link));
  const newLinks = new Set(sourcesList.map(s => s.link));

  // Delete removed sources
  for (const src of existing) {
    if (!newLinks.has(src.link)) await deleteSource(src.id);
  }

  const inserted = [];
  for (const src of sourcesList) {
    const isSingle = (src.is_single_series === 1 || src.is_single_series === true) ? 1 : 0;
    if (!existingLinks.has(src.link)) {
      const id = await db.sources.add({ userId, name: src.name, link: src.link, is_single_series: isSingle, photo_base64: null });
      inserted.push({ id, ...src });
    } else {
      const ex = existing.find(e => e.link === src.link);
      if (ex) await db.sources.update(ex.id, { name: src.name, is_single_series: isSingle });
    }
  }
  return inserted;
}

// ── Canonical Series (Identity Layer) ──────────────────────────────────────

/**
 * getAllCanonicalSeries()
 * Returns all canonical series rows — used by IdentityResolver to warm its cache.
 */
async function getAllCanonicalSeries() {
  return db.canonicalSeries.toArray();
}

/**
 * createCanonicalSeries(displayTitle, canonicalTitle)
 * Inserts a new canonical series entity and returns its ID.
 * Called only by IdentityResolver when no matching entity exists.
 */
async function createCanonicalSeries(displayTitle, canonicalTitle) {
  return db.canonicalSeries.add({
    display_title:   displayTitle,
    canonical_title: canonicalTitle,
  });
}

/**
 * linkSourceToSeries(sourceId, canonicalSeriesId)
 * Ensures a junction row exists in series_sources.
 * Idempotent — safe to call multiple times for the same pair.
 */
async function linkSourceToSeries(sourceId, canonicalSeriesId) {
  const existing = await db.seriesSources
    .where({ canonicalSeriesId, sourceId })
    .first();
  if (!existing) {
    await db.seriesSources.add({ canonicalSeriesId, sourceId });
  }
}

/**
 * getCanonicalSeriesById(id)
 * Returns a canonical series, including the best available poster photo
 * pulled from any of its linked sources.
 */
async function getCanonicalSeriesById(id) {
  const cs = await db.canonicalSeries.get(id);
  if (!cs) return null;

  // Find linked sources and pick the first one that has a photo
  const links = await db.seriesSources.where('canonicalSeriesId').equals(id).toArray();
  let photo = null;
  for (const link of links) {
    const src = await db.sources.get(link.sourceId);
    if (src && src.photo_base64) { photo = src.photo_base64; break; }
  }

  return {
    id:           cs.id,
    title:        cs.display_title,
    display_title: cs.display_title,
    canonical_title: cs.canonical_title,
    source_photo: photo,
    is_favorite:  false, // Caller populates this
  };
}

// ── Series (Legacy + Canonical Bridge) ─────────────────────────────────────
// getOrCreateSeries is still used internally by older code paths (e.g. migration).
// New indexer code goes through IdentityResolver → getOrCreateSeason directly.

async function getOrCreateSeries(sourceId, title) {
  const src = await db.sources.get(sourceId);
  if (src && src.is_single_series === 1) {
    let row = await db.series.where('sourceId').equals(sourceId).first();
    if (row) return row.id;
    return db.series.add({ sourceId, title: src.name });
  }
  let row = await db.series.where({ sourceId }).filter(s => s.title === title).first();
  if (!row) {
    const id = await db.series.add({ sourceId, title });
    return id;
  }
  return row.id;
}

/**
 * getAllSeries(userId)
 * Returns all canonical series that have at least one source belonging to this user.
 * This is the primary catalog query — now source-independent.
 */
async function getAllSeries(userId) {
  // 1. Get all sources for this user
  const sources = await db.sources.where('userId').equals(userId).toArray();
  if (sources.length === 0) return [];
  const sourceIds = new Set(sources.map(s => s.id));

  // 2. Find all canonical series linked to these sources
  const links = await db.seriesSources
    .filter(l => sourceIds.has(l.sourceId))
    .toArray();
  const canonicalIds = [...new Set(links.map(l => l.canonicalSeriesId))];

  // 3. Build result list
  const result = [];
  for (const cId of canonicalIds) {
    // Check if this series has any episodes before adding to catalog
    const seasons = await db.seasons.where('canonicalSeriesId').equals(cId).toArray();
    let totalEpisodes = 0;
    for (const s of seasons) {
      totalEpisodes += await db.episodes.where('seasonId').equals(s.id).count();
    }
    
    if (totalEpisodes > 0) {
      const cs = await getCanonicalSeriesById(cId);
      if (cs) result.push(cs);
    }
  }

  return result.sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * getSeriesById(id)
 * Accepts EITHER a canonicalSeriesId OR a legacy series id.
 * Prefers canonical lookup for smooth migration.
 */
async function getSeriesById(id) {
  // Try canonical first (new path)
  const cs = await db.canonicalSeries.get(id);
  if (cs) return getCanonicalSeriesById(id);

  // Fallback: legacy series row
  const s = await db.series.get(id);
  if (!s) return null;
  const src = await db.sources.get(s.sourceId);
  return {
    ...s,
    title:        src && src.is_single_series === 1 ? src.name : s.title,
    source_photo: src ? src.photo_base64 : null,
    is_favorite:  false,
  };
}

// ── Seasons ────────────────────────────────────────────────────────────────

/**
 * getOrCreateSeason(canonicalSeriesId, seasonNumber)
 *
 * IMPORTANT: parameter is now canonicalSeriesId, not legacy seriesId.
 * Seasons are owned by canonical series in v4.
 *
 * Backward compat: if a row with only seriesId exists (pre-migration data),
 * we fall back to that lookup so nothing breaks during the transition.
 */
async function getOrCreateSeason(canonicalSeriesId, seasonNumber) {
  // Primary: look up by canonical ID
  let row = await db.seasons
    .where({ canonicalSeriesId, seasonNumber })
    .first();
  if (row) return row.id;

  // Backward-compat fallback: old rows use seriesId column
  // (These exist on devices that had data before the v4 migration)
  row = await db.seasons
    .where({ seriesId: canonicalSeriesId, seasonNumber })
    .first();
  if (row) {
    // Patch the row in place so future lookups hit the fast path
    await db.seasons.update(row.id, { canonicalSeriesId });
    return row.id;
  }

  // Create new season
  const id = await db.seasons.add({ canonicalSeriesId, seriesId: canonicalSeriesId, seasonNumber });
  return id;
}

/**
 * getSeasonsBySeriesId(id)
 * Accepts canonicalSeriesId (v4 path) OR legacy seriesId (fallback).
 */
async function getSeasonsBySeriesId(id) {
  // Try canonicalSeriesId index first
  let seasons = await db.seasons.where('canonicalSeriesId').equals(id).toArray();

  // Fallback: legacy seriesId column for pre-v4 rows
  if (seasons.length === 0) {
    seasons = await db.seasons.where('seriesId').equals(id).toArray();
  }

  const result = [];
  for (const s of seasons) {
    const count = await db.episodes.where('seasonId').equals(s.id).count();
    result.push({ ...s, episode_count: count });
  }
  return result.sort((a, b) => a.seasonNumber - b.seasonNumber);
}

// ── Episodes ────────────────────────────────────────────────────────────

async function upsertEpisode(seasonId, episodeNumber, data) {
  const existing = await db.episodes
    .where('messageId').equals(data.message_id)
    .filter(e => e.channel === data.channel)
    .first();

  if (!existing) {
    await db.episodes.add({
      seasonId, episodeNumber,
      title: data.title, duration: data.duration, size: data.size,
      messageId: data.message_id, channel: data.channel,
      file_name: data.file_name, mime_type: data.mime_type,
      is_video: data.is_video ? 1 : 0, is_audio: data.is_audio ? 1 : 0,
      is_manual: 0, original_season_id: seasonId, original_episode_number: episodeNumber,
      // v4: provenance tracking — which source provided this episode
      sourceId: data.sourceId || null,
    });
  } else if (!existing.is_manual) {
    await db.episodes.update(existing.id, {
      seasonId, episodeNumber, title: data.title, duration: data.duration,
      size: data.size, file_name: data.file_name, mime_type: data.mime_type,
      is_video: data.is_video ? 1 : 0, is_audio: data.is_audio ? 1 : 0,
      original_season_id: seasonId, original_episode_number: episodeNumber,
      sourceId: data.sourceId || existing.sourceId || null,
    });
  }
}

async function getEpisodesBySeasonId(seasonId, userId) {
  const episodes = await db.episodes.where('seasonId').equals(seasonId).toArray();
  episodes.sort((a, b) => a.episodeNumber - b.episodeNumber);

  if (userId) {
    const favSet = new Set(
      (await db.favorites.where({ userId, itemType: 'episode' }).toArray()).map(f => f.itemId)
    );
    const progMap = new Map(
      (await db.watchProgress.where({ userId }).toArray()).map(p => [p.episodeId, p])
    );
    episodes.forEach(e => {
      e.is_favorite = favSet.has(e.id);
      const prog = progMap.get(e.id);
      if (prog) {
        e.progress_seconds = prog.progress_seconds;
        // CRITICAL: Map stored progress duration to e.progress_duration (separate from indexed duration)
        // e.duration = the indexed duration from Telegram metadata (may be 0 for MKV)
        // e.progress_duration = the real duration saved when we last exited the player
        e.progress_duration = prog.duration;
        e.is_watched = prog.is_watched;
      }
    });
  }
  return episodes;
}

async function getIndexedMessageIds(channel) {
  return (await db.episodes.where('channel').equals(channel).toArray()).map(e => e.messageId);
}

// ── Settings ─────────────────────────────────────────────────────────

async function getUserSettings(userId) {
  let s = await db.userSettings.get(userId);
  if (!s) {
    s = { userId, auto_next_enabled: 1, auto_next_countdown: 15, ui_zoom: 100, seek_step: 15 };
    await db.userSettings.put(s);
  }
  return s;
}

async function updateUserSettings(userId, autoNextEnabled, autoNextCountdown, uiZoom, seekStep) {
  await db.userSettings.put({ 
    userId, 
    auto_next_enabled: autoNextEnabled ? 1 : 0, 
    auto_next_countdown: autoNextCountdown,
    ui_zoom: uiZoom || 100,
    seek_step: seekStep || 15
  });
}

// ── Progress ──────────────────────────────────────────────────────────

async function updateProgress(userId, episodeId, progressSeconds, duration, isWatched) {
  await db.watchProgress.put({
    userId, episodeId,
    progress_seconds: progressSeconds, duration,
    is_watched: isWatched ? 1 : 0,
    updated_at: Date.now()
  });
}

async function getAllProgress(userId) {
  return db.watchProgress.where({ userId }).toArray();
}

async function deleteProgress(userId, episodeId) {
  await db.watchProgress.where({ userId, episodeId }).delete();
}

async function getContinueWatching(userId) {
  const progList = (await db.watchProgress.where({ userId }).toArray())
    .filter(p => !p.is_watched && p.progress_seconds > 5)
    .sort((a, b) => b.updated_at - a.updated_at);

  const result = [];
  for (const p of progList) {
    const ep = await db.episodes.get(p.episodeId);
    if (!ep) continue;
    const season = await db.seasons.get(ep.seasonId);
    if (!season) continue;

    // v4 path: resolve series title via canonical series
    const canonicalId = season.canonicalSeriesId || season.seriesId;
    let seriesTitle = 'Unknown';
    let seriesId    = canonicalId;
    let sourcePhoto = null;

    const cs = canonicalId ? await db.canonicalSeries.get(canonicalId) : null;
    if (cs) {
      seriesTitle = cs.display_title;
      seriesId    = cs.id;
      // Pick best photo from any linked source
      const links = await db.seriesSources.where('canonicalSeriesId').equals(cs.id).toArray();
      for (const link of links) {
        const src = await db.sources.get(link.sourceId);
        if (src?.photo_base64) { sourcePhoto = src.photo_base64; break; }
      }
    } else {
      // Fallback: legacy series row (pre-migration data)
      const legacySeries = await db.series.get(season.seriesId);
      if (legacySeries) {
        const src = await db.sources.get(legacySeries.sourceId);
        seriesTitle = src?.is_single_series === 1 ? src.name : legacySeries.title;
        sourcePhoto = src?.photo_base64 || null;
        seriesId    = legacySeries.id;
      }
    }

    result.push({
      ...ep,
      season_number:     season.seasonNumber,
      series_id:         seriesId,
      series_title:      seriesTitle,
      source_photo:      sourcePhoto,
      progress_seconds:  p.progress_seconds,
      progress_duration: p.duration,
      is_watched:        p.is_watched,
    });
  }
  return result;
}

// ── Favorites ─────────────────────────────────────────────────────────

async function addFavorite(userId, itemType, itemId) {
  await db.favorites.put({ userId, itemType, itemId, added_at: Date.now() });
}

async function removeFavorite(userId, itemType, itemId) {
  await db.favorites.where({ userId, itemType, itemId }).delete();
}

async function getFavorites(userId) {
  return db.favorites.where({ userId }).reverse().sortBy('added_at');
}

async function getFavoritesDetails(userId) {
  const favs = await getFavorites(userId);
  const seriesIds = favs.filter(f => f.itemType === 'series').map(f => f.itemId);
  const episodeIds = favs.filter(f => f.itemType === 'episode').map(f => f.itemId);

  let seriesList = [];
  for (const id of seriesIds) {
    const s = await getSeriesById(id);
    if (s) { s.is_favorite = true; seriesList.push(s); }
  }

  let episodesList = [];
  for (const id of episodeIds) {
    const ep = await db.episodes.get(id);
    if (!ep) continue;
    const season = await db.seasons.get(ep.seasonId);
    const series = season ? await db.series.get(season.seriesId) : null;
    const src = series ? await db.sources.get(series.sourceId) : null;
    episodesList.push({
      ...ep,
      season_number: season?.seasonNumber,
      series_id: series?.id,
      series_title: src ? (src.is_single_series === 1 ? src.name : series.title) : '',
      is_favorite: true
    });
  }

  return { series: seriesList, episodes: episodesList };
}

// ── Episode Assignment ────────────────────────────────────────────────

async function assignEpisode(episodeId, seriesId, seasonNumber, episodeNumber) {
  const newSeasonId = await getOrCreateSeason(seriesId, seasonNumber);
  await db.episodes.update(episodeId, {
    seasonId: newSeasonId,
    episodeNumber,
    is_manual: 1
  });
}

async function resetEpisodeAssignment(episodeId) {
  const ep = await db.episodes.get(episodeId);
  if (!ep) return;
  await db.episodes.update(episodeId, {
    seasonId: ep.original_season_id || ep.seasonId,
    episodeNumber: ep.original_episode_number || 0,
    is_manual: 0
  });
}

async function autoSortSeason(seasonId) {
  const season = await db.seasons.get(seasonId);
  if (!season) return { assigned: 0 };

  // v4: use canonicalSeriesId; fallback to legacy seriesId
  const canonicalId = season.canonicalSeriesId || season.seriesId;

  const unrecognized = (await db.episodes.where('seasonId').equals(seasonId)
    .filter(e => !e.is_manual).toArray())
    .sort((a, b) => a.messageId - b.messageId);

  if (unrecognized.length === 0) return { assigned: 0 };

  // Find all non-zero seasons for this canonical series
  let allSeasonsForSeries = await db.seasons.where('canonicalSeriesId').equals(canonicalId).toArray();
  if (allSeasonsForSeries.length === 0) {
    allSeasonsForSeries = await db.seasons.where('seriesId').equals(canonicalId).toArray();
  }
  const nonZeroSeasonIds = new Set(
    allSeasonsForSeries.filter(s => s.seasonNumber !== 0).map(s => s.id)
  );

  const knownInSeries = (await db.episodes.filter(e => nonZeroSeasonIds.has(e.seasonId)).toArray())
    .map(async e => {
      const s = await db.seasons.get(e.seasonId);
      return { ...e, season_number: s?.seasonNumber };
    });
  const knownWithSeason = await Promise.all(knownInSeries);
  const sortedKnown = knownWithSeason.sort((a, b) => a.messageId - b.messageId);

  const insertedSlots = {};
  let assigned = 0;

  for (const ep of unrecognized) {
    let lowerNeighbour = null, upperNeighbour = null;
    for (const k of sortedKnown) {
      if (k.messageId < ep.messageId) lowerNeighbour = k;
      if (k.messageId > ep.messageId && !upperNeighbour) upperNeighbour = k;
    }
    if (!lowerNeighbour && !upperNeighbour) continue;

    let seasonNumber, episodeNumber;
    const allKnown = [...sortedKnown,
      ...Object.entries(insertedSlots).flatMap(([sn, nums]) =>
        nums.map(num => ({ season_number: parseInt(sn), episodeNumber: num, messageId: -1 }))
      )
    ];

    if (lowerNeighbour && upperNeighbour && lowerNeighbour.season_number === upperNeighbour.season_number) {
      seasonNumber = lowerNeighbour.season_number;
      const occupied = new Set(allKnown.filter(k => k.season_number === seasonNumber).map(k => k.episodeNumber));
      let slot = lowerNeighbour.episodeNumber + 1;
      while (occupied.has(slot) && slot < upperNeighbour.episodeNumber) slot++;
      episodeNumber = slot;
    } else if (lowerNeighbour) {
      seasonNumber = lowerNeighbour.season_number;
      const occupied = new Set(allKnown.filter(k => k.season_number === seasonNumber).map(k => k.episodeNumber));
      let slot = lowerNeighbour.episodeNumber + 1;
      while (occupied.has(slot)) slot++;
      episodeNumber = slot;
    } else {
      seasonNumber = upperNeighbour.season_number;
      const occupied = new Set(allKnown.filter(k => k.season_number === seasonNumber).map(k => k.episodeNumber));
      let slot = Math.max(1, upperNeighbour.episodeNumber - 1);
      while (occupied.has(slot) && slot > 0) slot--;
      if (occupied.has(slot)) slot = upperNeighbour.episodeNumber + 1;
      episodeNumber = slot;
    }

    if (!insertedSlots[seasonNumber]) insertedSlots[seasonNumber] = [];
    insertedSlots[seasonNumber].push(episodeNumber);

    // getOrCreateSeason now accepts canonicalSeriesId
    const newSeasonId = await getOrCreateSeason(canonicalId, seasonNumber);
    await db.episodes.update(ep.id, { seasonId: newSeasonId, episodeNumber, is_manual: 1 });
    assigned++;
  }
  return { assigned };
}

async function autoSortEpisode(episodeId) {
  const ep = await db.episodes.get(episodeId);
  if (!ep || ep.is_manual) return false;

  const season = await db.seasons.get(ep.seasonId);
  if (!season) return false;

  // v4: use canonicalSeriesId; fallback to legacy seriesId
  const canonicalId = season.canonicalSeriesId || season.seriesId;

  let allSeasonsForSeries = await db.seasons.where('canonicalSeriesId').equals(canonicalId).toArray();
  if (allSeasonsForSeries.length === 0) {
    allSeasonsForSeries = await db.seasons.where('seriesId').equals(canonicalId).toArray();
  }
  const nonZeroSeasonIds = new Set(
    allSeasonsForSeries.filter(s => s.seasonNumber !== 0).map(s => s.id)
  );

  const knownInSeries = (await db.episodes.filter(e => nonZeroSeasonIds.has(e.seasonId)).toArray())
    .map(async e => {
      const s = await db.seasons.get(e.seasonId);
      return { ...e, season_number: s?.seasonNumber };
    });
  const knownWithSeason = await Promise.all(knownInSeries);
  const sortedKnown = knownWithSeason.sort((a, b) => a.messageId - b.messageId);

  let lowerNeighbour = null, upperNeighbour = null;
  for (const k of sortedKnown) {
    if (k.messageId < ep.messageId) lowerNeighbour = k;
    if (k.messageId > ep.messageId && !upperNeighbour) upperNeighbour = k;
  }
  if (!lowerNeighbour && !upperNeighbour) return false;

  let seasonNumber, episodeNumber;

  if (lowerNeighbour && upperNeighbour && lowerNeighbour.season_number === upperNeighbour.season_number) {
    seasonNumber = lowerNeighbour.season_number;
    const occupied = new Set(sortedKnown.filter(k => k.season_number === seasonNumber).map(k => k.episodeNumber));
    let slot = lowerNeighbour.episodeNumber + 1;
    while (occupied.has(slot) && slot < upperNeighbour.episodeNumber) slot++;
    episodeNumber = slot;
  } else if (lowerNeighbour) {
    seasonNumber = lowerNeighbour.season_number;
    const occupied = new Set(sortedKnown.filter(k => k.season_number === seasonNumber).map(k => k.episodeNumber));
    let slot = lowerNeighbour.episodeNumber + 1;
    while (occupied.has(slot)) slot++;
    episodeNumber = slot;
  } else {
    seasonNumber = upperNeighbour.season_number;
    const occupied = new Set(sortedKnown.filter(k => k.season_number === seasonNumber).map(k => k.episodeNumber));
    let slot = Math.max(1, upperNeighbour.episodeNumber - 1);
    while (occupied.has(slot) && slot > 0) slot--;
    if (occupied.has(slot)) slot = upperNeighbour.episodeNumber + 1;
    episodeNumber = slot;
  }

  const newSeasonId = await getOrCreateSeason(canonicalId, seasonNumber);
  await db.episodes.update(ep.id, { seasonId: newSeasonId, episodeNumber, is_manual: 1 });
  return true;
}

// ── Sync (Telegram channel) ───────────────────────────────────────────

async function getSyncPayload(userId) {
  const sources = await getSources(userId);
  return sources.map(s => ({ name: s.name, link: s.link, is_single_series: s.is_single_series }));
}

async function clearAllData() {
  await db.delete();
  return db.open();
}

// Export all
window.DB = {
  db,

  // Sources
  addSource, getSources, getSourceById, getSourceByLink, deleteSource, updateSourcePhoto, setSourcesForUser,

  // Canonical Series (identity layer — used by IdentityResolver)
  getAllCanonicalSeries, createCanonicalSeries, linkSourceToSeries, getCanonicalSeriesById,

  // Series (legacy bridge + catalog queries)
  getOrCreateSeries, getAllSeries, getSeriesById,

  // Seasons
  getOrCreateSeason, getSeasonsBySeriesId,

  // Episodes
  upsertEpisode, getEpisodesBySeasonId, getIndexedMessageIds,
  assignEpisode, resetEpisodeAssignment, autoSortSeason, autoSortEpisode,

  // Settings, Progress, Favorites
  getUserSettings, updateUserSettings,
  updateProgress, getAllProgress, deleteProgress, getContinueWatching,
  addFavorite, removeFavorite, getFavorites, getFavoritesDetails,

  // Sync
  getSyncPayload, clearAllData,
};
