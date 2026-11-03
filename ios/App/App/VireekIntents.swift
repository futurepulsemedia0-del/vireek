// ios/App/App/VireekIntents.swift — Siri / Shortcuts (App Intents, iOS 16+). App target only.
// Rules: read-only intents answer from the privacy-safe snapshot (no customer names/phones/addresses exist in it).
// Anything that could write or call someone only OPENS the app at the right screen (openAppWhenRun requires the
// phone to be unlocked) — the actual confirmation happens in the signed-in app. Nothing here dials or edits data.
import AppIntents
import Foundation

@available(iOS 16.0, *)
private func queueLink(_ path: String) { VireekShared.defaults?.set("https://vireek.com\(path)", forKey: VireekShared.pendingLinkKey) }

@available(iOS 16.0, *)
struct ScheduleIntent: AppIntent {
    static var title: LocalizedStringResource = "What's my schedule"
    static var description = IntentDescription("Hears your next job.")

    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let s = VireekSnapshot.load() else { return .result(dialog: "Open Vireek and sign in first.") }
        guard let job = s.next_job else { return .result(dialog: "You have no jobs left today.") }
        let time = Date(timeIntervalSince1970: job.scheduled_ms / 1000).formatted(date: .omitted, time: .shortened)
        return .result(dialog: IntentDialog(stringLiteral: "Your next job is \(job.service) at \(time)."))
    }
}

@available(iOS 16.0, *)
struct OnCallIntent: AppIntent {
    static var title: LocalizedStringResource = "Who's on call"
    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let s = VireekSnapshot.load() else { return .result(dialog: "Open Vireek and sign in first.") }
        guard let o = s.on_call else { return .result(dialog: "No on-call rotation is set up.") }
        return .result(dialog: IntentDialog(stringLiteral: o.is_me ? "You are on call now." : "\(o.name) is on call now."))
    }
}

@available(iOS 16.0, *)
struct CallLastMissedIntent: AppIntent {
    static var title: LocalizedStringResource = "Call my last missed customer"
    static var openAppWhenRun: Bool = true   // opens the missed-calls list; you tap to call. Siri never dials by itself.
    func perform() async throws -> some IntentResult & ProvidesDialog {
        queueLink("/dashboard/calls")
        return .result(dialog: "Opening your missed calls.")
    }
}

@available(iOS 16.0, *)
struct MarkJobCompleteIntent: AppIntent {
    static var title: LocalizedStringResource = "Mark job complete"
    static var openAppWhenRun: Bool = true   // confirm-before-write: completion is confirmed inside the app, not by voice.
    func perform() async throws -> some IntentResult & ProvidesDialog {
        queueLink("/tech/today")
        return .result(dialog: "Opening today's jobs. Confirm completion there.")
    }
}

@available(iOS 16.0, *)
struct VireekShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: ScheduleIntent(), phrases: ["What's my schedule in \(.applicationName)", "My \(.applicationName) schedule"],
                    shortTitle: "My schedule", systemImageName: "calendar")
        AppShortcut(intent: OnCallIntent(), phrases: ["Who's on call in \(.applicationName)"],
                    shortTitle: "Who's on call", systemImageName: "person.badge.clock")
        AppShortcut(intent: CallLastMissedIntent(), phrases: ["Call my last missed customer in \(.applicationName)"],
                    shortTitle: "Last missed call", systemImageName: "phone.arrow.down.left")
        AppShortcut(intent: MarkJobCompleteIntent(), phrases: ["Mark job complete in \(.applicationName)"],
                    shortTitle: "Mark job complete", systemImageName: "checkmark.circle")
    }
}
