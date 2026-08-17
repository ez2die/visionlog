package app.visionlog.mobile;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;

public final class PhotoPermission {
    public enum State { FULL, PARTIAL, DENIED }
    private PhotoPermission() {}

    public static State state(Context context) {
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.READ_MEDIA_IMAGES) == PackageManager.PERMISSION_GRANTED) return State.FULL;
        if (Build.VERSION.SDK_INT < 33 && context.checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED) return State.FULL;
        if (Build.VERSION.SDK_INT >= 34 && context.checkSelfPermission(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) == PackageManager.PERMISSION_GRANTED) return State.PARTIAL;
        return State.DENIED;
    }

    public static String[] requestPermissions() {
        if (Build.VERSION.SDK_INT >= 34) return new String[] { Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED };
        if (Build.VERSION.SDK_INT >= 33) return new String[] { Manifest.permission.READ_MEDIA_IMAGES };
        return new String[] { Manifest.permission.READ_EXTERNAL_STORAGE };
    }
}

