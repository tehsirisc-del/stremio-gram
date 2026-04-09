package com.telestream.tv.plugins;

import android.app.Dialog;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.util.Log;
import android.view.Window;
import android.view.WindowManager;

import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackParameters;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.trackselection.DefaultTrackSelector;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.MediaSource;
import androidx.media3.exoplayer.source.ProgressiveMediaSource;
import androidx.media3.ui.PlayerView;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "StreamPlayer")
public class StreamPlayerPlugin extends Plugin {

    private static final String TAG = "StreamPlayer";
    private ExoPlayer player;
    private PlayerView playerView;
    private Dialog dialog;
    private long pendingSeekTo = 0;
    private long currentSessionId = 0;

    private android.widget.TextView debugTextView;
    private android.widget.ScrollView debugScrollView;

    private android.widget.TextView seekIndicator;
    private Runnable hideSeekIndicatorRunnable;



    private ShareServer shareServer = null;

    private BridgeDataSource currentBridgeDataSource;
    private LocalFeedServer localFeedServer;

    @PluginMethod
    public void play(PluginCall call) {
        final long messageId = Long.parseLong(call.getString("messageId", "0"));
        final String channel = call.getString("channel", "");
        final String title = call.getString("title", "Video");
        
        // Robust numeric extraction: Capacitor often mis-types these as strings/doubles
        // call.getData() returns a JSObject (JSONObject) which has optLong()
        final long fileSize = call.getData().optLong("fileSize", 0L);
        final long seekTo = call.getData().optLong("progress", 0L) * 1000L;
        final long seekStepMs = call.getData().optLong("seekStep", 15L) * 1000L;

        Log.d(TAG, "play() messageId=" + messageId
                + " channel=" + channel + " title=" + title
                + " fileSize=" + fileSize + " seekTo=" + seekTo + " seekStep=" + seekStepMs);

        getActivity().runOnUiThread(() -> {
            try {
                currentSessionId++;
                releasePlayer(true); // Is transitioning so we skip player_closed event
                setupPlayerAndDialog(channel, messageId, fileSize, title, seekTo, seekStepMs, currentSessionId);
                call.resolve();
            } catch (Exception e) {
                Log.e(TAG, "setupPlayerAndDialog failed", e);
                call.reject(e.getMessage());
            }
        });
    }

    @PluginMethod
    public void provideChunk(PluginCall call) {
        // Obsolete: Replaced by local HTTP streaming
        JSObject ret = new JSObject();
        ret.put("accepted", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void close(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            releasePlayer(false); // Explicit close by user
            call.resolve();
        });
    }

    @PluginMethod
    public void startShareServer(PluginCall call) {
        String token = call.getString("token", "");
        if (shareServer != null) {
            shareServer.stopServer();
        }
        shareServer = new ShareServer(token);
        shareServer.start();
        call.resolve();
    }

    @PluginMethod
    public void stopShareServer(PluginCall call) {
        if (shareServer != null) {
            shareServer.stopServer();
            shareServer = null;
        }
        if (call != null)
            call.resolve();
    }

    @PluginMethod
    public void logToNative(PluginCall call) {
        String msg = call.getString("msg", "");
        String level = call.getString("level", "info");
        updateNativeDebug("[" + level.toUpperCase() + "] " + msg);
        call.resolve();
    }

