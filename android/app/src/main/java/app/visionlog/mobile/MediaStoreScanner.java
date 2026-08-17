package app.visionlog.mobile;

import android.content.ContentUris;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.MediaStore;
import java.util.Set;

public final class MediaStoreScanner {
    private static final Set<String> SUPPORTED = Set.of("image/jpeg", "image/png", "image/webp", "image/heic", "image/heif");
    private final Context context;
    private final SyncPreferences preferences;
    private final SyncQueueDb queue;

    public MediaStoreScanner(Context context) {
        this.context = context.getApplicationContext(); preferences = new SyncPreferences(context); queue = new SyncQueueDb(context);
    }

    public int scan() {
        if (PhotoPermission.state(context) != PhotoPermission.State.FULL || !preferences.hasFolder()) return 0;
        long after = Math.max(preferences.importAfterSeconds(), Math.max(0, preferences.checkpointSeconds() - 2));
        String[] projection = { MediaStore.Images.Media._ID, MediaStore.MediaColumns.VOLUME_NAME, MediaStore.MediaColumns.RELATIVE_PATH,
                MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.MIME_TYPE, MediaStore.MediaColumns.SIZE, MediaStore.MediaColumns.DATE_ADDED };
        String selection = MediaStore.MediaColumns.VOLUME_NAME + "=? AND " + MediaStore.MediaColumns.RELATIVE_PATH + " LIKE ? ESCAPE '\\' AND " + MediaStore.MediaColumns.DATE_ADDED + ">=?";
        String prefix = escapeLike(preferences.relativePath()) + "%";
        int found = 0; long checkpoint = preferences.checkpointSeconds();
        try (Cursor cursor = context.getContentResolver().query(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, projection, selection,
                new String[]{ preferences.volume(), prefix, Long.toString(after) }, MediaStore.MediaColumns.DATE_ADDED + " ASC")) {
            if (cursor != null) while (cursor.moveToNext()) {
                long id = cursor.getLong(0); String volume = cursor.getString(1), mime = cursor.getString(4); long added = cursor.getLong(6);
                checkpoint = Math.max(checkpoint, added); if (!SUPPORTED.contains(mime)) continue;
                Uri uri = ContentUris.withAppendedId(MediaStore.Images.Media.getContentUri(volume), id);
                SyncQueueDb.Item item = new SyncQueueDb.Item(); item.sourceId = volume + ":" + id; item.uri = uri.toString();
                item.name = cursor.getString(3); item.mime = mime; item.size = cursor.getLong(5); item.dateAdded = added;
                queue.enqueue(item); found++;
            }
        }
        if (checkpoint > preferences.checkpointSeconds()) preferences.setCheckpointSeconds(checkpoint);
        return found;
    }

    private static String escapeLike(String value) { return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_"); }
}

