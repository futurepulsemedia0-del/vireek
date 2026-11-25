package com.vireek.field;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;

/**
 * Creates one notification channel per severity. The ids match MobilePayload.androidChannel
 * on the server (vireek_critical / vireek_high / vireek_normal / vireek_low). Idempotent: Android keeps
 * the user's own channel settings (sound, importance) once a channel exists.
 */
final class VireekNotificationChannels {
    private VireekNotificationChannels() {}

    // v2 sound-tier channels (system sounds only). Ids must match soundTiers.ts. A channel's sound is immutable once
    // created: to change a tier's sound, bump the _v2 suffix here AND in soundTiers.ts. The v1 channels are kept on
    // purpose: older builds and the server still target them (a push to a missing channel falls back to default).
    static final String EMERGENCY = "vireek_emergency_v2";
    static final String ALERT = "vireek_alert_v2";
    static final String NORMAL = "vireek_normal_v2";
    static final String MESSAGE = "vireek_message_v2";
    static final String QUIET = "vireek_quiet_v2";

    /** Maps a channel id (v1 or v2) to its tier name; VireekNotifier uses it when the push carries no `tier`. */
    static String tierOfChannel(String channelId) {
        if (channelId == null) return "normal";
        switch (channelId) {
            case EMERGENCY: case "vireek_critical": return "emergency";
            case ALERT: case "vireek_high": return "alert";
            case MESSAGE: return "message";
            case QUIET: case "vireek_low": return "quiet";
            default: return "normal";
        }
    }

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

        // ---- v2 sound tiers ----
        Uri ringtone = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
        Uri notificationSound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
        AudioAttributes ringAttrs = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build();
        AudioAttributes notifAttrs = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build();

        nm.createNotificationChannel(channel(EMERGENCY, "Emergency calls", NotificationManager.IMPORTANCE_HIGH,
                "Emergency calls that need an immediate answer. Rings like an incoming call.",
                new long[] {0, 600, 200, 600, 200, 600, 200, 600}, ringtone, ringAttrs));
        nm.createNotificationChannel(channel(ALERT, "Urgent alerts", NotificationManager.IMPORTANCE_HIGH,
                "Missed calls, on-call pages, payment failures and security events.",
                new long[] {0, 300, 150, 300}, notificationSound, notifAttrs));
        nm.createNotificationChannel(channel(NORMAL, "Jobs and updates", NotificationManager.IMPORTANCE_DEFAULT,
                "Job updates, payment requests and appointment changes.", null, notificationSound, notifAttrs));
        nm.createNotificationChannel(channel(MESSAGE, "Messages", NotificationManager.IMPORTANCE_DEFAULT,
                "Team chat and mentions.", null, notificationSound, notifAttrs));
        NotificationChannel quiet = channel(QUIET, "Summaries", NotificationManager.IMPORTANCE_LOW,
                "Daily summaries, insights and digests. No sound, no vibration.", null);
        quiet.setSound(null, null);
        quiet.enableVibration(false);
        nm.createNotificationChannel(quiet);
    }
    private static NotificationChannel channel(String id, String name, int importance, String description,
                                               long[] vibration, Uri sound, AudioAttributes attrs) {
        NotificationChannel c = channel(id, name, importance, description, vibration);
        if (sound != null) c.setSound(sound, attrs);
        return c;
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
