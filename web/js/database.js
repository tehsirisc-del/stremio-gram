/**
 * Dexie.js Database — Client-side replacement for SQLite
 * Same schema as the original server's database.js
 */

const db = new Dexie('StreamCatzDB');

db.version(2).stores({
  sources:      '++id, userId, link, name, is_single_series, photo_base64',
  series:       '++id, sourceId, title',
  seasons:      '++id, seriesId, seasonNumber',
  episodes:     '++id, seasonId, episodeNumber, messageId, channel, is_manual, is_video, is_audio',
  watchProgress:'[userId+episodeId], episodeId, is_watched, updated_at',
  favorites:    '[userId+itemType+itemId], userId, itemType, itemId',
  userSettings: 'userId'
});

// Version 3: Add seek_step
db.version(3).stores({
  userSettings: 'userId'
}).upgrade(tx => {
  return tx.userSettings.toCollection().modify(s => {
    if (s.seek_step === undefined) s.seek_step = 15;
  });
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
  await db.transaction('rw', db.sources, db.series, db.seasons, db.episodes, db.watchProgress, db.favorites, async () => {
    // Delete cascade
    const seriesList = await db.series.where('sourceId').equals(id).toArray();
    for (const ser of seriesList) {
      const seasons = await db.seasons.where('seriesId').equals(ser.id).toArray();
      for (const s of seasons) {
        const epIds = (await db.episodes.where('seasonId').equals(s.id).toArray()).map(e => e.id);
        for (const epId of epIds) {
          await db.watchProgress.where('episodeId').equals(epId).delete();
          await db.favorites.where('[userId+itemType+itemId]').anyOf(
            [[null, 'episode', epId]]
          ).delete().catch(() => {});
          await db.favorites.filter(f => f.itemType === 'episode' && f.itemId === epId).delete();
        }
        await db.episodes.where('seasonId').equals(s.id).delete();
      }
      await db.seasons.where('seriesId').equals(ser.id).delete();
      await db.favorites.filter(f => f.itemType === 'series' && f.itemId === ser.id).delete();
    }
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

// ── Series ────────────────────────────────────────────────────────────

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

async function getAllSeries(userId) {
  const sources = await db.sources.where('userId').equals(userId).toArray();
  const sourceMap = new Map(sources.map(s => [s.id, s]));
  const allSeries = await db.series.filter(s => sourceMap.has(s.sourceId)).toArray();
  return allSeries.map(s => {
    const src = sourceMap.get(s.sourceId);
    return {
      ...s,
      title: src.is_single_series === 1 ? src.name : s.title,
      source_photo: src.photo_base64 || null,
      is_favorite: false
    };
  }).sort((a, b) => a.title.localeCompare(b.title));
}

async function getSeriesById(id) {
  const s = await db.series.get(id);
  if (!s) return null;
  const src = await db.sources.get(s.sourceId);
  return {
    ...s,
    title: src && src.is_single_series === 1 ? src.name : s.title,
    source_photo: src ? src.photo_base64 : null,
    is_favorite: false
  };
}

// ── Seasons ────────────────────────────────────────────────────────────

async function getOrCreateSeason(seriesId, seasonNumber) {
  let row = await db.seasons.where({ seriesId, seasonNumber }).first();
  if (!row) {
    const id = await db.seasons.add({ seriesId, seasonNumber });
    return id;
  }
  return row.id;
}

async function getSeasonsBySeriesId(seriesId) {
  const seasons = await db.seasons.where('seriesId').equals(seriesId).toArray();
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
      is_manual: 0, original_season_id: seasonId, original_episode_number: episodeNumber
    });
  } else if (!existing.is_manual) {
    await db.episodes.update(existing.id, {
      seasonId, episodeNumber, title: data.title, duration: data.duration,
      size: data.size, file_name: data.file_name, mime_type: data.mime_type,
      is_video: data.is_video ? 1 : 0, is_audio: data.is_audio ? 1 : 0,
      original_season_id: seasonId, original_episode_number: episodeNumber
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
    const series = await db.series.get(season.seriesId);
    if (!series) continue;
    const src = await db.sources.get(series.sourceId);
    if (!src) continue;
    result.push({
      ...ep,
      season_number: season.seasonNumber,
      series_id: series.id,
      series_title: src.is_single_series === 1 ? src.name : series.title,
      source_photo: src.photo_base64,
      progress_seconds: p.progress_seconds,
      progress_duration: p.duration, // Priority: discovered real duration from player
      is_watched: p.is_watched
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

  const unrecognized = (await db.episodes.where('seasonId').equals(seasonId)
    .filter(e => !e.is_manual).toArray())
    .sort((a, b) => a.messageId - b.messageId);

  if (unrecognized.length === 0) return { assigned: 0 };

  const knownEpisodes = await db.episodes
    .filter(e => {
      return e.is_manual === 0 || e.is_manual === undefined;
    }).toArray();

  // Get series id from season
  const allSeasonsForSeries = await db.seasons.where('seriesId').equals(season.seriesId).toArray();
  const nonZeroSeasonIds = new Set(allSeasonsForSeries.filter(s => s.seasonNumber !== 0).map(s => s.id));

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

    const newSeasonId = await getOrCreateSeason(season.seriesId, seasonNumber);
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

  const allSeasonsForSeries = await db.seasons.where('seriesId').equals(season.seriesId).toArray();
  const nonZeroSeasonIds = new Set(allSeasonsForSeries.filter(s => s.seasonNumber !== 0).map(s => s.id));

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

  const newSeasonId = await getOrCreateSeason(season.seriesId, seasonNumber);
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
  addSource, getSources, getSourceById, getSourceByLink, deleteSource, updateSourcePhoto, setSourcesForUser,
  getOrCreateSeries, getAllSeries, getSeriesById,
  getOrCreateSeason, getSeasonsBySeriesId,
  upsertEpisode, getEpisodesBySeasonId, getIndexedMessageIds,
  assignEpisode, resetEpisodeAssignment, autoSortSeason, autoSortEpisode,
  getUserSettings, updateUserSettings,
  updateProgress, getAllProgress, deleteProgress, getContinueWatching,
  addFavorite, removeFavorite, getFavorites, getFavoritesDetails,
  getSyncPayload, clearAllData
};
