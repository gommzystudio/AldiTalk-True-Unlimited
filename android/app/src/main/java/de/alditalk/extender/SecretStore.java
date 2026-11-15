package de.alditalk.extender;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Stores the phone number and password encrypted with a key that lives in the
 * Android keystore, so no plaintext credential ends up in shared preferences.
 */
public final class SecretStore {

    private static final String PREFS = "credentials";
    private static final String KEY_BLOB = "blob";
    private static final String KEY_ALIAS = "alditalk-extender-key";

    public static final class Credentials {
        public final String user;
        public final String pass;

        Credentials(String user, String pass) {
            this.user = user;
            this.pass = pass;
        }
    }

    private SecretStore() {
    }

    private static SecretKey key() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        KeyStore.Entry entry = keyStore.getEntry(KEY_ALIAS, null);
        if (entry instanceof KeyStore.SecretKeyEntry) {
            return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build());
        return generator.generateKey();
    }

    public static void save(Context context, String user, String pass) {
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            byte[] iv = cipher.getIV();
            byte[] encrypted = cipher.doFinal((user + "\n" + pass).getBytes(StandardCharsets.UTF_8));
            String blob = Base64.encodeToString(iv, Base64.NO_WRAP)
                    + ":" + Base64.encodeToString(encrypted, Base64.NO_WRAP);
            prefs(context).edit().putString(KEY_BLOB, blob).apply();
        } catch (Exception e) {
            throw new IllegalStateException("Could not store the credentials", e);
        }
    }

    /** Returns null when nothing is stored or the keystore key is gone. */
    public static Credentials load(Context context) {
        String blob = prefs(context).getString(KEY_BLOB, null);
        if (blob == null) {
            return null;
        }
        try {
            int separator = blob.indexOf(':');
            if (separator < 0) {
                return null;
            }
            byte[] iv = Base64.decode(blob.substring(0, separator), Base64.NO_WRAP);
            byte[] encrypted = Base64.decode(blob.substring(separator + 1), Base64.NO_WRAP);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
            String plain = new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);
            int split = plain.indexOf('\n');
            if (split < 0) {
                return null;
            }
            return new Credentials(plain.substring(0, split), plain.substring(split + 1));
        } catch (Exception e) {
            return null;
        }
    }

    public static void clear(Context context) {
        prefs(context).edit().remove(KEY_BLOB).apply();
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
