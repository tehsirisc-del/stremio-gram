/**
 * Channel Indexer — client-side port of server/indexer.js
 * Scans Telegram channels, parses filenames, stores in Dexie IndexedDB.
 */

function parseTitle(rawTitle) {
  if (!rawTitle) return null;
  const title = rawTitle.replace(/\.[^/.]+$/, '');

  let seriesTitle = '';
  let season = null;
  let episode = null;

  const fullPatterns = [
    /(.*?)(\d+)\s*[-_.]?\s*(?:episode|פרק|פ|e|ep|ep\.)\s*[-_.]?\s*(\d+)(.*)/i,
    /(.*?)(?:season|עונה|s)\s*[-_.]?\s*(\d+)\s*[-_.]?\s*(?:episode|פרק|פ|e|ep|ep\.)\s*[-_.]?\s*(\d+)(.*)/i,
    /(.*?)(?:\s|[-_.])(\d{1,2})\s*x\s*(\d{1,3})(.*)/i,
    /(.*?)(?:ע)\s*[-_.]?\s*(\d+)\s*[-_.]?\s*(?:פ)\s*[-_.]?\s*(\d+)(.*)/i,
  ];

  for (const regex of fullPatterns) {
    const match = title.match(regex);
    if (match) {
      seriesTitle = match[1].replace(/[-_.\s]+$/, '').trim();
      season = parseInt(match[2], 10);
      episode = parseInt(match[3], 10);
      break;
    }
  }

  if (season === null || episode === null) {
    const epOnlyPatterns = [/(.*?)(?:episode|ep|פרק|e)\s*[-_.]?\s*(\d+)(.*)/i];
    for (const regex of epOnlyPatterns) {
      const match = title.match(regex);
      if (match) {
        seriesTitle = match[1].replace(/[-_.\s]+$/, '').trim();
        season = 1;
        episode = parseInt(match[2], 10);
        break;
      }
    }
  }

  if (season !== null && episode !== null) {
    if (!seriesTitle) seriesTitle = 'Unknown Series';
    seriesTitle = seriesTitle.replace(/[._]/g, ' ').trim()
      .replace(/\b\w/g, l => l.toUpperCase());
    return { seriesTitle, season, episode };
  }
  return null;
}

class Indexer {
  constructor() {
    this.states = new Map(); // sourceId -> { status, processed, total, error }
    this.queue = [];
    this.isRunning = false;
    this.onProgress = null; // callback(sourceId, state)
  }

  getState(sourceId) {
    return this.states.get(sourceId) || { status: 'idle', processed: 0, total: 0, error: null };
  }

  _setState(sourceId, patch) {
    const current = this.getState(sourceId);
    const next = { ...current, ...patch };
    this.states.set(sourceId, next);
    if (this.onProgress) this.onProgress(sourceId, next);
  }

  async indexSource(source) {
    const existing = this.states.get(source.id);
    if (existing && (existing.status === 'indexing' || existing.status === 'queued')) return;
    this._setState(source.id, { status: 'queued', error: null });
    this.queue.push(source);
    this._processQueue();
  }

  async _processQueue() {
    if (this.isRunning || this.queue.length === 0) return;
    this.isRunning = true;
    while (this.queue.length > 0) {
      const src = this.queue.shift();
      try { await this._doIndex(src); } catch (e) {
        console.error(`[Indexer] Uncaught error for ${src.name}:`, e);
      }
    }
    this.isRunning = false;
  }

