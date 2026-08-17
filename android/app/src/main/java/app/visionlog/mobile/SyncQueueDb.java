package app.visionlog.mobile;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

public final class SyncQueueDb extends SQLiteOpenHelper {
    public static final class Item {
        public String sourceId, uri, name, mime;
        public long size, dateAdded;
        public int attempts;
    }

    public SyncQueueDb(Context context) { super(context, "visionlog-sync.sqlite", null, 1); }

    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE queue(source_id TEXT PRIMARY KEY,uri TEXT NOT NULL,name TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER,date_added INTEGER,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT,updated_at INTEGER NOT NULL)");
        db.execSQL("CREATE INDEX queue_state ON queue(state,attempts,date_added)");
    }
    @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {}

    public void enqueue(Item item) {
        ContentValues values = new ContentValues(); values.put("source_id", item.sourceId); values.put("uri", item.uri);
        values.put("name", item.name); values.put("mime", item.mime); values.put("size", item.size); values.put("date_added", item.dateAdded);
        values.put("state", "pending"); values.put("updated_at", System.currentTimeMillis());
        getWritableDatabase().insertWithOnConflict("queue", null, values, SQLiteDatabase.CONFLICT_IGNORE);
    }

    public Item next() {
        try (Cursor c = getReadableDatabase().query("queue", null, "state IN ('pending','retry') AND attempts<5", null, null, null, "date_added ASC", "1")) {
            if (!c.moveToFirst()) return null;
            Item item = new Item(); item.sourceId = c.getString(c.getColumnIndexOrThrow("source_id"));
            item.uri = c.getString(c.getColumnIndexOrThrow("uri")); item.name = c.getString(c.getColumnIndexOrThrow("name"));
            item.mime = c.getString(c.getColumnIndexOrThrow("mime")); item.size = c.getLong(c.getColumnIndexOrThrow("size"));
            item.dateAdded = c.getLong(c.getColumnIndexOrThrow("date_added")); item.attempts = c.getInt(c.getColumnIndexOrThrow("attempts")); return item;
        }
    }

    public void markUploading(String id) { update(id, "uploading", null, true); }
    public void markUploaded(String id) { update(id, "uploaded", null, false); }
    public void markFailure(String id, String error) { update(id, "retry", error, false); }
    private void update(String id, String state, String error, boolean increment) {
        ContentValues values = new ContentValues(); values.put("state", state); values.put("last_error", error); values.put("updated_at", System.currentTimeMillis());
        getWritableDatabase().update("queue", values, "source_id=?", new String[]{id});
        if (increment) getWritableDatabase().execSQL("UPDATE queue SET attempts=attempts+1 WHERE source_id=?", new Object[]{id});
    }

    public int count(String states) {
        try (Cursor c = getReadableDatabase().rawQuery("SELECT count(*) FROM queue WHERE state IN (" + states + ")", null)) { c.moveToFirst(); return c.getInt(0); }
    }
    public String summary() {
        int pending = count("'pending','retry','uploading'"), uploaded = count("'uploaded'"), attention = count("'retry'");
        return "已同步 " + uploaded + " 张 · 队列 " + pending + " 张" + (attention > 0 ? " · 有失败待重试 " + attention + " 张" : "");
    }
}

