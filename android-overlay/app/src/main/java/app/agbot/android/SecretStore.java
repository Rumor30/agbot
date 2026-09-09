// SPDX-License-Identifier: GPL-3.0-or-later
package app.agbot.android;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import org.json.JSONObject;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** All settings (including endpoint tokens) are encrypted; backup is disabled in the manifest. */
public final class SecretStore {
    private static final Object LOCK = new Object();
    private static final String ALIAS = "agbot.settings.v1";
    private final SharedPreferences preferences;
    public SecretStore(Context context) { preferences = context.getSharedPreferences("agbot.sealed", Context.MODE_PRIVATE); }
    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (store.containsAlias(ALIAS)) return (SecretKey) store.getKey(ALIAS, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }
    private JSONObject readUnlocked() throws Exception {
        String value = preferences.getString("data", null);
        if (value == null) return new JSONObject();
        String[] pieces = value.split(":", -1);
        if (pieces.length != 3 || !pieces[0].equals("1")) throw new IOException("Unsupported settings format");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(pieces[1], Base64.NO_WRAP)));
        cipher.updateAAD(ALIAS.getBytes(StandardCharsets.UTF_8));
        return new JSONObject(new String(cipher.doFinal(Base64.decode(pieces[2], Base64.NO_WRAP)), StandardCharsets.UTF_8));
    }
    private void writeUnlocked(JSONObject object) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key());
        cipher.updateAAD(ALIAS.getBytes(StandardCharsets.UTF_8));
        byte[] data = cipher.doFinal(object.toString().getBytes(StandardCharsets.UTF_8));
        String sealed = "1:" + Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":" + Base64.encodeToString(data, Base64.NO_WRAP);
        if (!preferences.edit().putString("data", sealed).commit()) throw new IOException("Could not persist settings");
    }
    public JSONObject read() throws Exception { synchronized(LOCK) { return readUnlocked(); } }
    public void write(JSONObject object) throws Exception { synchronized(LOCK) { readUnlocked(); writeUnlocked(object); } }
    /** Atomic field update across all Activity/Service instances. JSONObject.NULL removes a field. */
    public JSONObject update(JSONObject patch) throws Exception {
        synchronized(LOCK) {
            JSONObject next=readUnlocked();
            java.util.Iterator<String> keys=patch.keys();
            while(keys.hasNext()){String k=keys.next();if(patch.isNull(k))next.remove(k);else next.put(k,patch.get(k));}
            writeUnlocked(next);return new JSONObject(next.toString());
        }
    }

}
