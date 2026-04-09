require('dotenv').config();
const express = require('express');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const bigInt = require('big-integer');
const path = require('path');
const db = require('./database');
const Indexer = require('./indexer');

// Run database maintenance once at startup
db.runMaintenance();

const app = express();
const PORT = process.env.PORT || 3000;

const apiId = parseInt(process.env.TG_API_ID) || 2040;
const apiHash = process.env.TG_API_HASH || 'b18441a1ff607e10a989891a5462e627';
const sessionString = process.env.TG_SESSION || '';

let qrAuthLink = null;
let qrAuthed = !!sessionString;
let qrAuthError = null;
let appUserId = null;

// Protect static routes
app.get(['/', '/index.html'], (req, res, next) => {
  if (!qrAuthed) return res.redirect('/login.html');
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Share Link SSE ─────────────────────────────────────────────────────────
const shareListeners = new Map(); // token => res

app.get('/api/share/listen', (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).send('No token');
  
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  shareListeners.set(token, res);
  
  req.on('close', () => {
    shareListeners.delete(token);
  });
});

app.post('/api/share/submit', (req, res) => {
  const { token, link } = req.body || {};
  if (!shareListeners.has(token)) {
    return res.status(404).json({ error: 'Desktop session not found or expired.' });
  }
  
  const desktopRes = shareListeners.get(token);
  desktopRes.write(`data: ${JSON.stringify({ link })}\n\n`);
  
  res.json({ success: true });
});

// ─── Phone Auth Flow (Fallback) ─────────────────────────────────────────────
let phoneCodeResolve = null;
let phonePassResolve = null;
let phoneAuthState = 'idle'; // working, wait_code, wait_password, success, error
let phoneAuthError = null;

app.post('/api/auth/phone/start', (req, res) => {
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'Phone number required' });
  
  phoneAuthState = 'working';
  phoneAuthError = null;

  client.start({
    phoneNumber: async () => phone,
    password: async () => {
      phoneAuthState = 'wait_password';
      return new Promise(r => { phonePassResolve = r; });
    },
    phoneCode: async () => {
      phoneAuthState = 'wait_code';
      return new Promise(r => { phoneCodeResolve = r; });
    },
    onError: (err) => {
      console.error('Phone Auth Error:', err.message);
      phoneAuthError = err.message;
    }
  }).then(async () => {
    qrAuthed = true;
    phoneAuthState = 'success';
    try { const me = await client.getMe(); appUserId = Number(me.id); await syncSourcesFromTelegram(appUserId); } catch (e) {}
    
    const newSession = client.session.save();
    const fs = require('fs');
    let envConf = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf-8') : '';
    if (envConf.includes('TG_SESSION=')) envConf = envConf.replace(/TG_SESSION=.*/g, `TG_SESSION="${newSession}"`);
    else envConf += `\nTG_SESSION="${newSession}"\n`;
    fs.writeFileSync('.env', envConf.trim() + '\n');
    
    console.log('Phone Auth successful. Pre-fetching dialogs...');
    client.getDialogs({ limit: 50 });
  }).catch(e => {
    phoneAuthState = 'error';
    phoneAuthError = e.message;
  });

  res.json({ success: true });
});

app.post('/api/auth/phone/submit', (req, res) => {
  const { code, password } = req.body || {};
  phoneAuthError = null; // reset before attempting
  
  if (code && phoneAuthState === 'wait_code' && phoneCodeResolve) {
    phoneAuthState = 'working';
    phoneCodeResolve(code);
    phoneCodeResolve = null;
  } else if (password && phoneAuthState === 'wait_password' && phonePassResolve) {
    phoneAuthState = 'working';
    phonePassResolve(password);
    phonePassResolve = null;
  }
  res.json({ success: true });
});

app.get('/api/auth/phone/status', (req, res) => {
  res.json({ state: phoneAuthState, error: phoneAuthError, authed: qrAuthed });
});

// ─── QR Auth State ─────────────────────────────────────────────────────────
app.get('/api/auth/qr', (req, res) => {
  if (qrAuthed) return res.json({ authed: true });
  if (qrAuthError) return res.status(500).json({ error: qrAuthError });
  if (!qrAuthLink) return res.json({ pending: true });
  res.json({ link: qrAuthLink });
});

app.get('/api/ip', (req, res) => {
  const os = require('os');
  const nets = os.networkInterfaces();
  let localIp = 'localhost';
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        localIp = net.address;
        // Keep looking or just return the first external IPv4
      }
    }
  }
  res.json({ ip: localIp, port: PORT });
});

// ─── Telegram Client ────────────────────────────────────────────────────────
let stringSession;
try {
  stringSession = new StringSession(sessionString);
} catch (e) {
  console.error('[Session Error] TG_SESSION in .env is invalid. Starting fresh...');
  stringSession = new StringSession('');
  qrAuthed = false; // Force re-auth
}

const client = new TelegramClient(stringSession, apiId, apiHash, {
  connectionRetries: 10,
  retryDelay: 1000,
  autoReconnect: true,
  downloadRetries: 5,
});

const { LRUCache } = require('lru-cache');

// ─── Message metadata cache ─────────────────────────────────────────────────
const messageCache = new LRUCache({
  max: 500,              // Keep metadata for 500 episodes
  ttl: 1000 * 60 * 60,  // 1-hour TTL
});

