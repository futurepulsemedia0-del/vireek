package com.vireek.field;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

/** Handles the data-only FCM messages the backend sends to Android (kind = alert | live | live_end).
 *  Token rotation is re-registered by the web layer on the next app resume (syncNativePushToken). */
public class VireekMessagingService extends FirebaseMessagingService {
    @Override
    public void onMessageReceived(RemoteMessage message) {
        Map<String, String> d = message.getData();
        String kind = d.get("kind");
        if ("alert".equals(kind)) VireekNotifier.showAlert(this, d);
        else if ("live".equals(kind)) VireekNotifier.showLive(this, d);
        else if ("live_end".equals(kind)) VireekNotifier.endLive(this, d);
        else super.onMessageReceived(message);
    }
}
