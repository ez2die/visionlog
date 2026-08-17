package app.visionlog.mobile;

import android.content.Context;
import android.net.Uri;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.time.ZoneId;

public final class SyncWorker extends Worker {
    private final Context context;
    private final SyncPreferences preferences;
    private final SyncQueueDb queue;

    public SyncWorker(@NonNull Context context, @NonNull WorkerParameters parameters) {
        super(context, parameters); this.context = context; preferences = new SyncPreferences(context); queue = new SyncQueueDb(context);
    }

    @NonNull @Override public Result doWork() {
        if (preferences.serverUrl().isBlank()) return Result.success();
        if (PhotoPermission.state(context) == PhotoPermission.State.FULL && preferences.hasFolder()) {
            try { new MediaStoreScanner(context).scan(); }
            catch (SecurityException error) { return Result.failure(); }
        }

        boolean retryNeeded = false;
        SyncQueueDb.Item item;
        while ((item = queue.next()) != null && !isStopped()) {
            queue.markUploading(item.sourceId);
            try { upload(item); queue.markUploaded(item.sourceId); }
            catch (Exception error) { queue.markFailure(item.sourceId, trim(error.getMessage())); retryNeeded = item.attempts + 1 < 5; break; }
        }
        return retryNeeded ? Result.retry() : Result.success();
    }

    private void upload(SyncQueueDb.Item item) throws Exception {
        String boundary = "VisionLog-" + System.nanoTime();
        URL url = new URL(preferences.serverUrl() + "/api/photos/import?source=android");
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setConnectTimeout(20_000); connection.setReadTimeout(180_000); connection.setRequestMethod("POST");
        connection.setDoOutput(true); connection.setChunkedStreamingMode(256 * 1024);
        connection.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
        connection.setRequestProperty("x-visionlog-source-key", item.sourceId);
        connection.setRequestProperty("x-visionlog-timezone", ZoneId.systemDefault().getId());
        String header = "--" + boundary + "\r\nContent-Disposition: form-data; name=\"photos\"; filename=\"" + safe(item.name) + "\"\r\nContent-Type: " + item.mime + "\r\n\r\n";
        try (BufferedOutputStream output = new BufferedOutputStream(connection.getOutputStream());
             InputStream raw = context.getContentResolver().openInputStream(Uri.parse(item.uri))) {
            if (raw == null) throw new IllegalStateException("照片已无法读取");
            output.write(header.getBytes(StandardCharsets.UTF_8));
            try (BufferedInputStream input = new BufferedInputStream(raw)) {
                byte[] buffer = new byte[64 * 1024]; int read;
                while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
            }
            output.write(("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8)); output.flush();
        }
        int status = connection.getResponseCode();
        if (status < 200 || status >= 300) {
            String body = ""; InputStream stream = connection.getErrorStream();
            if (stream != null) try (stream) { byte[] errorBytes = new byte[800]; int count = stream.read(errorBytes); if (count > 0) body = new String(errorBytes, 0, count, StandardCharsets.UTF_8); }
            throw new IllegalStateException("服务器返回 " + status + " " + body);
        }
        connection.disconnect();
    }

    private static String safe(String value) { return value.replace("\\", "_").replace("\"", "_").replace("\r", "_").replace("\n", "_"); }
    private static String trim(String value) { if (value == null) return "未知错误"; return value.length() > 500 ? value.substring(0, 500) : value; }
}
