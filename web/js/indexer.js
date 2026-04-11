/**
 * Channel Indexer — v2.0 (Identity-Aware)
 *
 * Orchestrates Telegram channel scanning and episode cataloging.
 * Now uses:
 *   - EpisodeParserPipeline  (episode-parser.js)   — filename → structured metadata
 *   - IdentityResolver       (identity-resolver.js) — title → canonical series ID
 *
 * Performance notes (Android TV):
 *   - parseTitle() legacy function removed; parser is shared via window.EpisodeParser
 *   - IdentityResolver cache warmed ONCE per source, not per episode
 *   - DB transaction wraps entire batch (prevents IndexedDB IPC deadlocks on WebView)
 *   - Main thread yielded every 20 messages — keeps UI and remote control responsive
 *   - Rate-limit: 1000ms between Telegram API batches (flood ban protection)
 */

class Indexer {
  constructor() {
    // sourceId → { status, processed, total, error }
    this.states = new Map();

    // FIFO queue of source objects to process
    this.queue = [];
    this.isRunning = false;

    // Optional progress callback: (sourceId, stateObj) => void
    this.onProgress = null;

    // One IdentityResolver instance shared across all sources in this session.
    // warmCache() reloads it before each source's batch.
    this._resolver = null;
  }

  // ── State helpers ──────────────────────────────────────────────────────────

  getState(sourceId) {
    return this.states.get(sourceId) || { status: 'idle', processed: 0, total: 0, error: null };
  }

  _setState(sourceId, patch) {
    const next = { ...this.getState(sourceId), ...patch };
    this.states.set(sourceId, next);
    if (this.onProgress) this.onProgress(sourceId, next);
  }

  // ── Identity Resolver accessor (lazy-init) ─────────────────────────────────

  _getResolver() {
    if (!this._resolver) {
      if (!window.IdentityResolver) {
        throw new Error('[Indexer] IdentityResolver not loaded. Ensure identity-resolver.js is included before indexer.js.');
      }
      this._resolver = new window.IdentityResolver(window.DB);
    }
    return this._resolver;
  }

  // ── Queue management ───────────────────────────────────────────────────────

  async indexSource(source, force = false) {
    const existing = this.states.get(source.id);
    if (existing && (existing.status === 'indexing' || existing.status === 'queued')) return;
    this._setState(source.id, { status: 'queued', error: null });
    this.queue.push({ source, force });
    this._processQueue();
  }

  async _processQueue() {
    if (this.isRunning || this.queue.length === 0) return;
    this.isRunning = true;
    while (this.queue.length > 0) {
      const { source, force } = this.queue.shift();
      try {
        await this._doIndex(source, force);
      } catch (e) {
        console.error(`[Indexer] Uncaught error for ${source.name}:`, e);
      }
    }
    this.isRunning = false;
  }

  // ── Core indexing logic ────────────────────────────────────────────────────

