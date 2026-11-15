package de.alditalk.extender;

import android.app.job.JobParameters;
import android.app.job.JobService;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * One portal run: load the overview, let automation.js do the work, report back.
 *
 * Everything here runs on the main thread (JobService calls back there), which
 * is also what WebView requires.
 */
public class BookingJobService extends JobService {

    private static final String TAG = "AldiTalkJob";
    private static final String PORTAL =
            "https://www.alditalk-kundenportal.de/portal/auth/uebersicht/";
    private static final long HARD_TIMEOUT_MS = 210_000L;
    private static final String DESKTOP_USER_AGENT =
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
                    + "Chrome/141.0.0.0 Safari/537.36";

    private Handler handler;
    private WebView webView;
    private boolean finished;

    @Override
    public boolean onStartJob(JobParameters params) {
        Log.i(TAG, "onStartJob entered");
        handler = new Handler(Looper.getMainLooper());

        SecretStore.Credentials credentials = SecretStore.load(this);
        Log.i(TAG, "credentials loaded: " + (credentials != null));
        if (credentials == null) {
            complete("Not configured - open the app and save your number and password");
            Scheduler.scheduleNext(this, params.getJobId());
            return false; // no work left; do not call jobFinished
        }
        if (!Net.isCellular(this)) {
            complete("Skipped: not on mobile data (the booking must come from the SIM)");
            Scheduler.scheduleNext(this, params.getJobId());
            return false;
        }

        Log.i(TAG, "Starting a portal run");
        try {
            startRun(params, credentials);
        } catch (Throwable error) {
            complete("Could not start the WebView: " + error);
            Scheduler.scheduleNext(this, params.getJobId());
            return false;
        }
        handler.postDelayed(
                () -> finish(params, "Timeout - the portal never produced a result"),
                HARD_TIMEOUT_MS);
        return true; // work continues in the WebView
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        Log.i(TAG, "Stopped by the system before it produced a result");
        finished = true;
        // Keep the previous result visible: a pre-empted run says nothing about
        // the account. Arm the next one-shot in the chain, but never the id that
        // is being stopped right now.
        release();
        Scheduler.scheduleNext(this, params.getJobId());
        return false;
    }

    private void startRun(JobParameters params, SecretStore.Credentials credentials) {
        webView = new WebView(getApplicationContext());

        // An unattached WebView has a 0x0 viewport, and the portal serves a
        // different layout to mobile user agents. Both are fixed here so the
        // DOM matches the desktop structure the selectors expect.
        webView.measure(
                android.view.View.MeasureSpec.makeMeasureSpec(1400, android.view.View.MeasureSpec.EXACTLY),
                android.view.View.MeasureSpec.makeMeasureSpec(1000, android.view.View.MeasureSpec.EXACTLY));
        webView.layout(0, 0, 1400, 1000);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUserAgentString(DESKTOP_USER_AGENT);

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, true);