async function getMediaMeta(channel, messageId) {
  const cacheKey = `${channel}_${messageId}`;
  if (messageCache.has(cacheKey)) return messageCache.get(cacheKey);

  // Private channels passed as "-100XXXX" string → need bigInt for GramJS
  const channelArg = (typeof channel === 'string' && channel.startsWith('-100'))
    ? bigInt(channel)
    : channel;

  const messages = await client.getMessages(channelArg, { ids: [messageId] });
  if (!messages || messages.length === 0 || !messages[0].media) return null;

  const message = messages[0];
  const document = message.media.document;
  if (!document) return null;

  const meta = {
    message,
    document,
    fileSize: Number(document.size),
    mimeType: document.mimeType || 'video/mp4',
  };
  messageCache.set(cacheKey, meta);
  return meta;
}

// ─── Indexing Progress SSE ──────────────────────────────────────────────────
// Map of sourceId => Set of SSE response objects
const indexProgressClients = new Map();

app.get('/api/sources/status', (req, res) => {
  if (!qrAuthed) return res.status(401).json({ error: 'AUTH_KEY_UNREGISTERED' });
  const indexer = app.get('indexer');
  const sources = db.getSources(appUserId);
  const result = sources.map(s => {
    const state = indexer ? indexer.getState(s.id) : { status: 'idle', processed: 0, total: 0, error: null };
    return { id: s.id, name: s.name, ...state };
  });
  res.json(result);
});

app.get('/api/sources/:id/progress', (req, res) => {
  if (!qrAuthed) return res.status(401).json({ error: 'AUTH_KEY_UNREGISTERED' });
  const sourceId = parseInt(req.params.id);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  if (!indexProgressClients.has(sourceId)) indexProgressClients.set(sourceId, new Set());
  indexProgressClients.get(sourceId).add(res);

  // Send current state immediately
  const indexer = app.get('indexer');
  if (indexer) {
    const state = indexer.getState(sourceId);
    res.write(`data: ${JSON.stringify(state)}\n\n`);
  }

  req.on('close', () => {
    const clients = indexProgressClients.get(sourceId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) indexProgressClients.delete(sourceId);
    }
  });
});

// ─── Source & Catalog API ───────────────────────────────────────────────────
app.get('/api/sources', (req, res) => {
  if (!qrAuthed) return res.status(401).json({ error: 'AUTH_KEY_UNREGISTERED' });
  const sources = db.getSources(appUserId);
  res.json(sources);
});