  async _doIndex(source) {
    console.log(`[Indexer] Indexing ${source.name}...`);
    this._setState(source.id, { status: 'indexing', processed: 0, total: 0, error: null });

    let channelName, channelArg;
    try {
      const { channelName: cn, channelArg: ca } = await window.TGClient.resolveChannelFromLink(source.link);
      channelName = cn;
      channelArg = ca;
      await window.TGClient.getEntity(channelArg);
    } catch (e) {
      this._setState(source.id, { status: 'error', error: e.message });
      return;
    }

    const alreadyIndexed = new Set(await window.DB.getIndexedMessageIds(channelName));
    let totalIndexed = 0, skipped = 0;

    try {
      const { Api } = TelegramModule;
      let offsetId = 0;
      let hasMore = true;

      while (hasMore) {
        hasMore = false;
        const allMsgs = await window.TGClient.getMessages(channelArg, { limit: 100, offsetId });
        const messages = allMsgs.filter(m => m.media && m.media.document).sort((a, b) => b.id - a.id);

        let newOrUpdated = 0;
        let knownSkippedInBatch = 0;

        let count = 0;
        const batchToInsert = [];
        
        for (const msg of messages) {
          count++;
          if (count % 20 === 0) {
            // Yield to main thread every 20 messages to prevent UI freeze during parsing
            await new Promise(r => setTimeout(r, 0));
          }

          hasMore = true;
          offsetId = msg.id;
          if (!msg.media?.document) continue;
          if (alreadyIndexed.has(msg.id)) { skipped++; knownSkippedInBatch++; continue; }
          newOrUpdated++;

          const doc = msg.media.document;
          const attrs = doc.attributes || [];
          let fileName = `file_${msg.id}`;
          let duration = 0;
          let isVideo = doc.mimeType?.startsWith('video/') || false;
          let isAudio = doc.mimeType?.startsWith('audio/') || false;

          for (const attr of attrs) {
            if (attr.className === 'DocumentAttributeFilename') fileName = attr.fileName;
            if (attr.className === 'DocumentAttributeVideo') { duration = attr.duration; isVideo = true; }
            if (attr.className === 'DocumentAttributeAudio') { duration = attr.duration; isAudio = true; }
          }

          let parsed = parseTitle(fileName);
          if (source.is_single_series) {
            parsed = parsed
              ? { ...parsed, seriesTitle: source.name }
              : { seriesTitle: source.name, season: 0, episode: msg.id };
          } else {
            if (!parsed) parsed = { seriesTitle: `${source.name} - Other Videos`, season: 0, episode: msg.id };
          }

          if (parsed) {
             batchToInsert.push({
               parsed,
               data: {
                 title: fileName, duration, size: Number(doc.size),
                 message_id: msg.id, channel: channelName,
                 file_name: fileName, mime_type: doc.mimeType || 'video/mp4',
                 is_video: isVideo, is_audio: isAudio
               }
             });
          }
        }

        // Bulk insert using a SINGLE IndexedDB transaction!
        // This completely eliminates Android WebView SQLite IPC deadlocks
        // which freeze the app until a lifecycle visibility change occurs.
        if (batchToInsert.length > 0) {
          await window.DB.db.transaction('rw', window.DB.db.sources, window.DB.db.series, window.DB.db.seasons, window.DB.db.episodes, async () => {
            for (const item of batchToInsert) {
              const seriesId = await window.DB.getOrCreateSeries(source.id, item.parsed.seriesTitle);
              const seasonId = await window.DB.getOrCreateSeason(seriesId, item.parsed.season);
              await window.DB.upsertEpisode(seasonId, item.parsed.episode, item.data);
              totalIndexed++;
            }
          });
        }

        this._setState(source.id, {
          status: 'indexing',
          processed: totalIndexed + skipped,
          total: totalIndexed + skipped + (hasMore ? 100 : 0)
        });

        if (hasMore) {
          // Early exit: if a full batch had known items but 0 new items, we are fully caught up!
          if (newOrUpdated === 0 && knownSkippedInBatch > 0) {
            console.log(`[Indexer] Caught up with history for ${source.name}. Stopping early.`);
            break;
          }
          // Rate limit protection: wait 1000ms before next batch
          await new Promise(r => setTimeout(r, 1000));
        }
      }

      this._setState(source.id, { status: 'done', processed: totalIndexed + skipped, total: totalIndexed + skipped });
      console.log(`[Indexer] Done: ${source.name}. New: ${totalIndexed}, Skipped: ${skipped}`);

      // Download profile photo
      if (!source.photo_base64) {
        try {
          const entity = await window.TGClient.getEntity(channelArg);
          if (entity?.photo) {
            const photo = await window.TGClient.downloadProfilePhoto(entity);
            if (photo) await window.DB.updateSourcePhoto(source.id, photo);
          }
        } catch (e) {}
      }
    } catch (e) {
      console.error(`[Indexer] Error:`, e);
      this._setState(source.id, { status: 'error', error: e.message });
    }
  }
}

window.AppIndexer = new Indexer();
