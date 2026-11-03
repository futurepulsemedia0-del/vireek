package com.vireek.field;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.os.Build;

/**
 * Creates one notification channel per severity. The ids match MobilePayload.androidChannel
 * on the server (vireek_critical / vireek_high / vireek_normal / vireek_low). Idempotent: Android keeps
 * the user's own channel settings (sound, importance) once a channel exists.
 */
final class VireekNotificationChannels {
    private VireekNotificationChannels() {}

    static void ensure(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        if (nm == null) return;

        nm.createNotificationChannel(channel("vireek_critical", "Emergency calls", NotificationManager.IMPORTANCE_HIGH,
                "Emergency calls that need an immediate answer.", new long[] {0, 600, 200, 600, 200, 600}));
        nm.createNotificationChannel(channel("vireek_high", "Urgent alerts", NotificationManager.IMPORTANCE_HIGH,
                "Missed calls, on-call and payment problems.", new long[] {0, 300, 150, 300}));
        nm.createNotificationChannel(channel("vireek_normal", "Jobs and updates", NotificationManager.IMPORTANCE_DEFAULT,
                "Job updates and payment requests.", null));
        nm.createNotificationChannel(channel("vireek_low", "Summaries", NotificationManager.IMPORTANCE_LOW,
                "Daily summaries and low-priority updates.", null));
    }

    private static NotificationChannel channel(String id, String name, int importance, String description, long[] vibration) {
        NotificationChannel c = new NotificationChannel(id, name, importance);
        c.setDescription(description);
        // Customer details never appear on the lock screen unless the person changes this in system settings.
        c.setLockscreenVisibility(android.app.Notification.VISIBILITY_PRIVATE);
        if (vibration != null) {
            c.enableVibration(true);
            c.setVibrationPattern(vibration);
        }
        return c;
    }
}