    public void updateNativeDebug(final String text) {
        getActivity().runOnUiThread(() -> {
            if (debugTextView != null) {
                String time = new java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US)
                        .format(new java.util.Date());
                debugTextView.append("[" + time + "] " + text + "\n");
                debugScrollView.post(() -> debugScrollView.fullScroll(android.view.View.FOCUS_DOWN));
            }
        });
    }



    private void releasePlayer(boolean isTransitioning) {
        long finalPos = 0;
        long finalDur = 0;

        if (currentBridgeDataSource != null) {
            currentBridgeDataSource.stopJsStream(); // Unblocks any indefinitely hanging read() loop immediately
            currentBridgeDataSource = null;
        }

        if (player != null) {
            finalPos = player.getCurrentPosition();
            finalDur = player.getDuration();
            player.stop();
            player.release();
            player = null;
        }

        if (dialog != null) {
            dialog.setOnDismissListener(null);
            dialog.dismiss();
            dialog = null;
        }

        if (!isTransitioning) {
            try {
                // Return exact stop position to JS before the player is destroyed
                JSObject data = new JSObject();
                data.put("progress", finalPos);
                data.put("duration", finalDur);
                emitEvent("player_closed", data);
            } catch (Exception e) {}
        }

        if (localFeedServer != null) {
            localFeedServer.stopServer();
            localFeedServer = null;
        }
        if (hideSeekIndicatorRunnable != null && getContext() != null) {
            // Cleanup any pending UI hide
        }
    }

    private void setupPlayerAndDialog(String channel, long messageId, long fileSize, String title,
            long seekTo, long seekStepMs, long sessionId) {
        Log.d(TAG, "setupPlayerAndDialog title=" + title);

        // ── Full-screen dialog ──────────────────────────────────────────────────
        dialog = new Dialog(getContext(), android.R.style.Theme_Black_NoTitleBar_Fullscreen);

        android.widget.FrameLayout rootLayout = new android.widget.FrameLayout(getContext());
        playerView = new PlayerView(getContext());
        rootLayout.addView(playerView);

        // ── Native Debug Console ────────────────────────────────────────────────
        debugScrollView = new android.widget.ScrollView(getContext());
        debugScrollView.setLayoutParams(new android.widget.FrameLayout.LayoutParams(
                (int) (getContext().getResources().getDisplayMetrics().widthPixels * 0.45),
                (int) (getContext().getResources().getDisplayMetrics().heightPixels * 0.6)));
        debugScrollView.setBackgroundColor(Color.argb(200, 0, 0, 0));
        debugScrollView.setPadding(20, 20, 20, 20);
        debugScrollView.setVisibility(android.view.View.GONE); // Default off

        debugTextView = new android.widget.TextView(getContext());
        debugTextView.setTextColor(Color.GREEN);
        debugTextView.setTypeface(android.graphics.Typeface.MONOSPACE);
        debugTextView.setTextSize(10);
        debugTextView.setText("--- Native Debug Console ---\n");
        debugTextView.append("Device: " + android.os.Build.MODEL + "\n");
        debugScrollView.addView(debugTextView);
        rootLayout.addView(debugScrollView);

        // Progress feedback setup moved below to be internal to playerView

        hideSeekIndicatorRunnable = () -> {
            if (seekIndicator != null) {
                seekIndicator.animate().alpha(0f).scaleX(0.8f).scaleY(0.8f).setDuration(250).withEndAction(() -> {
                    seekIndicator.setVisibility(android.view.View.GONE);
                }).start();
            }
        };


        // ── Integrated Debug Icon (Inside PlayerView) ────────────────────────
        android.widget.ImageButton debugIcon = new android.widget.ImageButton(getContext());
        debugIcon.setImageResource(android.R.drawable.ic_menu_info_details);
        debugIcon.setBackgroundColor(Color.TRANSPARENT);
        debugIcon.setAlpha(0.5f);
        debugIcon.setFocusable(true);
        debugIcon.setPadding(20, 20, 20, 20);
        android.widget.FrameLayout.LayoutParams bugParams = new android.widget.FrameLayout.LayoutParams(
                120, 120);
        bugParams.gravity = android.view.Gravity.TOP | android.view.Gravity.RIGHT;
        bugParams.setMargins(0, 40, 40, 0);
        debugIcon.setLayoutParams(bugParams);
        
        debugIcon.setOnClickListener(v -> {
            int vis = debugScrollView.getVisibility() == android.view.View.VISIBLE ? android.view.View.GONE
                    : android.view.View.VISIBLE;
            debugScrollView.setVisibility(vis);
        });
        
        debugIcon.setOnFocusChangeListener((v, hasFocus) -> {
            debugIcon.setAlpha(hasFocus ? 1.0f : 0.5f);
            debugIcon.setScaleX(hasFocus ? 1.2f : 1.0f);
            debugIcon.setScaleY(hasFocus ? 1.2f : 1.0f);
        });
        
        playerView.addView(debugIcon);

        // Visibility sync: Show debug button only when controller is visible
        playerView.setControllerVisibilityListener(new PlayerView.ControllerVisibilityListener() {
            @Override
            public void onVisibilityChanged(int visibility) {
                debugIcon.setVisibility(visibility);
            }
        });

        // ── "Internal" Seek Indicator (Inside PlayerView) ──────────────────────
        seekIndicator = new android.widget.TextView(getContext());
        seekIndicator.setTextSize(36);
        seekIndicator.setTextColor(Color.WHITE);
        seekIndicator.setPadding(60, 30, 60, 30);
        seekIndicator.setGravity(android.view.Gravity.CENTER);
        android.graphics.drawable.GradientDrawable pill = new android.graphics.drawable.GradientDrawable();
        pill.setColor(Color.argb(230, 0, 0, 0)); // Darker for high contrast
        pill.setCornerRadius(100f); 
        seekIndicator.setBackground(pill);
        
        android.widget.FrameLayout.LayoutParams seekParams = new android.widget.FrameLayout.LayoutParams(
                WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT);
        seekParams.gravity = android.view.Gravity.CENTER;
        seekIndicator.setLayoutParams(seekParams);
        seekIndicator.setVisibility(android.view.View.GONE);
        seekIndicator.setZ(999f); 
        playerView.addView(seekIndicator);

        dialog.setContentView(rootLayout);

        Window window = dialog.getWindow();
        if (window != null) {
            window.setLayout(WindowManager.LayoutParams.MATCH_PARENT,
                    WindowManager.LayoutParams.MATCH_PARENT);
            window.setBackgroundDrawable(new ColorDrawable(Color.BLACK));
        }

        // ── HIGH-PERFORMANCE LoadControl ────────────────────────────────────────
        // bufferForPlaybackMs=3000: gives the demuxer time to find BOTH audio+video
        // track headers before playback begins → eliminates A/V desync.
        DefaultLoadControl loadControl = new DefaultLoadControl.Builder()
                .setBufferDurationsMs(
                        30_000, // minBufferMs — 30s
                        120_000, // maxBufferMs — 120s
                        3_000, // bufferForPlaybackMs 
                        5_000 // bufferForPlaybackAfterRebufferMs
                )
                .setTargetBufferBytes(100 * 1024 * 1024) // 100MB RAM Target to prevent progressive starvation
                .setPrioritizeTimeOverSizeThresholds(true)
                .build();

        // ── Hardware & Sync Fixes ───────────────────────────────────────────────
        DefaultRenderersFactory renderersFactory = new DefaultRenderersFactory(getContext())
                .setEnableDecoderFallback(true); // Robustness: Allow software fallback to prevent black screens on hardware failure

        DefaultTrackSelector trackSelector = new DefaultTrackSelector(getContext());
        // Disabling Tunneling to prevent hardware sync hangs on resume/seek for non-4K content
        trackSelector.setParameters(trackSelector.buildUponParameters().setTunnelingEnabled(false));

        // ── ExoPlayer ───────────────────────────────────────────────────────────
        player = new ExoPlayer.Builder(getContext())
                .setRenderersFactory(renderersFactory)
                .setTrackSelector(trackSelector)
                .setLoadControl(loadControl)
                .setSeekParameters(androidx.media3.exoplayer.SeekParameters.CLOSEST_SYNC) // Snap to keyframes for robust resuming
                .setSeekForwardIncrementMs(seekStepMs)
                .setSeekBackIncrementMs(seekStepMs)
                .build();

        // Enforce strict 1.0x playback speed without pitch bending algorithms which can skew sync over time
        player.setPlaybackParameters(new PlaybackParameters(1.0f, 1.0f));

        player.addListener(new androidx.media3.common.Player.Listener() {
            @Override
            public void onPlayerError(androidx.media3.common.PlaybackException error) {
                updateNativeDebug("PLAYER_ERROR: " + error.getMessage() + " (" + error.getErrorCodeName() + ")");
                Log.e(TAG, "ExoPlayer Error: " + error.getMessage(), error);
            }

            @Override
            public void onPlaybackStateChanged(int playbackState) {
                String state = "UNKNOWN";
                android.view.View playPauseBtn = playerView.findViewById(androidx.media3.ui.R.id.exo_center_controls);
                if (playPauseBtn == null) playPauseBtn = playerView.findViewById(androidx.media3.ui.R.id.exo_play_pause);

                if (playbackState == androidx.media3.common.Player.STATE_BUFFERING) {
                    state = "BUFFERING";
                    if (playPauseBtn != null) playPauseBtn.setVisibility(android.view.View.INVISIBLE);
                } else {
                    if (playPauseBtn != null) playPauseBtn.setVisibility(android.view.View.VISIBLE);
                }

                if (playbackState == androidx.media3.common.Player.STATE_READY)
                    state = "READY";
                if (playbackState == androidx.media3.common.Player.STATE_ENDED) {
                    state = "ENDED";
                    // Notify JS that the video naturally finished.
                    // This is handled by a listener in index.html, not by playNextEpisode logic!
                    emitEvent("player_ended", new JSObject());
                }
                updateNativeDebug("PlaybackState: " + state);
            }
        });

        playerView.setPlayer(player);
        playerView.setUseController(true);
        playerView.setShowBuffering(PlayerView.SHOW_BUFFERING_ALWAYS);
        playerView.requestFocus();

        // Apply TimeBar appearance IMMEDIATELY at open, not on first key press.
        // This ensures focus colors are correct from the very first user interaction.
        playerView.post(() -> {
            android.view.View timeBarView = playerView.findViewById(androidx.media3.ui.R.id.exo_progress);
            if (timeBarView instanceof androidx.media3.ui.DefaultTimeBar) {
                androidx.media3.ui.DefaultTimeBar dtb = (androidx.media3.ui.DefaultTimeBar) timeBarView;
                dtb.setKeyTimeIncrement(seekStepMs);
                // Default (unfocused) state: muted blue played bar, invisible scrubber
                dtb.setPlayedColor(Color.parseColor("#3B82F6"));
                dtb.setScrubberColor(Color.TRANSPARENT);
                dtb.setUnplayedColor(Color.argb(50, 255, 255, 255));

                timeBarView.setOnFocusChangeListener((v2, hasFocus) -> {
                    // Focused: white bar + visible white scrubber (Big Tech style)
                    dtb.setPlayedColor(hasFocus ? Color.WHITE : Color.parseColor("#3B82F6"));
                    dtb.setScrubberColor(hasFocus ? Color.WHITE : Color.TRANSPARENT);
                    dtb.setUnplayedColor(hasFocus ? Color.argb(100, 255, 255, 255) : Color.argb(50, 255, 255, 255));
                });
            }
        });

        // Toggle debug console
        playerView.setOnKeyListener((v, keyCode, event) -> {
            boolean isDown = event.getAction() == android.view.KeyEvent.ACTION_DOWN;
            if (isDown && (keyCode == android.view.KeyEvent.KEYCODE_DPAD_UP || keyCode == android.view.KeyEvent.KEYCODE_MENU)) {
                if (debugScrollView != null) {
                    int vis = debugScrollView.getVisibility() == android.view.View.VISIBLE ? android.view.View.GONE
                            : android.view.View.VISIBLE;
                    debugScrollView.setVisibility(vis);
                    return true;
                }
            }
            return false;
        });

        // Remote Controls and Back button behavior
        dialog.setOnKeyListener((dialogInterface, keyCode, event) -> {
            boolean isDown = event.getAction() == android.view.KeyEvent.ACTION_DOWN;
            boolean isUp = event.getAction() == android.view.KeyEvent.ACTION_UP;

            if (isDown && player != null) {
                if (!playerView.isControllerFullyVisible()) {
                    if (keyCode == android.view.KeyEvent.KEYCODE_DPAD_CENTER || keyCode == android.view.KeyEvent.KEYCODE_ENTER) {
                        player.setPlayWhenReady(!player.getPlayWhenReady());
                        playerView.showController();
                        return true;
                    } else if (keyCode == android.view.KeyEvent.KEYCODE_DPAD_LEFT || keyCode == android.view.KeyEvent.KEYCODE_DPAD_RIGHT) {
                        playerView.showController();
                        android.view.View timeBar = playerView.findViewById(androidx.media3.ui.R.id.exo_progress);
                        
                        // Seek Feedback Pop-up
                        if (seekIndicator != null) {
                            String direction = (keyCode == android.view.KeyEvent.KEYCODE_DPAD_LEFT) ? "« -" : "+ »";
                            seekIndicator.setText(direction + (seekStepMs / 1000) + "s");
                            
                            // Dynamic positioning based on direction
                            android.widget.FrameLayout.LayoutParams lp = (android.widget.FrameLayout.LayoutParams) seekIndicator.getLayoutParams();
                            if (keyCode == android.view.KeyEvent.KEYCODE_DPAD_LEFT) {
                                lp.gravity = android.view.Gravity.CENTER_VERTICAL | android.view.Gravity.LEFT;
                                lp.setMargins(120, 0, 0, 0);
                            } else {
                                lp.gravity = android.view.Gravity.CENTER_VERTICAL | android.view.Gravity.RIGHT;
                                lp.setMargins(0, 0, 120, 0);
                            }
                            seekIndicator.setLayoutParams(lp);

                            seekIndicator.setVisibility(android.view.View.VISIBLE);
                            seekIndicator.setAlpha(0f);
                            seekIndicator.setScaleX(0.7f);
                            seekIndicator.setScaleY(0.7f);
                            seekIndicator.animate().alpha(1f).scaleX(1.1f).scaleY(1.1f)
                                .setDuration(150).withEndAction(() -> {
                                    seekIndicator.animate().scaleX(1.0f).scaleY(1.0f).setDuration(100).start();
                                }).start();
                            seekIndicator.removeCallbacks(hideSeekIndicatorRunnable);
                            seekIndicator.postDelayed(hideSeekIndicatorRunnable, 1200);
                        }

                        if (timeBar != null) {
                            if (timeBar instanceof androidx.media3.ui.DefaultTimeBar) {
                                // Just ensure key increment is set with latest seekStepMs value
                                ((androidx.media3.ui.DefaultTimeBar) timeBar).setKeyTimeIncrement(seekStepMs);
                            }
                            timeBar.requestFocus();
                            timeBar.dispatchKeyEvent(event);
                        }
                        return true;
                    }
                }
            }

            if (isUp && keyCode == android.view.KeyEvent.KEYCODE_BACK) {
                if (playerView != null && playerView.isControllerFullyVisible()) {
                    playerView.hideController();
                    return true;
                }
            }
            return false;
        });

        // ── DataSource (Bridge + LocalFeedServer) ─────────────────────────
        currentBridgeDataSource = new BridgeDataSource(this, channel, messageId, fileSize);

        localFeedServer = new LocalFeedServer();
        localFeedServer.setActiveDataSource(currentBridgeDataSource);
        localFeedServer.start();

        // 🛑 REMOVED ExoCacheManager to prevent I/O disk bottlenecks on cheap TV eMMC flash drives!
        // Writing a multi-gigabyte video stream to disk while decoding causes fatal I/O stalls and A/V desync.
        androidx.media3.datasource.DataSource.Factory dataSourceFactory = () -> currentBridgeDataSource;

        MediaSource mediaSource = new ProgressiveMediaSource.Factory(dataSourceFactory)
                .createMediaSource(MediaItem.fromUri(currentBridgeDataSource.getUri()));

        player.setMediaSource(mediaSource, seekTo); // Media3 hint
        player.prepare();
        
        // Robust Seek Backup: Some sources ignore the startPosition in setMediaSource.
        // We track it and re-apply when the player reports STATE_READY.
        this.pendingSeekTo = seekTo;
        
        player.addListener(new androidx.media3.common.Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int playbackState) {
                if (playbackState == androidx.media3.common.Player.STATE_READY && pendingSeekTo > 0) {
                    Log.d(TAG, "[TELESTREAM_DEBUG] STATE_READY: Applying pending seek to " + pendingSeekTo + "ms");
                    player.seekTo(pendingSeekTo);
                    pendingSeekTo = 0; // Clear so it doesn't seek again on buffer/pause
                }
            }
        });
        
        player.setPlayWhenReady(true);

        // ── Dialog lifecycle ────────────────────────────────────────────────────
        final ExoPlayer thisPlayer = player;

        dialog.setOnDismissListener(d -> {
            Log.d(TAG, "dialog dismissed — releasing player (Session " + sessionId + ")");

            long currentPos = 0;
            long currentDur = 0;
            if (thisPlayer != null) {
                // Sanitize: ExoPlayer returns TIME_UNSET (-huge number) if not ready.
                // Clamping to 0 prevents garbage values in the database.
                currentPos = Math.max(0, thisPlayer.getCurrentPosition());
                currentDur = Math.max(0, thisPlayer.getDuration());
            }

            if (player == thisPlayer) {
                player = null;
            }
            if (thisPlayer != null) {
                thisPlayer.release();
            }

            // Only fire if it's the current session.
            if (sessionId == currentSessionId) {
                // ADB-Only Debug
                Log.d(TAG, "[TELESTREAM_DEBUG] Player closing. Session=" + sessionId + " Pos=" + currentPos + " Dur=" + currentDur);
                
                JSObject data = new JSObject();
                data.put("progress", currentPos);
                data.put("duration", currentDur);
                emitEvent("player_closed", data);
            }
        });

        dialog.show();
    }

    public void emitEvent(String eventName, JSObject data) {
        notifyListeners(eventName, data);
    }

    /** Helper for debugging on-screen. */
    public void emitDebug(String msg, String level) {
        JSObject data = new JSObject();
        data.put("msg", msg);
        data.put("level", level);
        emitEvent("debug_event", data);
    }

    /**
     * Minimal On-Demand HTTP Server to handle "Share Link from Phone".
     * Serves an embedded HTML page and accepts link submissions via POST.
     */
    private class ShareServer extends Thread {
        private final String token;
        private ServerSocket serverSocket;
        private boolean running = true;
        private final ExecutorService executor = Executors.newFixedThreadPool(2);

        public ShareServer(String token) {
            this.token = token;
        }

        public void stopServer() {
            running = false;
            try {
                if (serverSocket != null)
                    serverSocket.close();
            } catch (Exception ignored) {
            }
            executor.shutdownNow();
        }

        @Override
        public void run() {
            try {
                serverSocket = new ServerSocket(9991);
                Log.d(TAG, "ShareServer started on port 9991. Token=" + token);
                while (running) {
                    Socket client = serverSocket.accept();
                    executor.execute(() -> handleClient(client));
                }
            } catch (Exception e) {
                if (running)
                    Log.e(TAG, "ShareServer Error: " + e.getMessage());
            }
        }

        private void handleClient(Socket socket) {
            try (BufferedReader in = new BufferedReader(new InputStreamReader(socket.getInputStream()));
                    BufferedWriter out = new BufferedWriter(new OutputStreamWriter(socket.getOutputStream()))) {

                String line = in.readLine();
                if (line == null)
                    return;

                String[] parts = line.split(" ");
                if (parts.length < 2)
                    return;

                String method = parts[0];
                String path = parts[1];

                int contentLength = 0;
                // Parse headers
                while ((line = in.readLine()) != null && !line.isEmpty()) {
                    if (line.toLowerCase().startsWith("content-length:")) {
                        contentLength = Integer.parseInt(line.substring(15).trim());
                    }
                }

                if (method.equals("OPTIONS")) {
                    sendResponse(out, 200, "text/plain", "");
                    return;
                }

                if (path.contains("favicon.ico")) {
                    sendResponse(out, 404, "text/plain", "");
                    return;
                }

                if (method.equals("GET") && path.startsWith("/share.html")) {
                    sendResponse(out, 200, "text/html", getShareHtml());
                } else if (method.equals("POST") && path.equals("/api/share/submit")) {
                    char[] bodyChars = new char[contentLength];
                    int read = 0;
                    while (read < contentLength) {
                        int r = in.read(bodyChars, read, contentLength - read);
                        if (r == -1)
                            break;
                        read += r;
                    }

                    String payload = new String(bodyChars);
                    if (payload.contains("\"token\":\"" + token + "\"")) {
                        int linkIdx = payload.indexOf("\"link\":\"");
                        if (linkIdx != -1) {
                            String link = payload.substring(linkIdx + 8, payload.indexOf("\"", linkIdx + 8));
                            JSObject data = new JSObject();
                            data.put("link", link);
                            if (StreamPlayerPlugin.this.bridge != null) {
                                StreamPlayerPlugin.this.bridge.triggerWindowJSEvent("link_shared", data.toString());
                            }
                            sendResponse(out, 200, "application/json", "{\"success\":true}");
                        } else {
                            sendResponse(out, 400, "application/json", "{\"error\":\"Missing link\"}");
                        }
                    } else {
                        sendResponse(out, 403, "application/json", "{\"error\":\"Invalid token\"}");
                    }
                } else {
                    sendResponse(out, 404, "text/plain", "Not Found");
                }
            } catch (Exception e) {
                Log.e(TAG, "Socket Error: " + e.getMessage());
            } finally {
                try {
                    socket.close();
                } catch (Exception ignored) {
                }
            }
        }

        private void sendResponse(BufferedWriter out, int code, String type, String body) throws Exception {
            out.write("HTTP/1.1 " + code + (code == 200 ? " OK" : " Error") + "\r\n");
            out.write("Content-Type: " + type + "; charset=utf-8\r\n");
            out.write("Content-Length: " + body.getBytes("UTF-8").length + "\r\n");
            out.write("Access-Control-Allow-Origin: *\r\n");
            out.write("Connection: close\r\n");
            out.write("\r\n");
            out.write(body);
            out.flush();
        }

        private String getShareHtml() {
            // Embedded minimal version of share.html for standalone operation
            return "<!DOCTYPE html><html><head>" +
                    "<meta charset='UTF-8'><meta name='viewport' content='width=device-width,initial-scale=1'>" +
                    "<title>Send to Screen</title>" +
                    "<style>body{background:#0f172a;color:#fff;font-family:sans-serif;text-align:center;padding:40px 20px;}"
                    +
                    "h1{color:#38bdf8;}input{width:100%;padding:15px;border-radius:8px;border:1px solid #334155;background:#1e293b;color:#fff;margin:20px 0;}"
                    +
                    "button{width:100%;padding:15px;border-radius:8px;background:#3b82f6;color:#fff;border:none;font-weight:bold;}</style></head>"
                    +
                    "<body><h1>📱 Send to Screen</h1><p>Paste Link:</p>" +
                    "<input id='l' placeholder='https://t.me/...'><button id='b'>Send Link</button>" +
                    "<script>document.getElementById('b').onclick=async()=>{ " +
                    "const l=document.getElementById('l').value; const t=new URLSearchParams(window.location.search).get('token');"
                    +
                    "document.getElementById('b').disabled=true; document.getElementById('b').innerText='Sending...';" +
                    "try{ const r=await fetch('/api/share/submit',{method:'POST',body:JSON.stringify({token:t,link:l})});"
                    +
                    "if(r.ok) alert('Sent!'); else alert('Failed'); }catch(e){alert(e);}" +
                    "document.getElementById('b').disabled=false; document.getElementById('b').innerText='Send Link'; };"
                    +
                    "</script></body></html>";
        }
    }
}
