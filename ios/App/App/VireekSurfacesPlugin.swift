// ios/App/App/VireekSurfacesPlugin.swift — Capacitor plugin "VireekSurfaces" (App target only).
import Foundation
import Capacitor
import WidgetKit
import ActivityKit

@objc(VireekSurfacesPlugin)
public class VireekSurfacesPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VireekSurfacesPlugin"
    public let jsName = "VireekSurfaces"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setSnapshot", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearSnapshot", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "consumePendingLink", returnType: CAPPluginReturnPromise),
    ]

    private var tasks: [Task<Void, Never>] = []

    override public func load() {
        guard #available(iOS 16.2, *) else { return }
        // iOS 17.2+: token that lets the server START a Live Activity while the app is closed.
        if #available(iOS 17.2, *) {
            tasks.append(Task { [weak self] in
                for await data in Activity<VireekCallAttributes>.pushToStartTokenUpdates {
                    self?.notifyListeners("liveActivityToken", data: ["kind": "start", "target": "", "token": Self.hex(data)])
                }
            })
        }
        // Per-activity token: lets the server UPDATE / END an activity that is already running.
        tasks.append(Task { [weak self] in
            for await activity in Activity<VireekCallAttributes>.activityUpdates {
                let callId = activity.attributes.callId
                Task { [weak self] in
                    for await data in activity.pushTokenUpdates {
                        self?.notifyListeners("liveActivityToken", data: ["kind": "update", "target": callId, "token": Self.hex(data)])
                    }
                }
            }
        })
    }

    deinit { tasks.forEach { $0.cancel() } }

    private static func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

    @objc func setSnapshot(_ call: CAPPluginCall) {
        guard let json = call.getString("json"), json.utf8.count < 20_000, let data = json.data(using: .utf8),
              (try? JSONDecoder().decode(VireekSnapshot.self, from: data)) != nil else {
            return call.reject("invalid snapshot")
        }
        VireekShared.defaults?.set(data, forKey: VireekShared.snapshotKey)
        WidgetCenter.shared.reloadAllTimelines()
        call.resolve()
    }

    @objc func clearSnapshot(_ call: CAPPluginCall) {
        VireekShared.defaults?.removeObject(forKey: VireekShared.snapshotKey)
        VireekShared.defaults?.removeObject(forKey: VireekShared.pendingLinkKey)
        WidgetCenter.shared.reloadAllTimelines()
        call.resolve()
    }

    @objc func consumePendingLink(_ call: CAPPluginCall) {
        let url = VireekShared.defaults?.string(forKey: VireekShared.pendingLinkKey)
        VireekShared.defaults?.removeObject(forKey: VireekShared.pendingLinkKey)
        call.resolve(url.map { ["url": $0] } ?? [:])
    }
}
