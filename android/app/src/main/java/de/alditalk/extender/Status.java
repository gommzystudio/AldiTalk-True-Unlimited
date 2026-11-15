package de.alditalk.extender;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.SharedPreferences;

import java.text.DateFormat;
import java.util.Date;

/** Last run result, shown in the app and as a notification. */
public final class Status {

    private static final String FILE = "status";
    private static final String CHANNEL = "runs";
    private static final int NOTIFICATION_ID = 42;

    private Status() {
    }

    public static void save(Context context, String message) {
        prefs(context).edit()
                .putString("message", message)
                .putLong("at", System.currentTimeMillis())
                .apply();
    }

    public static String get(Context context) {
        SharedPreferences prefs = prefs(context);
        String message = prefs.getString("message", null);
        if (message == null) {
            return "No run recorded yet.";
        }
        long at = prefs.getLong("at", 0L);
        String when = at == 0L
                ? ""
                : " (" + DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT)
                        .format(new Date(at)) + ")";
        return message + when;
    }

    public static void saveAndNotify(Context context, String message) {
        save(context, message);
        try {
            NotificationManager manager =
                    (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager == null) {
                return;
            }
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL, "Booking runs", NotificationManager.IMPORTANCE_LOW);
            manager.createNotificationChannel(channel);
            Notification notification = new Notification.Builder(context, CHANNEL)
                    .setSmallIcon(android.R.drawable.stat_notify_sync)
                    .setContentTitle("ALDI TALK re-booking")
                    .setContentText(message)
                    .setStyle(new Notification.BigTextStyle().bigText(message))
                    .setOngoing(false)
                    .build();
            manager.notify(NOTIFICATION_ID, notification);
        } catch (Exception ignored) {
            // Notifications are best-effort (and need permission on Android 13+).
        }
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }
}
