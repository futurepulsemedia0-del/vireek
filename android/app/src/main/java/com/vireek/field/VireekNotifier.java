package com.vireek.field;

import android.app.Notification;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
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
        // The channel may not exist yet if the app was updated but not opened since: create all of them (idempotent).
        VireekNotificationChannels.ensure(c);
        String channel = d.getOrDefault("channel", VireekNotificationChannels.NORMAL);
        String tier = d.containsKey("tier") ? d.get("tier") : VireekNotificationChannels.tierOfChannel(channel);
        boolean critical = "emergency".equals(tier) || "critical".equals(d.get("severity"));
        // Message tier is grouped per conversation thread (tag); everything else shares one group.
        String group = "message".equals(tier) ? GROUP + "_" + tag : GROUP;

        NotificationCompat.Builder b = new NotificationCompat.Builder(c, channel)
                .setSmallIcon(R.drawable.ic_stat_vireek)
                .setContentTitle(d.getOrDefault("title", "Vireek"))
                .setContentText(d.getOrDefault("body", ""))
                .setStyle(new NotificationCompat.BigTextStyle().bigText(d.getOrDefault("body", "")))
                .setContentIntent(open(c, url, rc))
                .setAutoCancel(true)
                .setGroup(group)
                .setCategory(categoryFor(tier))
                .setPriority(priorityFor(tier))
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
        // Android 7.1 and below have no channels: sound comes from the notification itself. Quiet gets none.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            if ("quiet".equals(tier)) b.setDefaults(0);
            else if ("emergency".equals(tier)) b.setDefaults(Notification.DEFAULT_ALL);
            else b.setDefaults(Notification.DEFAULT_SOUND);
        }
        b.extend(new NotificationCompat.WearableExtender());
        NotificationManagerCompat.from(c).notify(tag, ID_ALERT, b.build());
        postSummary(c, channel, group, "message".equals(tier) ? "summary_" + tag : "summary");
    }

    /** Importance of the channel drives sound on Android 8+; these only matter below that. */
    static int priorityFor(String tier) {
        switch (tier == null ? "normal" : tier) {
            case "emergency": return NotificationCompat.PRIORITY_MAX;
            case "alert": return NotificationCompat.PRIORITY_HIGH;
            case "quiet": return NotificationCompat.PRIORITY_LOW;
            default: return NotificationCompat.PRIORITY_DEFAULT;
        }
    }

    static String categoryFor(String tier) {
        switch (tier == null ? "normal" : tier) {
            case "emergency": return NotificationCompat.CATEGORY_CALL;
            case "alert": return NotificationCompat.CATEGORY_ALARM;
            case "quiet": return NotificationCompat.CATEGORY_STATUS;
            default: return NotificationCompat.CATEGORY_MESSAGE;
        }
    }

    private static void postSummary(Context c, String channel, String group, String summaryTag) {
        // The summary never makes a sound of its own: the child notification already did.
        Notification summary = new NotificationCompat.Builder(c, channel)
                .setSmallIcon(R.drawable.ic_stat_vireek).setContentTitle("Vireek").setContentText("New alerts")
                .setGroup(group).setGroupSummary(true).setAutoCancel(true)
                .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).build();
        NotificationManagerCompat.from(c).notify(summaryTag, 0, summary);
    }
