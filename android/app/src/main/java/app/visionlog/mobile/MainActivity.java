package app.visionlog.mobile;

import android.Manifest;
import android.app.Activity;
import android.annotation.SuppressLint;
import android.app.AlertDialog;
import android.app.DatePickerDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Build;
import android.provider.Settings;
import android.provider.OpenableColumns;
import android.content.ClipData;
import android.database.Cursor;
import android.view.View;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import androidx.work.WorkInfo;
import androidx.work.WorkManager;
import androidx.lifecycle.Observer;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.Calendar;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final int PHOTO_PERMISSION_REQUEST = 1001;
    private static final int MANUAL_IMPORT_REQUEST = 1002;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private SyncPreferences preferences;
    private SyncQueueDb queue;
    private EditText serverUrl;
    private TextView permissionStatus, folderStatus, queueStatus;
    private Button chooseFolder, syncNow, grantPermission;
    private ScrollView syncScreen;
    private WebView libraryWeb;
    private final Observer<List<WorkInfo>> workObserver = infos -> refreshStatus();

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state); setContentView(R.layout.activity_main);
        preferences = new SyncPreferences(this); queue = new SyncQueueDb(this);
        serverUrl = findViewById(R.id.serverUrl); permissionStatus = findViewById(R.id.permissionStatus);
        folderStatus = findViewById(R.id.folderStatus); queueStatus = findViewById(R.id.queueStatus);
        chooseFolder = findViewById(R.id.chooseFolder); syncNow = findViewById(R.id.syncNow); grantPermission = findViewById(R.id.grantPermission);
        syncScreen = findViewById(R.id.syncScreen); libraryWeb = findViewById(R.id.libraryWeb);
        serverUrl.setText(preferences.serverUrl()); configureWebView();
        if (Build.VERSION.SDK_INT >= 33) getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);

        findViewById(R.id.saveServer).setOnClickListener(view -> saveServer());
        grantPermission.setOnClickListener(view -> requestPermissions(PhotoPermission.requestPermissions(), PHOTO_PERMISSION_REQUEST));
        chooseFolder.setOnClickListener(view -> loadFolders());
        findViewById(R.id.manualImport).setOnClickListener(view -> chooseManualPhotos());
        syncNow.setOnClickListener(view -> { SyncScheduler.runNow(this); toast("已开始补偿扫描"); });
        findViewById(R.id.syncTab).setOnClickListener(view -> showSync());
        findViewById(R.id.libraryTab).setOnClickListener(view -> showLibrary());
        WorkManager.getInstance(this).getWorkInfosForUniqueWorkLiveData(SyncScheduler.MANUAL_NAME).observeForever(workObserver);
    }

    @Override protected void onResume() {
        super.onResume(); refreshStatus();
        if (PhotoPermission.state(this) == PhotoPermission.State.FULL && preferences.hasFolder()) {
            SyncScheduler.schedule(this); SyncScheduler.runNow(this);
        }
    }

    @Override protected void onDestroy() {
        WorkManager.getInstance(this).getWorkInfosForUniqueWorkLiveData(SyncScheduler.MANUAL_NAME).removeObserver(workObserver);
        executor.shutdownNow(); libraryWeb.destroy(); super.onDestroy();
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == PHOTO_PERMISSION_REQUEST) { refreshStatus(); if (PhotoPermission.state(this) == PhotoPermission.State.FULL) loadFolders(); }
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != MANUAL_IMPORT_REQUEST || resultCode != RESULT_OK || data == null) return;
        int flags = data.getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        int count = 0; ClipData clips = data.getClipData();
        if (clips != null) for (int i=0;i<clips.getItemCount();i++) { enqueueManual(clips.getItemAt(i).getUri(),flags); count++; }
        else if (data.getData() != null) { enqueueManual(data.getData(),flags); count=1; }
        if (count > 0) { SyncScheduler.runNow(this); toast(count + " 张照片已加入手动同步队列"); refreshStatus(); }
    }

    @SuppressLint("GestureBackNavigation") @Override public void onBackPressed() { if (!handleBack()) super.onBackPressed(); }
    private boolean handleBack() {
        if (libraryWeb.getVisibility() == View.VISIBLE && libraryWeb.canGoBack()) { libraryWeb.goBack(); return true; }
        if (libraryWeb.getVisibility() == View.VISIBLE) { showSync(); return true; }
        return false;
    }

    private void configureWebView() {
        WebSettings settings = libraryWeb.getSettings(); settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false); settings.setAllowContentAccess(false); libraryWeb.setWebViewClient(new WebViewClient());
    }

    private void saveServer() {
        String value = serverUrl.getText().toString().trim();
        if (!(value.startsWith("http://") || value.startsWith("https://"))) { toast("地址需要以 http:// 或 https:// 开头"); return; }
        preferences.setServerUrl(value); toast("服务器地址已保存"); refreshStatus();
    }

    private void chooseManualPhotos() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("image/*").putExtra(Intent.EXTRA_ALLOW_MULTIPLE,true)
                .addCategory(Intent.CATEGORY_OPENABLE).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(intent,MANUAL_IMPORT_REQUEST);
    }

    private void enqueueManual(Uri uri, int flags) {
        try { getContentResolver().takePersistableUriPermission(uri,flags & Intent.FLAG_GRANT_READ_URI_PERMISSION); } catch (SecurityException ignored) {}
        SyncQueueDb.Item item=new SyncQueueDb.Item(); item.uri=uri.toString(); item.sourceId="manual:" + java.util.UUID.nameUUIDFromBytes(item.uri.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        item.mime=getContentResolver().getType(uri); item.dateAdded=System.currentTimeMillis()/1000L; item.name="manual-photo";
        try(Cursor cursor=getContentResolver().query(uri,new String[]{OpenableColumns.DISPLAY_NAME,OpenableColumns.SIZE},null,null,null)) {
            if(cursor!=null&&cursor.moveToFirst()){item.name=cursor.getString(0);item.size=cursor.getLong(1);}
        }
        if(item.mime==null)item.mime="image/jpeg"; queue.enqueue(item);
    }

    private void showSync() { libraryWeb.setVisibility(View.GONE); syncScreen.setVisibility(View.VISIBLE); }
    private void showLibrary() {
        if (preferences.serverUrl().isBlank()) { toast("请先保存家庭服务器地址"); return; }
        syncScreen.setVisibility(View.GONE); libraryWeb.setVisibility(View.VISIBLE);
        String current = libraryWeb.getUrl(); if (current == null || !current.startsWith(preferences.serverUrl())) libraryWeb.loadUrl(preferences.serverUrl());
    }

    private void refreshStatus() {
        PhotoPermission.State permission = PhotoPermission.state(this);
        if (permission == PhotoPermission.State.FULL) {
            permissionStatus.setText("完整照片权限 · 可自动发现目标文件夹的新照片"); grantPermission.setVisibility(View.GONE);
        } else if (permission == PhotoPermission.State.PARTIAL) {
            permissionStatus.setText("仅部分照片权限 · 自动文件夹同步已暂停，请改为完整权限"); grantPermission.setText("重新选择权限"); grantPermission.setVisibility(View.VISIBLE);
        } else {
            permissionStatus.setText("未授权 · 尚不能读取设备图片文件夹"); grantPermission.setVisibility(View.VISIBLE);
        }
        chooseFolder.setEnabled(permission == PhotoPermission.State.FULL);
        folderStatus.setText(preferences.hasFolder() ? "当前：" + preferences.relativePath() + "\n递归包含子目录" : "尚未选择目标文件夹");
        queueStatus.setText(queue.summary());
        syncNow.setEnabled(permission == PhotoPermission.State.FULL && preferences.hasFolder() && !preferences.serverUrl().isBlank());
    }

    private void loadFolders() {
        chooseFolder.setEnabled(false); folderStatus.setText("正在读取设备图片文件夹…");
        executor.execute(() -> {
            List<FolderRepository.Folder> folders;
            try { folders = new FolderRepository(this).list(); }
            catch (Exception error) { runOnUiThread(() -> { toast("读取失败：" + error.getMessage()); refreshStatus(); }); return; }
            runOnUiThread(() -> showFolderPicker(folders));
        });
    }

    private void showFolderPicker(List<FolderRepository.Folder> folders) {
        chooseFolder.setEnabled(true);
        if (folders.isEmpty()) { folderStatus.setText("没有找到可访问的图片文件夹"); return; }
        String[] labels = folders.stream().map(FolderRepository.Folder::label).toArray(String[]::new);
        new AlertDialog.Builder(this).setTitle("选择设备图片文件夹").setItems(labels, (dialog, which) -> chooseImportMode(folders.get(which))).setNegativeButton("取消", null).show();
    }

    private void chooseImportMode(FolderRepository.Folder folder) {
        String[] modes = { "导入文件夹中的全部照片", "从指定日期开始导入", "只处理此刻之后的新照片" };
        new AlertDialog.Builder(this).setTitle(folder.relativePath).setItems(modes, (dialog, which) -> {
            if (which == 0) saveFolder(folder, 0L);
            else if (which == 1) chooseStartDate(folder);
            else saveFolder(folder, System.currentTimeMillis() / 1000L);
        }).show();
    }

    private void chooseStartDate(FolderRepository.Folder folder) {
        Calendar today = Calendar.getInstance();
        new DatePickerDialog(this, (picker, year, month, day) -> {
            long seconds = LocalDate.of(year, month + 1, day).atStartOfDay(ZoneId.systemDefault()).toEpochSecond(); saveFolder(folder, seconds);
        }, today.get(Calendar.YEAR), today.get(Calendar.MONTH), today.get(Calendar.DAY_OF_MONTH)).show();
    }

    private void saveFolder(FolderRepository.Folder folder, long after) {
        preferences.setFolder(folder.volume, folder.relativePath, after); SyncScheduler.schedule(this); SyncScheduler.runNow(this);
        toast("目标文件夹已启用"); refreshStatus();
    }

    private void toast(String message) { Toast.makeText(this, message, Toast.LENGTH_LONG).show(); }
}
