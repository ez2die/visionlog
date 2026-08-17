package app.visionlog.mobile;

import android.content.Context;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.OutOfQuotaPolicy;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import java.util.concurrent.TimeUnit;

public final class SyncScheduler {
    public static final String PERIODIC_NAME = "visionlog-folder-sync";
    public static final String MANUAL_NAME = "visionlog-manual-sync";
    private SyncScheduler() {}

    private static Constraints constraints() {
        return new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
    }

    public static void schedule(Context context) {
        if (PhotoPermission.state(context) != PhotoPermission.State.FULL || !new SyncPreferences(context).hasFolder()) return;
        PeriodicWorkRequest work = new PeriodicWorkRequest.Builder(SyncWorker.class, 15, TimeUnit.MINUTES)
                .setConstraints(constraints()).build();
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(PERIODIC_NAME, ExistingPeriodicWorkPolicy.UPDATE, work);
    }

    public static void runNow(Context context) {
        OneTimeWorkRequest work = new OneTimeWorkRequest.Builder(SyncWorker.class).setConstraints(constraints())
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST).build();
        WorkManager.getInstance(context).enqueueUniqueWork(MANUAL_NAME, ExistingWorkPolicy.REPLACE, work);
    }
}

