package de.alditalk.extender;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;

/**
 * The portal only accepts a re-booking that arrives over the SIM's own
 * connection, so refuse to run on Wi-Fi.
 */
public final class Net {

    private Net() {
    }

    public static boolean isCellular(Context context) {
        ConnectivityManager manager =
                (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (manager == null) {
            return false;
        }
        Network active = manager.getActiveNetwork();
        if (active == null) {
            return false;
        }
        NetworkCapabilities capabilities = manager.getNetworkCapabilities(active);
        return capabilities != null
                && capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR);
    }
}
