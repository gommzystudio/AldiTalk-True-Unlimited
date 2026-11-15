package de.alditalk.extender;

import android.content.Context;
import android.content.SharedPreferences;

public final class Prefs {

    private static final String FILE = "settings";

    /**
     * Below 15 minutes the service chains one-shot jobs instead of using a
     * periodic one, so short values are allowed (useful for testing or for a
     * counter that moves fast).
     */
    private static final int MIN_INTERVAL_MINUTES = 2;

    private Prefs() {
    }

    public static int intervalMinutes(Context context) {
        return Math.max(MIN_INTERVAL_MINUTES, prefs(context).getInt("interval", 15));
    }

    public static int thresholdMb(Context context) {
        return prefs(context).getInt("threshold", 1024);
    }

    public static void save(Context context, int intervalMinutes, int thresholdMb) {
        prefs(context).edit()
                .putInt("interval", Math.max(MIN_INTERVAL_MINUTES, intervalMinutes))
                .putInt("threshold", Math.max(64, Math.min(1024, thresholdMb)))
                .apply();
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }
}