  async _doIndex(source, force = false) {
    console.log(`[Indexer] Starting${force ? ' (FORCE MODE)' : ''}: ${source.name} (id=${source.id})`);
    this._setState(source.id, { status: 'indexing', processed: 0, total: 0, error: null });

    // ── 1. Resolve channel reference from Telegram link ──────────────────────
    let channelName, channelArg;
    try {
      const resolved = await window.TGClient.resolveChannelFromLink(source.link);
      channelName = resolved.channelName;
      channelArg  = resolved.channelArg;
      await window.TGClient.getEntity(channelArg); // Validate access
    } catch (e) {
      console.error(`[Indexer] Cannot resolve channel for ${source.name}:`, e.message);
      this._setState(source.id, { status: 'error', error: e.message });
      return;
    }

    // ── 2. Warm the identity resolver cache (once per source) ─────────────────
    // Loading all canonical series from DB takes ~1-5ms on Android TV eMMC.
    // This is intentionally done here, not inside the per-episode loop.
    try {
      await this._getResolver().warmCache();
    } catch (e) {
      console.warn('[Indexer] IdentityResolver warmCache failed — falling back to legacy path:', e.message);
    }

    // ── 3. Load already-indexed message IDs for fast deduplication ────────────
    const alreadyIndexed = new Set(await window.DB.getIndexedMessageIds(channelName));
    let totalIndexed = 0;
    let skipped      = 0;

    try {
      let offsetId = 0;
      let hasMore  = true;

      while (hasMore) {
        hasMore = false;

        // Fetch a page of Telegram messages
        const allMsgs  = await window.TGClient.getMessages(channelArg, { limit: 100, offsetId });

        // Keep only document attachments (video/audio files), newest first
        const messages = allMsgs
          .filter(m => m.media && m.media.document)
          .sort((a, b) => b.id - a.id);

        let newInBatch     = 0;
        let skippedInBatch = 0;
        let count          = 0;

        // ── Build batch ────────────────────────────────────────────────────────
        // We gather all items into batchToInsert first, THEN write one transaction.
        // This prevents IPC deadlocks in Android WebView's IndexedDB implementation.
        const batchToInsert = [];

        for (const msg of messages) {
          count++;

          // Yield to the event loop every 20 messages.
          // Critical for Android TV: keeps the spatial nav and remote control
          // responsive during long indexing sessions.
          if (count % 20 === 0) {
            await new Promise(r => setTimeout(r, 0));
          }

          hasMore  = true;
          offsetId = msg.id;

          if (!msg.media?.document) continue;

          // In 'force' mode, we re-process even if already indexed (to resolve identities)
          if (alreadyIndexed.has(msg.id) && !force) {
            skipped++;
            skippedInBatch++;
            continue;
          }
          newInBatch++;

          // ── Extract file attributes ────────────────────────────────────────
          const doc     = msg.media.document;
          const attrs   = doc.attributes || [];
          let fileName  = `file_${msg.id}`;
          let duration  = 0;
          let isVideo   = doc.mimeType?.startsWith('video/') || false;
          let isAudio   = doc.mimeType?.startsWith('audio/') || false;

          for (const attr of attrs) {
            if (attr.className === 'DocumentAttributeFilename') {
              fileName = attr.fileName;
            }
            if (attr.className === 'DocumentAttributeVideo') {
              duration = attr.duration;
              isVideo  = true;
            }
            if (attr.className === 'DocumentAttributeAudio') {
              duration = attr.duration;
              isAudio  = true;
            }
          }

          // ── Parse episode metadata ─────────────────────────────────────────
          // Use the new pipeline from episode-parser.js.
          // Returns { seriesTitle, season, episode, confidence, patternUsed } or null.
          let parsed = window.EpisodeParser.parseEpisode(fileName, typeof msg.message === 'string' ? msg.message : '');

          // If no pattern matched, place in unrecognized bucket
          if (!parsed) {
            parsed = {
              seriesTitle: `${source.name} - Other Videos`,
              season:      0,
              episode:     msg.id,
              confidence:  0.10,
              patternUsed: 'UploadOrder',
            };
          }

          batchToInsert.push({
            parsed,
            data: {
              title:      fileName,
              duration,
              size:       Number(doc.size),
              message_id: msg.id,
              channel:    channelName,
              file_name:  fileName,
              mime_type:  doc.mimeType || 'video/mp4',
              is_video:   isVideo,
              is_audio:   isAudio,
              sourceId:   source.id,  // Provenance: which source provided this episode
            },
          });
        } // end per-message loop

        // ── Single Series Title Aggregation ──────────────────────────────────
        // For single-series channels, ALL episodes should cluster under ONE canonical name.
        // Instead of overriding with the channel name, we find the HIGHEST confidence extraction
        // within this batch and apply it to all episodes.
        if (source.is_single_series && batchToInsert.length > 0) {
           let bestTitle = source.name;
           let maxConf   = 0;
           for (const item of batchToInsert) {
             if (item.parsed.confidence > maxConf && item.parsed.season > 0) {
               maxConf   = item.parsed.confidence;
               bestTitle = item.parsed.seriesTitle;
             }
           }
           for (const item of batchToInsert) {
             item.parsed.seriesTitle = bestTitle;
             // Single series boost so resolver merges aggressively
             item.parsed.confidence = Math.max(item.parsed.confidence, 0.95);
           }
        }

        // ── Bulk insert with identity resolution ───────────────────────────────
        // The transaction covers: canonicalSeries, seriesSources, series, seasons, episodes.
        // All writes happen atomically — no partial states on Android TV.
        if (batchToInsert.length > 0) {
          const resolver = this._getResolver();

          await window.DB.db.transaction(
            'rw',
            window.DB.db.canonicalSeries,
            window.DB.db.seriesSources,
            window.DB.db.series,
            window.DB.db.seasons,
            window.DB.db.episodes,
            async () => {
              for (const item of batchToInsert) {
                // Identity resolution: title → canonical series ID
                // Handles fuzzy matching and cross-source merging via graph checks.
                const canonicalSeriesId = await resolver.resolve(
                  item.parsed.seriesTitle,
                  source.id,
                  item.parsed.confidence,
                  item.parsed.season,
                  item.parsed.episode
                );

                // Season and episode insertion
                const seasonId = await window.DB.getOrCreateSeason(
                  canonicalSeriesId,
                  item.parsed.season
                );

                await window.DB.upsertEpisode(seasonId, item.parsed.episode, item.data);
                totalIndexed++;
              }
            }
          );
        }

        // ── Update progress pill ───────────────────────────────────────────────
        this._setState(source.id, {
          status:    'indexing',
          processed: totalIndexed + skipped,
          total:     totalIndexed + skipped + (hasMore ? 100 : 0),
        });

        if (hasMore) {
          // Early-exit optimization: if this entire batch was already-indexed
          // files with zero new items, the channel is fully caught up.
          if (newInBatch === 0 && skippedInBatch > 0) {
            console.log(`[Indexer] Fully caught up with ${source.name}. Stopping early.`);
            break;
          }
          // Telegram flood-ban protection: pause between pages
          await new Promise(r => setTimeout(r, 1000));
        }
      } // end while(hasMore)

      // ── Done ──────────────────────────────────────────────────────────────────
      this._setState(source.id, {
        status:    'done',
        processed: totalIndexed + skipped,
        total:     totalIndexed + skipped,
      });
      console.log(`[Indexer] Done: ${source.name}. New: ${totalIndexed}, Skipped: ${skipped}.`);

      // ── Fetch channel profile photo (async, non-blocking) ─────────────────────
      // Done AFTER indexing so it doesn't delay the series appearing in the catalog.
      if (!source.photo_base64) {
        try {
          const entity = await window.TGClient.getEntity(channelArg);
          if (entity?.photo) {
            const photo = await window.TGClient.downloadProfilePhoto(entity);
            if (photo) await window.DB.updateSourcePhoto(source.id, photo);
          }
        } catch (e) {
          console.warn('[Indexer] Could not download channel photo:', e.message);
        }
      }

    } catch (e) {
      console.error(`[Indexer] Error during indexing of ${source.name}:`, e);
      this._setState(source.id, {
        status:    'error',
        processed: totalIndexed,
        total:     totalIndexed + skipped,
        error:     e.message,
      });
    }
  }
}

window.AppIndexer = new Indexer();