        webView.addJavascriptInterface(new Bridge(params), "AndroidBridge");
        webView.setWebChromeClient(new android.webkit.WebChromeClient() {
            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage message) {
                Log.i(TAG, "console: " + message.message()
                        + " @" + message.sourceId() + ":" + message.lineNumber());
                return true;
            }
        });
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                Log.i(TAG, "page started: " + url);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                Log.i(TAG, "page finished: " + url);
                // onPageFinished can fire before the new document is ready to
                // accept script, so inject now and once more shortly after. The
                // script is idempotent: it bails out if it is already running.
                inject(view, credentials);
                handler.postDelayed(() -> {
                    if (!finished && webView == view) {
                        inject(view, credentials);
                    }
                }, 3_000L);
                handler.postDelayed(() -> {
                    if (!finished && webView == view) {
                        inject(view, credentials);
                    }
                }, 8_000L);
            }

            @Override
            public void onReceivedError(WebView view, int errorCode, String description,
                                        String failingUrl) {
                Log.w(TAG, "WebView error " + errorCode + " (" + description + ") " + failingUrl);
            }

            @Override
            public void onReceivedHttpError(WebView view, android.webkit.WebResourceRequest request,
                                            android.webkit.WebResourceResponse response) {
                Log.w(TAG, "HTTP " + response.getStatusCode() + " " + request.getUrl());
            }
        });

        webView.loadUrl(PORTAL);
    }

    private void inject(WebView view, SecretStore.Credentials credentials) {
        try {
            JSONObject config = new JSONObject();
            config.put("user", credentials.user);
            config.put("pass", credentials.pass);
            config.put("thresholdMb", Prefs.thresholdMb(this));

            String script = "window.__ALDI_CFG=" + config + ";\n" + readAsset("automation.js");
            view.evaluateJavascript(script, result -> Log.i(TAG, "injected: " + result));
        } catch (Exception error) {
            Log.w(TAG, "Injection failed", error);
        }
    }

    private String readAsset(String name) throws Exception {
        try (InputStream input = getAssets().open(name)) {
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int read;
            while ((read = input.read(chunk)) != -1) {
                buffer.write(chunk, 0, read);
            }
            return buffer.toString(StandardCharsets.UTF_8.name());
        }
    }

    /** Reports arrive on a background thread, so hop to the main thread. */
    private final class Bridge {
        private final JobParameters params;

        Bridge(JobParameters params) {
            this.params = params;
        }

        @JavascriptInterface
        public void report(String json) {
            handler.post(() -> handleReport(params, json));
        }

        /** Called by the page when it is stuck in the anonymous shell. */
        @JavascriptInterface
        public void resetSession() {
            handler.post(BookingJobService.this::clearCookiesAndReload);
        }
    }

    /**
     * Drops every cookie, then reloads the portal so it serves the login form
     * instead of an anonymous dashboard whose BFF calls all 404.
     */
    private void clearCookiesAndReload() {
        CookieManager cookies = CookieManager.getInstance();
        cookies.removeAllCookies(removed -> {
            Log.i(TAG, "Cleared the cookie jar, reloading for a fresh login");
            try {
                cookies.flush();
            } catch (Exception ignored) {
                // best effort
            }
            if (webView != null) {
                webView.stopLoading();
                webView.loadUrl(PORTAL);
            }
        });
    }

    private void handleReport(JobParameters params, String json) {
        if (finished) {
            return;
        }
        try {
            JSONObject report = new JSONObject(json);
            String phase = report.optString("phase", "unknown");
            Log.i(TAG, "phase=" + phase + " " + report);

            switch (phase) {
                case "idle":
                    finish(params, "Nothing to book - "
                            + report.optString("remaining") + " remaining");
                    return;
                case "booked":
                    finish(params, "Booked: " + report.optString("before")
                            + " -> " + report.optString("after"));
                    return;
                case "clicked-unconfirmed":
                    finish(params, "Pressed 1 GB; the portal has not refreshed the counter yet");
                    return;
                case "no-button":
                    finish(params, "No top-up button found ("
                            + report.optString("remaining") + ")");
                    return;
                case "waiting-confirmation":
                    finish(params, report.optBoolean("already")
                            ? "Already pressed 1 GB at " + report.optString("before")
                                    + " - still waiting for the portal to credit it (now "
                                    + report.optString("after") + ")"
                            : "Pressed 1 GB (was " + report.optString("before")
                                    + ") - waiting for the portal counter to update");
                    return;
                case "login-failed":
                    finish(params, "Login failed after " + report.optInt("attempts")
                            + " attempts - check the credentials");
                    return;
                case "timeout":
                    finish(params, "Timed out inside the page at phase "
                            + report.optString("stoppedAt"));
                    return;
                case "error":
                    finish(params, "Page error: " + report.optString("message"));
                    return;
                case "no-portal":
                    finish(params, "The portal never rendered a usable page even after "
                            + "clearing the session - try again later");
                    return;
                default:
                    Status.save(this, "Working: " + phase);
            }
        } catch (Exception error) {
            Log.w(TAG, "Unreadable report: " + json, error);
        }
    }

    private void finish(JobParameters params, String message) {
        if (finished) {
            return;
        }
        finished = true;
        complete(message);
        jobFinished(params, false);
        // Re-arm after jobFinished so the new job cannot replace a live one.
        Scheduler.scheduleNext(this, params.getJobId());
    }

    /** Store + notify the outcome, then let go of the WebView. */
    private void complete(String message) {
        Log.i(TAG, message);
        Status.saveAndNotify(this, message);
        release();
    }

    /** Frees the WebView and pending callbacks without touching the status. */
    private void release() {
        try {
            CookieManager.getInstance().flush();
        } catch (Exception ignored) {
            // cookie flush is best effort
        }
        if (webView != null) {
            try {
                webView.stopLoading();
                webView.destroy();
            } catch (Exception ignored) {
                // view already gone
            }
            webView = null;
        }
        if (handler != null) {
            handler.removeCallbacksAndMessages(null);
        }
    }
}