app.post('/api/sources', async (req, res) => {
  if (!qrAuthed) return res.status(401).json({ error: 'AUTH_KEY_UNREGISTERED' });
  const { name, link, isSingleSeries } = req.body || {};
  if (!link) return res.status(400).json({ error: 'Link required' });
  
  try {
    let finalName = name;
    if (!finalName) {
      // Resolve link to get channel name
      const url = new URL(link);
      const parts = url.pathname.split('/').filter(Boolean);
      let channelId;
      if (parts[0] === 'c') {
        channelId = bigInt('-100' + parts[1]);
      } else {
        channelId = parts[0];
      }
      const entity = await client.getEntity(channelId);
      finalName = entity.title || entity.username || 'Telegram Channel';
    }

    const source = db.addSource(finalName, link, isSingleSeries !== false, appUserId);
    const indexer = app.get('indexer');
    if (indexer) {
      indexer.indexSource(source).catch(err => console.error('Indexing error:', err));
    }
    await syncSourcesToTelegram(appUserId);
    res.json(source);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/sources/:id', async (req, res) => {
  if (!qrAuthed) return res.status(401).json({ error: 'AUTH_KEY_UNREGISTERED' });
  try {
    db.deleteSource(parseInt(req.params.id));
    await syncSourcesToTelegram(appUserId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sources/:id/refresh', async (req, res) => {
  if (!qrAuthed) return res.status(401).json({ error: 'AUTH_KEY_UNREGISTERED' });
  const indexer = app.get('indexer');
  if (indexer) {
    const source = db.getSourceById(parseInt(req.params.id));
    if (source) {
      indexer.indexSource(source).catch(err => console.error('Indexing error:', err));
      return res.json({ success: true, message: 'Indexing started' });
    }
  }
  res.status(400).json({ error: 'Failed' });
});

// Duplicate series endpoint removed

app.post('/api/catalog/episodes/:id/assign', (req, res) => {
  if (!qrAuthed) return res.status(401).json({ error: 'AUTH_KEY_UNREGISTERED' });
  const { id } = req.params;
  const { seriesId, seasonNumber, episodeNumber } = req.body;
  try {
    const newSeasonId = db.getOrCreateSeason(parseInt(seriesId), parseInt(seasonNumber));
    db.db.prepare('UPDATE episodes SET season_id = ?, episode_number = ?, is_manual = 1 WHERE id = ?')
      .run(newSeasonId, parseInt(episodeNumber), parseInt(id));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/catalog/episodes/:id/reset', (req, res) => {
  if (!qrAuthed) return res.status(401).json({ error: 'AUTH_KEY_UNREGISTERED' });
  const { id } = req.params;
  try {
    // If original_season_id is missing, find the 'Season 0' for this series as a fallback
    const ep = db.db.prepare('SELECT e.*, se.series_id FROM episodes e JOIN seasons se ON e.season_id = se.id WHERE e.id = ?').get(id);
    if (ep) {
       let targetSeasonId = ep.original_season_id;
       let targetEpNum = ep.original_episode_number;

       if (!targetSeasonId) {
          // Fallback to Season 0 for this series
          const s0 = db.db.prepare('SELECT id FROM seasons WHERE series_id = ? AND season_number = 0').get(ep.series_id);
          if (s0) targetSeasonId = s0.id;
          targetEpNum = 0;
       }

       db.db.prepare('UPDATE episodes SET season_id = ?, episode_number = ?, is_manual = 0 WHERE id = ?')
         .run(targetSeasonId, targetEpNum, parseInt(id));
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Reset error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/catalog/seasons/:id/auto-sort', (req, res) => {
  if (!qrAuthed) return res.status(401).json({ error: 'AUTH_KEY_UNREGISTERED' });
  const seasonId = parseInt(req.params.id);
  try {
    // Get the season to find its series
    const season = db.db.prepare('SELECT * FROM seasons WHERE id = ?').get(seasonId);
    if (!season) return res.status(404).json({ error: 'Season not found' });

    // Get all unmanual episodes in this season (season 0), sorted by message_id (chronological)
    const unrecognized = db.db.prepare(
      'SELECT * FROM episodes WHERE season_id = ? AND is_manual = 0 ORDER BY message_id ASC'
    ).all(seasonId);

    if (unrecognized.length === 0) return res.json({ success: true, assigned: 0 });

    // Get all known (non-season-0) episodes for this series, sorted by message_id
    const knownEpisodes = db.db.prepare(`
      SELECT e.*, s.season_number FROM episodes e
      JOIN seasons s ON e.season_id = s.id
      WHERE s.series_id = ? AND s.season_number <> 0
      ORDER BY e.message_id ASC
    `).all(season.series_id);

    // Helper: find the "anchor" – nearest known episode below and above each unrecognized
    const inferPlacement = (msgId) => {
      // find lower and upper neighbours in known list
      let lowerNeighbour = null, upperNeighbour = null;
      for (const k of knownEpisodes) {
        if (k.message_id < msgId) lowerNeighbour = k;
        if (k.message_id > msgId && !upperNeighbour) upperNeighbour = k;
      }

      if (lowerNeighbour && upperNeighbour) {
        // interpolate: if same season, fill in between
        if (lowerNeighbour.season_number === upperNeighbour.season_number) {
          return { seasonNumber: lowerNeighbour.season_number, episodeNumber: lowerNeighbour.episode_number + 1 };
        } else {
          // boundary between seasons – put after lower
          return { seasonNumber: lowerNeighbour.season_number, episodeNumber: lowerNeighbour.episode_number + 1 };
        }
      } else if (lowerNeighbour) {
        return { seasonNumber: lowerNeighbour.season_number, episodeNumber: lowerNeighbour.episode_number + 1 };
      } else if (upperNeighbour) {
        return { seasonNumber: upperNeighbour.season_number, episodeNumber: Math.max(1, upperNeighbour.episode_number - 1) };
      }
      return null; // Cannot infer
    };

    let assigned = 0;
    // Process episodes in chronological order (by message_id).
    // For each, we find its immediate lower and upper known neighbours, which gives
    // us the exact slot. E.g. lower=S1E2, upper=S1E4 → this ep must be S1E3.
    // We track inserts per season so that multiple consecutive unknowns fill slots correctly.
    const insertedSlots = {}; // seasonNumber -> sorted list of inserted episode numbers (so we don't collide)

    for (const ep of unrecognized) {
      // Re-build a merged "known + already inserted" view for accurate slot finding
      const allKnown = [
        ...knownEpisodes,
        // inject already-inserted virtual rows so subsequent eps step correctly
        ...Object.entries(insertedSlots).flatMap(([sn, nums]) =>
          nums.map(num => ({ season_number: parseInt(sn), episode_number: num, message_id: -1 }))
        )
      ];

      let lowerNeighbour = null, upperNeighbour = null;
      for (const k of knownEpisodes) {
        if (k.message_id < ep.message_id) lowerNeighbour = k;
        if (k.message_id > ep.message_id && !upperNeighbour) upperNeighbour = k;
      }

      if (!lowerNeighbour && !upperNeighbour) continue; // Cannot infer

      let seasonNumber, episodeNumber;

      if (lowerNeighbour && upperNeighbour && lowerNeighbour.season_number === upperNeighbour.season_number) {
        // Sandwiched within the same season: find the next free slot between lower and upper
        seasonNumber = lowerNeighbour.season_number;
        const occupied = new Set(
          allKnown.filter(k => k.season_number === seasonNumber).map(k => k.episode_number)
        );
        // Start from lower+1 and find first unoccupied slot before upper
        let slot = lowerNeighbour.episode_number + 1;
        while (occupied.has(slot) && slot < upperNeighbour.episode_number) slot++;
        episodeNumber = slot;
      } else if (lowerNeighbour) {
        seasonNumber = lowerNeighbour.season_number;
        const occupied = new Set(
          allKnown.filter(k => k.season_number === seasonNumber).map(k => k.episode_number)
        );
        let slot = lowerNeighbour.episode_number + 1;
        while (occupied.has(slot)) slot++;
        episodeNumber = slot;
      } else {
        // Only upper neighbour
        seasonNumber = upperNeighbour.season_number;
        const occupied = new Set(
          allKnown.filter(k => k.season_number === seasonNumber).map(k => k.episode_number)
        );
        let slot = Math.max(1, upperNeighbour.episode_number - 1);
        while (occupied.has(slot) && slot > 0) slot--;
        if (occupied.has(slot)) slot = upperNeighbour.episode_number + 1; // fallback
        episodeNumber = slot;
      }

      // Track inserted slot to prevent next episode in this batch from colliding
      if (!insertedSlots[seasonNumber]) insertedSlots[seasonNumber] = [];
      insertedSlots[seasonNumber].push(episodeNumber);

      const newSeasonId = db.getOrCreateSeason(season.series_id, seasonNumber);
      db.db.prepare('UPDATE episodes SET season_id = ?, episode_number = ?, is_manual = 1 WHERE id = ?')
        .run(newSeasonId, episodeNumber, ep.id);
      assigned++;
    }

    res.json({ success: true, assigned });
  } catch (err) {
    console.error('Auto-sort error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/catalog/series', (req, res) => {
  if (!qrAuthed) return res.status(401).json({ error: 'AUTH_KEY_UNREGISTERED' });
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  const series = db.getAllSeries(appUserId);
  if (appUserId) {
    const favorites = new Set(db.getFavorites(appUserId).filter(f => f.item_type === 'series').map(f => f.item_id));
    series.forEach(s => { s.is_favorite = favorites.has(s.id); });
  }
  res.json(series);
});

app.get('/api/catalog/series/:id', (req, res) => {
  if (!qrAuthed) return res.status(401).json({ error: 'AUTH_KEY_UNREGISTERED' });
  const series = db.getSeriesById(parseInt(req.params.id), appUserId);
  if (!series) return res.status(404).json({ error: 'Series not found' });
  if (appUserId) {
    const favorites = new Set(db.getFavorites(appUserId).filter(f => f.item_type === 'series').map(f => f.item_id));
    series.is_favorite = favorites.has(series.id);
  }
  res.json(series);
});

app.get('/api/catalog/series/:id/seasons', (req, res) => {
  if (!qrAuthed) return res.status(401).json({ error: 'AUTH_KEY_UNREGISTERED' });
  res.setHeader('Cache-Control', 'no-store');
  res.json(db.getSeasonsBySeriesId(parseInt(req.params.id)));
});

app.get('/api/catalog/seasons/:id/episodes', (req, res) => {
  if (!qrAuthed) return res.status(401).json({ error: 'AUTH_KEY_UNREGISTERED' });
  res.setHeader('Cache-Control', 'no-store');
  const episodes = db.getEpisodesBySeasonId(parseInt(req.params.id));
  if (appUserId) {
    const favorites = new Set(db.getFavorites(appUserId).filter(f => f.item_type === 'episode').map(f => f.item_id));
    const progresses = new Map(db.getAllProgress(appUserId).map(p => [p.episode_id, p]));
    episodes.forEach(e => {
      e.is_favorite = favorites.has(e.id);
      const prog = progresses.get(e.id);
      if (prog) {
        e.progress_seconds = prog.progress_seconds;
        e.duration = prog.duration;
        e.is_watched = prog.is_watched;
      }
    });
  }
  res.json(episodes);
});

// ─── Settings, Progress, Favorites ─────────────────────────────────────────
app.get('/api/settings', (req, res) => {
  if (!qrAuthed) return res.status(401).json({ error: 'AUTH_KEY_UNREGISTERED' });
  if (!appUserId) return res.status(400).json({ error: 'User ID not loaded' });
  res.json(db.getUserSettings(appUserId));
});

app.post('/api/settings', (req, res) => {
  if (!qrAuthed) return res.status(401).json({ error: 'AUTH_KEY_UNREGISTERED' });
  if (!appUserId) return res.status(400).json({ error: 'User ID not loaded' });
  const { auto_next_enabled, auto_next_countdown, seek_step } = req.body;
  db.updateUserSettings(appUserId, auto_next_enabled, auto_next_countdown, seek_step);
  res.json({ success: true });
});

app.post('/api/progress/:episodeId', (req, res) => {
  if (!qrAuthed) return res.status(401).json({ error: 'AUTH_KEY_UNREGISTERED' });
  if (!appUserId) return res.status(400).json({ error: 'User ID not loaded' });
  
  const episodeId = parseInt(req.params.episodeId);
  const { progress_seconds, duration, force_watched } = req.body;
  if (isNaN(progress_seconds) || isNaN(duration) || duration <= 0) {
    return res.status(400).json({ error: 'Invalid parameters' });
  }

  const isWatched = force_watched === true ? true : (progress_seconds >= duration * 0.90);
  db.updateProgress(appUserId, episodeId, Math.floor(progress_seconds), Math.floor(duration), isWatched ? 1 : 0);
  res.json({ success: true, is_watched: isWatched });
});

app.get('/api/progress/continue', (req, res) => {
  if (!qrAuthed) return res.status(401).json({ error: 'AUTH_KEY_UNREGISTERED' });
  if (!appUserId) return res.status(400).json({ error: 'User ID not loaded' });
  const progressList = db.getAllProgress(appUserId).filter(p => !p.is_watched && p.progress_seconds > 5);
  const result = [];
  for (const p of progressList) {
    const ep = db.db.prepare(`
      SELECT e.*, s.season_number, s.series_id, 
             CASE WHEN src.is_single_series = 1 THEN src.name ELSE ser.title END as series_title,
             src.photo_base64 as source_photo
      FROM episodes e 
      JOIN seasons s ON e.season_id = s.id 
      JOIN series ser ON s.series_id = ser.id 
      JOIN sources src ON ser.source_id = src.id
      WHERE e.id = ?
    `).get(p.episode_id);
    if (ep) {
      ep.progress_seconds = p.progress_seconds;
      ep.duration = p.duration;
      ep.is_watched = p.is_watched;
      result.push(ep);
    }
  }
  res.json(result);
});

app.delete('/api/progress/:episodeId', (req, res) => {
  if (!qrAuthed) return res.status(401).json({ error: 'AUTH_KEY_UNREGISTERED' });
  if (!appUserId) return res.status(400).json({ error: 'User ID not loaded' });
  const episodeId = parseInt(req.params.episodeId);
  db.db.prepare('DELETE FROM watch_progress WHERE user_id = ? AND episode_id = ?').run(appUserId, episodeId);
  res.json({ success: true });
});

app.post('/api/favorites', (req, res) => {
  if (!qrAuthed) return res.status(401).json({ error: 'AUTH_KEY_UNREGISTERED' });
  if (!appUserId) return res.status(400).json({ error: 'User ID not loaded' });
  const { item_type, item_id } = req.body;
  if (!['series', 'episode'].includes(item_type) || !item_id) {
    return res.status(400).json({ error: 'Invalid item type or id' });
  }
  db.addFavorite(appUserId, item_type, Number(item_id));
  res.json({ success: true });
});

app.delete('/api/favorites/:type/:id', (req, res) => {
  if (!qrAuthed) return res.status(401).json({ error: 'AUTH_KEY_UNREGISTERED' });
  if (!appUserId) return res.status(400).json({ error: 'User ID not loaded' });
  const { type, id } = req.params;
  db.removeFavorite(appUserId, type, Number(id));
  res.json({ success: true });
});

app.get('/api/favorites/details', (req, res) => {
  if (!qrAuthed) return res.status(401).json({ error: 'AUTH_KEY_UNREGISTERED' });
  if (!appUserId) return res.status(400).json({ error: 'User ID not loaded' });
  const favs = db.getFavorites(appUserId);
  const seriesIdList = favs.filter(f => f.item_type === 'series').map(f => f.item_id);
  const episodeIds = favs.filter(f => f.item_type === 'episode').map(f => f.item_id);
  
  const series = seriesIdList.length ? db.getAllSeries(appUserId).filter(s => seriesIdList.includes(s.id)) : [];
  series.forEach(s => s.is_favorite = true);

  const episodes = [];
  if (episodeIds.length > 0) {
    const placeholders = episodeIds.map(() => '?').join(',');
    const eps = db.db.prepare(`
      SELECT e.*, s.season_number, s.series_id, 
             CASE WHEN src.is_single_series = 1 THEN src.name ELSE ser.title END as series_title,
             src.photo_base64 as source_photo
      FROM episodes e 
      JOIN seasons s ON e.season_id = s.id 
      JOIN series ser ON s.series_id = ser.id 
      JOIN sources src ON ser.source_id = src.id
      WHERE e.id IN (${placeholders})
    `).all(...episodeIds);
    
    const progresses = new Map(db.getAllProgress(appUserId).map(p => [p.episode_id, p]));
    eps.forEach(e => {
        e.is_favorite = true;
        const prog = progresses.get(e.id);
        if (prog) {
          e.progress_seconds = prog.progress_seconds;
          e.duration = prog.duration;
          e.is_watched = prog.is_watched;
        }
    });
    episodes.push(...eps);
  }
  res.json({ series, episodes });
});

// ─── /api/meta/:channel/:messageId ────────────────────────────────────────────
app.get('/api/meta/:channel/:messageId', async (req, res) => {
  try {
    const meta = await getMediaMeta(req.params.channel, parseInt(req.params.messageId));
    if (!meta) return res.status(404).json({ error: 'Not found' });
    res.json({ fileSize: meta.fileSize, mimeType: meta.mimeType });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const SYNC_CHANNEL_NAME = 'StreamApp Data';

let cachedSyncChannelId = null;

async function getSyncChannel() {
  if (cachedSyncChannelId) {
    return cachedSyncChannelId;
  }
  const dialogs = await client.getDialogs({ limit: 50 });
  const ch = dialogs.find(d => d.title === SYNC_CHANNEL_NAME && (d.isChannel || d.isGroup));
  if (ch) {
    cachedSyncChannelId = ch.entity || ch.inputEntity || ch.id;
  }
  return ch || null;
}

async function syncSourcesFromTelegram(userId) {
  if (!userId) return;
  try {
    const syncChannel = await getSyncChannel();
    if (!syncChannel) {
      // If no channel exists, we should push the local DB to create one.
      const currentSources = db.getSources(userId);
      if (currentSources.length > 0) {
        console.log(`No sync channel found. Pushing ${currentSources.length} existing local sources to Telegram for user ${userId}.`);
        await syncSourcesToTelegram(userId);
      }
      return;
    }

    const messages = await client.getMessages(syncChannel.id, { limit: 10 });
    const syncMsg = messages.find(m => m.message && m.message.startsWith('#StreamAppSources'));
    if (syncMsg) {
      try {
        const lines = syncMsg.message.split('\n');
        const dataStr = lines.slice(1).join('\n').trim();
        let jsonStr = '';
        if (dataStr.startsWith('[')) {
          jsonStr = dataStr; // Backward compatibility for unencoded JSON
        } else {
          jsonStr = Buffer.from(dataStr, 'base64').toString('utf-8');
        }
        const sourcesObj = JSON.parse(jsonStr);
        if (Array.isArray(sourcesObj)) {
          let changes = false;
          const currentLocal = db.getSources(userId);
          // Merge local sources not present in Telegram
          for (const loc of currentLocal) {
            const locIsSingle = (loc.is_single_series === 1 || loc.is_single_series === true) ? 1 : 0;
            const match = sourcesObj.find(s => s.link === loc.link);
            if (!match) {
              sourcesObj.push({ name: loc.name, link: loc.link, is_single_series: locIsSingle });
              changes = true;
            } else {
              // Also check if properties changed
              const tgIsSingle = (match.is_single_series === 1 || match.is_single_series === true) ? 1 : 0;
              if (tgIsSingle !== locIsSingle || match.name !== loc.name) {
                changes = true;
                // We'll let Telegram be the truth for properties usually, but if local is newer (just changed), we might want to push.
                // For now, if there is a mismatch, we mark changes to trigger a re-sync.
              }
            }
          }

          db.setSourcesForUser(userId, sourcesObj);
          console.log(`[Sync] Restored ${sourcesObj.length} sources from Telegram for user ${userId}`);
          
          if (changes) {
            console.log('[Sync] Local/Telegram mismatch detected, pushing merged state to Telegram...');
            await syncSourcesToTelegram(userId);
          }

          const indexer = app.get('indexer');
          if (indexer) {
            const currentSources = db.getSources(userId);
            for (const src of currentSources) {
              indexer.indexSource(src).catch(err => console.error('Indexing error during sync:', err));
            }
          }
        }
      } catch (e) {
        console.error('Failed to parse sync message:', e);
      }
    }
  } catch (err) {
    console.error('Error in syncSourcesFromTelegram:', err.message);
  }
}

async function syncSourcesToTelegram(userId) {
  if (!userId) return;
  try {
    const sources = db.getSources(userId);
    const sourcesList = sources.map(s => ({ name: s.name, link: s.link, is_single_series: s.is_single_series }));
    const base64Str = Buffer.from(JSON.stringify(sourcesList)).toString('base64');
    const messageText = `#StreamAppSources\n${base64Str}`;

    let syncChannel = await getSyncChannel();

    if (!syncChannel) {
      console.log(`[Sync] Creating new sync channel "${SYNC_CHANNEL_NAME}"...`);
      const result = await client.invoke(new Api.channels.CreateChannel({
        title: SYNC_CHANNEL_NAME,
        about: 'Storage for StreamApp configurations.',
        broadcast: true
      }));
      const channelId = result.chats[0].id;
      const sentMsg = await client.sendMessage(channelId, { message: messageText });
      await client.invoke(new Api.messages.UpdatePinnedMessage({
        peer: channelId,
        id: sentMsg.id,
        pinned: true
      }));
      console.log(`[Sync] Created channel ${channelId} and saved initial sources.`);
    } else {
      const channelPeer = syncChannel.entity || syncChannel.inputEntity || syncChannel.id;
      const messages = await client.getMessages(channelPeer, { limit: 50 });
      const syncMsg = messages.find(m => m.message && m.message.startsWith('#StreamAppSources'));
      if (syncMsg) {
        console.log(`[Sync] Updating existing message (ID: ${syncMsg.id}) in channel "${syncChannel.title}" (ID: ${syncChannel.id})...`);
        await client.editMessage(channelPeer, { message: syncMsg.id, text: messageText });
      } else {
        console.log(`[Sync] No sync message found in channel "${syncChannel.title}", sending new one...`);
        const sentMsg = await client.sendMessage(channelPeer, { message: messageText });
        await client.invoke(new Api.messages.UpdatePinnedMessage({
          peer: channelPeer,
          id: sentMsg.id,
          pinned: true
        }));
      }
      console.log(`[Sync] Successfully pushed ${sourcesList.length} sources to Telegram.`);
    }
  } catch (err) {
    console.error('Error in syncSourcesToTelegram:', err.message);
  }
}

// ─── Global Telegram Download Serializer ─────────────────────────────────────
// ─── Global Telegram Download Serializer ─────────────────────────────────────
const MAX_CONCURRENT_DOWNLOADS = parseInt(process.env.MAX_CONCURRENT_DOWNLOADS) || 3;
let activeSlots = 0;
const slotQueue = [];

function acquireSlot() {
  metrics.queueLength = slotQueue.length;
  if (activeSlots < MAX_CONCURRENT_DOWNLOADS) {
    activeSlots++;
    return Promise.resolve();
  }
  return new Promise(resolve => slotQueue.push(resolve));
}

function releaseSlot() {
  if (slotQueue.length > 0) {
    metrics.queueLength = slotQueue.length - 1;
    slotQueue.shift()(); 
  } else {
    activeSlots--;
  }
}

// ─── Internal Chunk Cache Manager (LRU, byte-aware) ──────────────────────────
// LRUCache already imported above (line ~173), no need to re-import.
const INTERNAL_CHUNK = 512 * 1024; // Match Telegram's natural block size

const metrics = {
  cacheHits: 0,
  cacheMisses: 0,
  telegramFetches: 0,
  activeStreams: 0,
  queueLength: 0,
};

const chunkCache = new LRUCache({
  maxSize: 150 * 1024 * 1024,          // 150 MB total
  sizeCalculation: (buf) => buf.length, // count real bytes
  ttl: 1000 * 60 * 30,                 // 30-minute TTL per entry
  allowStale: false,
});

// Added dictionary for coalescing duplicate chunk requests
const inFlightChunks = new Map();
// Keep track of how many parallel requests are trying to fetch the same episode
const episodeStreamCount = new Map();

async function getCachedChunk(message, channel, messageId, chunkIndex, fileSize, isClientGone) {
  const key = `${channel}_${messageId}_${chunkIndex}`;  // channel-scoped key
  
  // 1. Instant cache hit
  if (chunkCache.has(key)) {
    metrics.cacheHits++;
    return chunkCache.get(key);
  }

  // Coalescing: check if someone is already fetching this exact chunk
  if (inFlightChunks.has(key)) {
    metrics.cacheHits++; // Treating as cache hit technically since it avoids fetch
    return inFlightChunks.get(key);
  }

  // 2. Cache miss -> Queue up for Telegram connection
  metrics.cacheMisses++;
  
  // wrap actual logic in a promise and cache it in inFlightChunks
  const fetchPromise = (async () => {
    await acquireSlot();
    try {
      // 3. Queue resolved -> double check if someone else fetched it while we waited
      if (chunkCache.has(key)) {
        metrics.cacheHits++;
        return chunkCache.get(key);
      }
      
      if (isClientGone()) return Buffer.alloc(0); // Client disconnected, abort

      const startByte = chunkIndex * INTERNAL_CHUNK;
      if (startByte >= fileSize) return Buffer.alloc(0);
      const fetchSize = Math.min(INTERNAL_CHUNK, fileSize - startByte);

      console.log(`[Cache Miss] Fetching ${key} from Telegram`);
      metrics.telegramFetches++;

      const chunks = [];
      let bytesFetched = 0;
      
      try {
        for await (const chunk of client.iterDownload({
          file: message.media,
          offset: bigInt(startByte),
          limit: fetchSize,
          requestSize: 512 * 1024,
          workers: 1,                  // reduced from 4 to 1 to prevent flood wait burst
        })) {
          if (isClientGone()) break;
          // Clamp strictly to prevent ERR_INVALID_HTTP_RESPONSE logic bugs
          const remaining = fetchSize - bytesFetched;
          if (chunk.length >= remaining) {
            chunks.push(chunk.slice(0, remaining));
            break;
          } else {
            chunks.push(chunk);
            bytesFetched += chunk.length;
          }
        }
      } catch (err) {
        if (err.message && err.message.includes('FLOOD_WAIT')) {
            console.error(`[Telegram FLOOD_WAIT] Caught FLOOD_WAIT error for ${key}: ${err.message}`);
            await new Promise(r => setTimeout(r, 2000));
        }
        throw err;
      }
      
      const finale = Buffer.concat(chunks);
      
      chunkCache.set(key, finale);
      return finale;
    } finally {
      releaseSlot();
      inFlightChunks.delete(key);
    }
  })();
  
  inFlightChunks.set(key, fetchPromise);
  return fetchPromise;
}

// ─── /api/stream/:channel/:messageId ─────────────────────────────────────────
const MAX_STREAM_CHUNK = 5 * 1024 * 1024; // 5 MB max per response

app.get('/api/stream/:channel/:messageId', async (req, res) => {
  if (!qrAuthed) return res.status(401).send('Session expired');
  const messageId = parseInt(req.params.messageId);
  const channel = req.params.channel;

  const streamKey = `${channel}_${messageId}`;
  const currentStreams = episodeStreamCount.get(streamKey) || 0;
  if (currentStreams >= 2) {
    console.warn(`[Stream Limit] Too many concurrent requests for ${streamKey}. Denying new request.`);
    return res.status(429).send('Too Many Requests For This Episode');
  }
  episodeStreamCount.set(streamKey, currentStreams + 1);

  metrics.activeStreams++;
  try {
    const meta = await getMediaMeta(channel, messageId);
    if (!meta) return res.status(404).send('Video not found');

    const { message, fileSize, mimeType } = meta;

    const rangeHeader = req.headers.range;
    let reqStart = 0;
    let reqEnd   = fileSize - 1;

    if (rangeHeader) {
      const parts = rangeHeader.replace(/bytes=/, '').split('-');
      reqStart = parseInt(parts[0], 10) || 0;
      reqEnd   = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    }

    reqStart = Math.max(0, Math.min(reqStart, fileSize - 1));
    reqEnd   = Math.max(reqStart, Math.min(reqEnd, fileSize - 1));

    const cappedEnd     = Math.min(reqEnd, reqStart + MAX_STREAM_CHUNK - 1);
    const contentLength = cappedEnd - reqStart + 1;

    let clientGone = false;
    res.setTimeout(60000, () => {
      console.log(`[Stream] Timeout hit on ${channel}/${messageId}, aborting connection`);
      clientGone = true;
      res.end(); // forcible termination if stream hangs
    });
    req.on('close', () => { clientGone = true; });

    res.writeHead(206, {
      'Content-Type':   mimeType,
      'Content-Length': contentLength,
      'Content-Range':  `bytes ${reqStart}-${cappedEnd}/${fileSize}`,
      'Accept-Ranges':  'bytes',
      'Cache-Control':  'no-transform',
      'X-Content-Type-Options': 'nosniff',
    });

    // Start streaming from Cache Manager
    const startChunkIndex = Math.floor(reqStart / INTERNAL_CHUNK);
    const endChunkIndex   = Math.floor(cappedEnd / INTERNAL_CHUNK);

    try {
      for (let i = startChunkIndex; i <= endChunkIndex; i++) {
        if (clientGone) break;

        const buf = await getCachedChunk(message, channel, messageId, i, fileSize, () => clientGone);
        if (!buf || buf.length === 0) break;

        const chunkStartByte = i * INTERNAL_CHUNK;
        const sliceStart = Math.max(0, reqStart - chunkStartByte);
        const sliceEnd   = Math.min(buf.length, cappedEnd - chunkStartByte + 1);

        res.write(buf.slice(sliceStart, sliceEnd));
      }
    } catch (e) {
      if (!clientGone) console.error('[stream chunk] error:', e.message);
    } finally {
      res.end();
    }

  } catch (err) {
    if (err.message && err.message.includes('AUTH_KEY_UNREGISTERED')) {
      handleSessionExpired();
    }
    console.error('[stream] API error:', err.message);
    if (!res.headersSent) res.status(500).send('Streaming Failed');
  } finally {
    metrics.activeStreams--;
    const currentStreams = episodeStreamCount.get(streamKey) || 0;
    if (currentStreams <= 1) {
      episodeStreamCount.delete(streamKey);
    } else {
      episodeStreamCount.set(streamKey, currentStreams - 1);
    }
  }
});

app.get('/health', (req, res) => res.send('OK'));

app.get('/api/metrics', (req, res) => {
  const hitRatio = (metrics.cacheHits + metrics.cacheMisses) > 0
    ? (metrics.cacheHits / (metrics.cacheHits + metrics.cacheMisses) * 100).toFixed(1)
    : 'N/A';

  res.json({
    cacheHits: metrics.cacheHits,
    cacheMisses: metrics.cacheMisses,
    cacheHitRatio: `${hitRatio}%`,
    telegramFetches: metrics.telegramFetches,
    activeStreams: metrics.activeStreams,
    downloadQueueLength: metrics.queueLength,
    chunkCacheSize: `${(chunkCache.calculatedSize / 1024 / 1024).toFixed(1)} MB`,
    channelIndexCount: channelIndexCache.size,
    messageCacheCount: messageCache.size,
  });
});

let isRecoveringSession = false;

function handleSessionExpired() {
  if (isRecoveringSession) return;
  isRecoveringSession = true;
  console.error('Session expired (AUTH_KEY_UNREGISTERED). Invalidating session...');
  
  qrAuthed = false;
  qrAuthLink = null;
  qrAuthError = null;
  
  // We don't call stringSession.setSession - clearing .env and qrAuthed is sufficient
  // The client will negotiate a new session via QR.
  
  const fs = require('fs');
  let envConf = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf-8') : '';
  envConf = envConf.replace(/TG_SESSION=.*/g, `TG_SESSION=""`);
  fs.writeFileSync('.env', envConf.trim() + '\n');
  
  console.log('Restarting QR login flow...');
  startQrLoginFlow();
}

function startQrLoginFlow() {
  qrAuthError = null;
  qrAuthLink = null;
  client.signInUserWithQrCode(
    { apiId, apiHash },
    {
      onError: (err) => {
        console.error('QR Login Error:', err);
        qrAuthError = err.message;
        isRecoveringSession = false;
      },
      qrCode: (code) => {
        if (qrAuthed) return; // Stop logging if already authed
        const tokenB64 = code.token.toString('base64url');
        qrAuthLink = `tg://login?token=${tokenB64}`;
        console.log(`Scan this URI to login: ${qrAuthLink}`);
      },
      password: async () => {
        qrAuthError = "2FA Password required. Use phone login fallback.";
        console.warn('QR Login requires 2FA password. Falling back to phone login or manual input is needed.');
        // For now, we don't have a way to prompt user via QR flow easily, but we can set state
        return ""; // Usually this results in error which is caught
      }
    }
  ).then(async () => {
      console.log('User signed in via QR successfully!');
      qrAuthed = true;
      try { const me = await client.getMe(); appUserId = Number(me.id); await syncSourcesFromTelegram(appUserId); } catch (e) {}
      qrAuthLink = null;
      isRecoveringSession = false; // Reset recovery state on success
      
      const newSession = client.session.save();
      const fs = require('fs');
      let envConf = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf-8') : '';
      if (envConf.includes('TG_SESSION=')) {
        envConf = envConf.replace(/TG_SESSION=.*/g, `TG_SESSION="${newSession}"`);
      } else {
        envConf += `\nTG_SESSION="${newSession}"\n`;
      }
      fs.writeFileSync('.env', envConf.trim() + '\n');
      
      console.log('Pre-fetching chat list to sync channel access hashes...');
      return client.getDialogs({ limit: 50 });
  }).catch(e => {
      qrAuthError = e.message;
      console.error('Failed to finish QR flow:', e.message);
  });
}

async function startServer() {
  console.log('Connecting to Telegram…');
  await client.connect();

  if (!qrAuthed) {
    console.log('No session found. Starting QR Login flow...');
    isRecoveringSession = true;
    startQrLoginFlow();
  } else {
    try {
      console.log(`Connected! Logged in as User ID. Pre-fetching chat list...`);
      const [me, dialogs] = await Promise.all([
        client.getMe(),
        client.getDialogs({ limit: 50 })
      ]);
      appUserId = Number(me.id);
      await syncSourcesFromTelegram(appUserId);
    } catch (e) {
      console.error('Initial dialog sync failed:', e.message);
      if (e.message && e.message.includes('AUTH_KEY_UNREGISTERED')) {
        handleSessionExpired();
      }
    }
  }

  const indexer = new Indexer(client, messageCache);
  app.set('indexer', indexer);

  // Wire indexer progress events to SSE clients
  indexer.on('progress', (sourceId, state) => {
    const clients = indexProgressClients.get(sourceId);
    if (!clients || clients.size === 0) return;
    const payload = `data: ${JSON.stringify(state)}\n\n`;
    for (const res of clients) {
      try { res.write(payload); } catch (e) { /* client gone */ }
    }
  });

  const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running → http://0.0.0.0:${PORT}`));
}

startServer();
