package app.visionlog.mobile;

import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.provider.MediaStore;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Locale;

public final class FolderRepository {
    public static final class Folder {
        public final String volume;
        public final String relativePath;
        public int count;
        Folder(String volume, String relativePath) { this.volume = volume; this.relativePath = relativePath; this.count = 1; }
        public String label() { return relativePath + "  ·  " + count + " 张"; }
    }

    private final Context context;
    public FolderRepository(Context context) { this.context = context.getApplicationContext(); }

    public List<Folder> list() {
        Map<String, Folder> folders = new LinkedHashMap<>();
        String[] projection = { MediaStore.MediaColumns.VOLUME_NAME, MediaStore.MediaColumns.RELATIVE_PATH };
        try (Cursor cursor = context.getContentResolver().query(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI, projection,
                MediaStore.MediaColumns.RELATIVE_PATH + " IS NOT NULL", null,
                MediaStore.MediaColumns.DATE_ADDED + " DESC")) {
            if (cursor != null) while (cursor.moveToNext()) {
                String volume = cursor.getString(0), path = cursor.getString(1);
                if (volume == null || path == null || path.isBlank()) continue;
                String key = volume + "\n" + path;
                Folder folder = folders.get(key);
                if (folder == null) folders.put(key, new Folder(volume, path)); else folder.count++;
            }
        }
        List<Folder> result = new ArrayList<>(folders.values());
        result.sort(Comparator.comparing(folder -> folder.relativePath.toLowerCase(Locale.ROOT)));
        return result;
    }
}
