package com.streamcatz.tv;

import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import java.io.BufferedInputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.URL;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import android.webkit.JavascriptInterface;

import com.streamcatz.tv.plugins.StreamPlayerPlugin;
import com.streamcatz.tv.plugins.UpdateCheckerPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(StreamPlayerPlugin.class);
        registerPlugin(UpdateCheckerPlugin.class);
        super.onCreate(savedInstanceState);
        
        // Add JS Interface for local IP and other bridge needs
        if (getBridge() != null) {
            WebView webview = getBridge().getWebView();
            if (webview != null) {
                webview.addJavascriptInterface(new Object() {
                    @JavascriptInterface
                    public String getLocalIpAddress() {
                        try {
                            List<NetworkInterface> interfaces = Collections.list(NetworkInterface.getNetworkInterfaces());
                            for (NetworkInterface intf : interfaces) {
                                List<InetAddress> addrs = Collections.list(intf.getInetAddresses());
                                for (InetAddress addr : addrs) {
                                    if (!addr.isLoopbackAddress()) {
                                        String sAddr = addr.getHostAddress();
                                        boolean isIPv4 = sAddr.indexOf(':') < 0;
                                        if (isIPv4) return sAddr;
                                    }
                                }
                            }
                        } catch (Exception e) {
                            e.printStackTrace();
                        }
                        return "localhost";
                    }
                }, "AndroidBridge");
            }
        }
    }

    @Override
    public void onBackPressed() {
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().evaluateJavascript("if(window.handleBack) window.handleBack();", null);
        }
    }

    @Override
    public void onPause() {
        super.onPause();
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().onPause();
            getBridge().getWebView().pauseTimers();
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().onResume();
            getBridge().getWebView().resumeTimers();
        }
    }

    @Override
    public void onStart() {
        super.onStart();
        if (getBridge() != null && getBridge().getWebView() != null) {
            WebView webview = getBridge().getWebView();
            webview.setLayerType(android.view.View.LAYER_TYPE_HARDWARE, null);
            WebSettings settings = webview.getSettings();
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
            settings.setMediaPlaybackRequiresUserGesture(false);
            settings.setBlockNetworkLoads(false);
            settings.setDomStorageEnabled(true);

            webview.setWebViewClient(new BridgeWebViewClient(getBridge()) {
// Cleaned up nextbet7 proxy code
            });
        }
    }
}
