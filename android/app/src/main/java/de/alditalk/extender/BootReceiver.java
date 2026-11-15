package de.alditalk.extender;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Restores the schedule after a reboot or an app update. */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        boolean relevant = Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action);
        if (!relevant) {
            return;
        }
        if (SecretStore.load(context) == null) {
            return; // not configured yet, nothing to restore
        }
        Scheduler.ensurePeriodic(context);
        Scheduler.scheduleOnce(context);
    }
}
