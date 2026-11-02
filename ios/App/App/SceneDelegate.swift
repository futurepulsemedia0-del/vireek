import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = CAPBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
        if let item = connectionOptions.shortcutItem { pendingShortcutURL = shortcutURL(item) }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }

    // Privacy cover: the app-switcher snapshot is taken natively, so it never shows job / customer data.
    private var privacyCover: UIView?
    private var pendingShortcutURL: URL?

    private func shortcutURL(_ item: UIApplicationShortcutItem) -> URL? {
        guard let raw = item.userInfo?["url"] as? String, raw.hasPrefix("vireek://") else { return nil }
        return URL(string: raw)
    }

    func windowScene(_ windowScene: UIWindowScene, performActionFor shortcutItem: UIApplicationShortcutItem, completionHandler: @escaping (Bool) -> Void) {
        guard let url = shortcutURL(shortcutItem) else { completionHandler(false); return }
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: url, options: [:])
        completionHandler(true)
    }

    func sceneWillResignActive(_ scene: UIScene) {
        guard privacyCover == nil, let window = window else { return }
        let cover = UIView(frame: window.bounds)
        cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        cover.backgroundColor = .black
        window.addSubview(cover)
        privacyCover = cover
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        privacyCover?.removeFromSuperview()
        privacyCover = nil
        if let url = pendingShortcutURL {
            pendingShortcutURL = nil
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: url, options: [:])
            }
        }
    }
}
