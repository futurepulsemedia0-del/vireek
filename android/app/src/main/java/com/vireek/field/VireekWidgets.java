package com.vireek.field;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.text.format.DateUtils;
import android.view.View;
import android.widget.RemoteViews;
import java.text.DateFormat;
import java.text.NumberFormat;
import java.util.Date;
import java.util.Locale;
import org.json.JSONObject;

/** Home-screen widgets. No periodic polling (updatePeriodMillis=0): they redraw when the app writes a new snapshot,
 *  which keeps battery use at zero. Old data is labelled with its age instead of being shown as current. */
public final class VireekWidgets {
    private VireekWidgets() {}

    private static final long STALE_MS = 6 * 60 * 60 * 1000L;

    static void refreshAll(Context c) {
        AppWidgetManager m = AppWidgetManager.getInstance(c);
        for (Class<?> k : new Class<?>[] {TodayWidget.class, NextJobWidget.class, OnCallWidget.class}) {
            int[] ids = m.getAppWidgetIds(new ComponentName(c, k));
            if (ids.length > 0) c.sendBroadcast(new android.content.Intent(c, k)
                    .setAction(AppWidgetManager.ACTION_APPWIDGET_UPDATE).putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids));
        }
    }

    abstract static class Base extends AppWidgetProvider {
        abstract String title();
        abstract String[] render(JSONObject snap); // {value, subtitle, path}

        @Override
        public void onUpdate(Context c, AppWidgetManager m, int[] ids) {
            SharedPreferences p = c.getSharedPreferences(VireekSurfacesPlugin.PREFS, Context.MODE_PRIVATE);
            String raw = p.getString(VireekSurfacesPlugin.KEY_SNAPSHOT, null);
            long savedAt = p.getLong(VireekSurfacesPlugin.KEY_SAVED_AT, 0);
            String value, subtitle, path = "/tech/today";
            JSONObject snap = null;
            try { if (raw != null) snap = new JSONObject(raw); } catch (Exception ignored) { /* treated as signed out */ }

            if (snap == null) {
                value = "Open Vireek";
                subtitle = "Sign in to see this";
            } else {
                String[] r = render(snap);
                value = r[0]; subtitle = r[1]; path = r[2];
                if (System.currentTimeMillis() - savedAt > STALE_MS) {
                    subtitle = "Updated " + DateUtils.getRelativeTimeSpanString(savedAt, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS);
                }
            }
            PendingIntent tap = VireekNotifier.open(c, path, title().hashCode());
            for (int id : ids) {
                RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget_vireek);
                v.setTextViewText(R.id.vk_title, title());
                v.setTextViewText(R.id.vk_value, value);
                v.setTextViewText(R.id.vk_subtitle, subtitle);
                v.setViewVisibility(R.id.vk_subtitle, subtitle.isEmpty() ? View.GONE : View.VISIBLE);
                v.setOnClickPendingIntent(R.id.vk_root, tap);
                m.updateAppWidget(id, v);
            }
        }
    }

    public static class TodayWidget extends Base {
        String title() { return "Today"; }
        String[] render(JSONObject s) {
            int answered = s.optInt("calls_answered"), missed = s.optInt("calls_missed");
            long cents = s.optLong("revenue_recovered_cents");
            String money = NumberFormat.getCurrencyInstance(Locale.US).format(cents / 100.0);
            return new String[] {answered + " answered", missed + " missed · " + money + " recovered", "/dashboard/calls"};
        }
    }

    public static class NextJobWidget extends Base {
        String title() { return "Next job"; }
        String[] render(JSONObject s) {
            JSONObject j = s.optJSONObject("next_job");
            if (j == null) return new String[] {"No jobs left", "Enjoy the break", "/tech/today"};
            String when = DateFormat.getTimeInstance(DateFormat.SHORT).format(new Date(j.optLong("scheduled_ms")));
            return new String[] {when, j.optString("service", "Job"), "/tech/today"};
        }
    }

    public static class OnCallWidget extends Base {
        String title() { return "On call"; }
        String[] render(JSONObject s) {
            JSONObject o = s.optJSONObject("on_call");
            if (o == null) return new String[] {"Not set up", "Add a rotation", "/dashboard/on-call"};
            return new String[] {o.optBoolean("is_me") ? "You" : o.optString("name", "—"), "is on call now", "/dashboard/on-call"};
        }
    }
}
