package com.streamcatz.tv.plugins;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "UpdateChecker")
public class UpdateCheckerPlugin extends Plugin {

    private static final String TAG = "UpdateCheckerPlugin";
    private static final String REPO_OWNER = "tehsirisc-del";
    private static final String REPO_NAME = "stremio-gram";

    private ExecutorService executorService;
    private Handler mainHandler;

    @Override
    public void load() {
        executorService = Executors.newSingleThreadExecutor();
        mainHandler = new Handler(Looper.getMainLooper());
    }

    @PluginMethod
    public void checkForUpdate(PluginCall call) {
        String currentVersion = "1.0.0";
        try {
            // Get versionName from package manager ideally, but we know it's hardcoded to 1.0.0 currently
            Context ctx = getContext();
            currentVersion = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0).versionName;
        } catch (Exception e) {
            Log.e(TAG, "Could not get version name", e);
        }

        final String finalCurrentVersion = currentVersion;

        executorService.execute(() -> {
            try {
                URL url = new URL("https://api.github.com/repos/" + REPO_OWNER + "/" + REPO_NAME + "/releases/latest");
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("GET");
                conn.setRequestProperty("Accept", "application/vnd.github.v3+json");
                conn.setConnectTimeout(10000);
                conn.setReadTimeout(10000);

                int respCode = conn.getResponseCode();
                if (respCode != 200) {
                    mainHandler.post(() -> call.reject("SERVER_ERROR", "HTTP " + respCode));
                    return;
                }

                BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream()));
                StringBuilder response = new StringBuilder();
                String line;
                while ((line = reader.readLine()) != null) {
                    response.append(line);
                }
                reader.close();

                JSONObject json = new JSONObject(response.toString());
                String tagName = json.optString("tag_name", "");
                String latestVersion = tagName.replace("v", "");
                String changelog = json.optString("body", "");

                JSONArray assets = json.optJSONArray("assets");
                String downloadUrl = "";
                if (assets != null && assets.length() > 0) {
                    downloadUrl = assets.getJSONObject(0).optString("browser_download_url", "");
                }

                boolean updateAvailable = compareVersions(latestVersion, finalCurrentVersion) > 0;

                JSObject result = new JSObject();
                result.put("updateAvailable", updateAvailable);
                result.put("latestVersion", latestVersion);
                result.put("currentVersion", finalCurrentVersion);
                result.put("downloadUrl", downloadUrl);
                result.put("changelog", changelog);

                mainHandler.post(() -> call.resolve(result));

            } catch (Exception e) {
                Log.e(TAG, "Error checking update", e);
                mainHandler.post(() -> call.reject("FETCH_ERROR", e.getMessage()));
            }
        });
    }

    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        String downloadUrl = call.getString("downloadUrl");
        if (downloadUrl == null || downloadUrl.isEmpty()) {
            call.reject("INVALID_URL");
            return;
        }

        executorService.execute(() -> {
            try {
                URL url = new URL(downloadUrl);
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.connect();

                int downRespCode = conn.getResponseCode();
                if (downRespCode != HttpURLConnection.HTTP_OK) {
                    mainHandler.post(() -> call.reject("DOWNLOAD_ERROR", "Server returned HTTP " + downRespCode));
                    return;
                }

                int fileLength = conn.getContentLength();
                
                File updateDir = new File(getContext().getExternalCacheDir(), "apk_updates");
                if (!updateDir.exists()) {
                    updateDir.mkdirs();
                }

                File outputFile = new File(updateDir, "update.apk");
                if (outputFile.exists()) {
                    outputFile.delete();
                }

                InputStream input = new BufferedInputStream(url.openStream(), 8192);
                FileOutputStream output = new FileOutputStream(outputFile);

                byte[] data = new byte[8192];
                long total = 0;
                int count;
                long lastEventTime = 0;

                while ((count = input.read(data)) != -1) {
                    total += count;
                    output.write(data, 0, count);

                    long currentTime = System.currentTimeMillis();
                    if (fileLength > 0 && (currentTime - lastEventTime > 500)) {
                        int progress = (int) (total * 100 / fileLength);
                        JSObject progressData = new JSObject();
                        progressData.put("progress", progress);
                        notifyListeners("download_progress", progressData);
                        lastEventTime = currentTime;
                    }
                }

                output.flush();
                output.close();
                input.close();

                JSObject finishData = new JSObject();
                finishData.put("progress", 100);
                notifyListeners("download_progress", finishData);

                // Install APK
                Uri apkUri = FileProvider.getUriForFile(
                        getContext(),
                        getContext().getPackageName() + ".fileprovider",
                        outputFile
                );

                Intent intent = new Intent(Intent.ACTION_VIEW);
                intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);

                mainHandler.post(() -> call.resolve());

            } catch (Exception e) {
                Log.e(TAG, "Download error", e);
                mainHandler.post(() -> call.reject("DOWNLOAD_ERROR", e.getMessage()));
            }
        });
    }

    /**
     * Compares two semver strings like "1.1.0" and "1.0.0".
     * @return 1 if v1 > v2, -1 if v1 < v2, 0 if equal.
     */
    private int compareVersions(String v1, String v2) {
        String[] parts1 = v1.split("\\.");
        String[] parts2 = v2.split("\\.");
        int length = Math.max(parts1.length, parts2.length);
        for (int i = 0; i < length; i++) {
            int p1 = i < parts1.length ? Integer.parseInt(parts1[i]) : 0;
            int p2 = i < parts2.length ? Integer.parseInt(parts2[i]) : 0;
            if (p1 > p2) return 1;
            if (p1 < p2) return -1;
        }
        return 0;
    }
}
