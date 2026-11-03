package com.vireek.field;

import android.app.Notification;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import java.util.Map;

/** Builds the actionable alert + ongoing live-call notifications. Every action is a deep link or a local snooze:
 *  nothing here can change data, so no write ever happens from a lock screen or a watch. */
final class VireekNotifier {
    private VireekNotifier() {}

    static final String GROUP = "vireek_alerts";
    static final int ID_ALERT = 1;
    static final int ID_LIVE = 2;

    /** Only same-app relative paths are accepted (mirrors resolveDeepLink in src/lib/native/deepLinks.ts). */
    static Uri safeUri(String path) {
        if (path == null || !path.startsWith("/") || path.startsWith("//") || path.contains("\\") || path.length() > 512) path = "/dashboard";
        return Uri.parse("https://vireek.com" + path);
    }

    static PendingIntent open(Context c, String path, int requestCode) {
        Intent i = new Intent(Intent.ACTION_VIEW, safeUri(path)).setClass(c, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(c, requestCode, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static void showAlert(Context c, Map<String, String> d) {
        if (!NotificationManagerCompat.from(c).areNotificationsEnabled()) return;
        String tag = d.getOrDefault("tag", "alert");
        String category = d.getOrDefault("category", "DEFAULT");
        String url = d.getOrDefault("url", "/dashboard");
        String channel = d.getOrDefault("channel", "vireek_normal");
        boolean critical = "critical".equals(d.get("severity"));
        int rc = tag.hashCode();

        NotificationCompat.Builder b = new NotificationCompat.Builder(c, channel)
                .setSmallIcon(R.drawable.ic_stat_vireek)
                .setContentTitle(d.getOrDefault("title", "Vireek"))
                .setContentText(d.getOrDefault("body", ""))
                .setStyle(new NotificationCompat.BigTextStyle().bigText(d.getOrDefault("body", "")))
                .setContentIntent(open(c, url, rc))
                .setAutoCancel(true)
                .setGroup(GROUP)
                .setCategory(critical ? NotificationCompat.CATEGORY_CALL : NotificationCompat.CATEGORY_MESSAGE)
                .setPriority(critical ? NotificationCompat.PRIORITY_MAX : NotificationCompat.PRIORITY_DEFAULT)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .setPublicVersion(new NotificationCompat.Builder(c, channel)
                        .setSmallIcon(R.drawable.ic_stat_vireek).setContentTitle("Vireek").setContentText("New alert").build());

        // Max 3 visible actions on phones; the same actions are bridged to Wear OS automatically.
        switch (category) {
            case "EMERGENCY_CALL":
                b.addAction(0, "Answer", open(c, "/dashboard/live-calls", rc + 1));
                b.addAction(0, "Call back", open(c, "/dashboard/calls", rc + 2));
                b.addAction(0, "Dispatch", open(c, "/dashboard/dispatch", rc + 3));
                break;
            case "MISSED_CALL":
                b.addAction(0, "Call back", open(c, "/dashboard/calls", rc + 1));
                b.addAction(0, "Assign", open(c, "/dashboard/dispatch", rc + 2));
                b.addAction(0, "Snooze", VireekSnoozeReceiver.snoozeIntent(c, d, rc + 3));
                break;
            case "JOB":
                b.addAction(0, "Open job", open(c, "/tech/today", rc + 1));
                b.addAction(0, "Snooze", VireekSnoozeReceiver.snoozeIntent(c, d, rc + 2));
                break;
            default:
                break;
        }
        b.extend(new NotificationCompat.WearableExtender());
        NotificationManagerCompat.from(c).notify(tag, ID_ALERT, b.build());
        postSummary(c, channel);
    }

    private static void postSummary(Context c, String channel) {
        Notification summary = new NotificationCompat.Builder(c, channel)
                .setSmallIcon(R.drawable.ic_stat_vireek).setContentTitle("Vireek").setContentText("New alerts")
                .setGroup(GROUP).setGroupSummary(true).setAutoCancel(true)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).build();
        NotificationManagerCompat.from(c).notify("summary", 0, summary);
    }

    /** Ongoing notification with a live chronometer: the system counts up from startedAt, so no per-second pushes. */
    static void showLive(Context c, Map<String, String> d) {
        if (!NotificationManagerCompat.from(c).areNotificationsEnabled()) return;
        String tag = d.getOrDefault("tag", "live");
        long started;
        try { started = Long.parseLong(d.getOrDefault("startedAt", "0")); } catch (NumberFormatException e) { started = System.currentTimeMillis(); }
        String channel = d.getOrDefault("channel", "vireek_normal");
        NotificationCompat.Builder b = new NotificationCompat.Builder(c, channel)
                .setSmallIcon(R.drawable.ic_stat_vireek)
                .setContentTitle(d.getOrDefault("title", "Live call"))
                .setContentText(d.getOrDefault("body", ""))
                .setOngoing(true).setOnlyAlertOnce(true)
                .setUsesChronometer(true).setShowWhen(true).setWhen(started)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .setContentIntent(open(c, d.getOrDefault("url", "/dashboard/live-calls"), tag.hashCode()))
                .setPublicVersion(new NotificationCompat.Builder(c, channel)
                        .setSmallIcon(R.drawable.ic_stat_vireek).setContentTitle("Vireek").setContentText("Call in progress").build());
        NotificationManagerCompat.from(c).notify(tag, ID_LIVE, b.build());
    }

    static void endLive(Context c, Map<String, String> d) {
        NotificationManagerCompat.from(c).cancel(d.getOrDefault("tag", "live"), ID_LIVE);
    }
}
