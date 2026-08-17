package app.visionlog.mobile;

import android.content.Context;
import android.content.SharedPreferences;

public final class SyncPreferences {
    private static final String FILE = "visionlog_sync";
    private final SharedPreferences preferences;

    public SyncPreferences(Context context) {
        preferences = context.getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    public String serverUrl() { return preferences.getString("server_url", ""); }
    public void setServerUrl(String value) {
        String normalized = value == null ? "" : value.trim().replaceAll("/+$", "");
        preferences.edit().putString("server_url", normalized).apply();
    }
    public String volume() { return preferences.getString("volume", ""); }
    public String relativePath() { return preferences.getString("relative_path", ""); }
    public long importAfterSeconds() { return preferences.getLong("import_after", 0L); }
    public long checkpointSeconds() { return preferences.getLong("checkpoint", importAfterSeconds()); }
    public void setCheckpointSeconds(long value) { preferences.edit().putLong("checkpoint", value).apply(); }
    public boolean hasFolder() { return !volume().isEmpty() && !relativePath().isEmpty(); }
    public void setFolder(String volume, String relativePath, long importAfterSeconds) {
        preferences.edit().putString("volume", volume).putString("relative_path", relativePath)
                .putLong("import_after", importAfterSeconds).putLong("checkpoint", importAfterSeconds).apply();
    }
}

