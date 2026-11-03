// ios/VireekWidgets/VireekWidgets.swift — Widget Extension target "VireekWidgets" (min iOS 16.2).
// Widgets read ONLY the snapshot the app saved in the App Group (no network, no auth in the extension).
// Refresh strategy: the app calls reloadAllTimelines() after every snapshot write; as a safety net each timeline asks the
// system to refresh after 30 minutes. Entries older than 6 h are labelled "Updated …" instead of passing as current.
import WidgetKit
import SwiftUI
import ActivityKit

// MARK: - Timeline
struct SnapshotEntry: TimelineEntry {
    let date: Date
    let snapshot: VireekSnapshot?
    let savedAt: Date?
}

struct SnapshotProvider: TimelineProvider {
    func placeholder(in context: Context) -> SnapshotEntry { SnapshotEntry(date: .now, snapshot: nil, savedAt: nil) }
    func getSnapshot(in context: Context, completion: @escaping (SnapshotEntry) -> Void) { completion(current()) }
    func getTimeline(in context: Context, completion: @escaping (Timeline<SnapshotEntry>) -> Void) {
        completion(Timeline(entries: [current()], policy: .after(Date().addingTimeInterval(30 * 60))))
    }
    private func current() -> SnapshotEntry {
        let s = VireekSnapshot.load()
        let saved = s.flatMap { ISO8601DateFormatter.vk.date(from: $0.generated_at) }
        return SnapshotEntry(date: .now, snapshot: s, savedAt: saved)
    }
}

extension ISO8601DateFormatter {
    static let vk: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}

// MARK: - Shared view helpers
extension View {
    @ViewBuilder func vkBackground() -> some View {
        if #available(iOS 17.0, *) { containerBackground(.fill.tertiary, for: .widget) } else { background(Color(.secondarySystemBackground)) }
    }
}

struct Frame<Content: View>: View {
    let title: String, link: String, stale: String?
    @ViewBuilder var content: Content
    @Environment(\.widgetFamily) private var family
    var body: some View {
        Group {
            switch family {
            case .accessoryInline: content
            case .accessoryCircular, .accessoryRectangular:
                VStack(alignment: .leading, spacing: 2) { Text(title).font(.caption2).foregroundStyle(.secondary); content }
            default:
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).font(.caption).foregroundStyle(.secondary)   // text styles → Dynamic Type
                    content
                    if let stale { Text(stale).font(.caption2).foregroundStyle(.secondary) }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .widgetURL(URL(string: link))
        .vkBackground()
    }
}

private func staleText(_ e: SnapshotEntry) -> String? {
    guard let saved = e.savedAt, e.date.timeIntervalSince(saved) > 6 * 3600 else { return nil }
    return "Updated " + saved.formatted(.relative(presentation: .named))
}

private struct SignedOut: View {
    var body: some View { Text("Open Vireek to sign in").font(.footnote).foregroundStyle(.secondary) }
}

// MARK: - Today
struct TodayView: View {
    let e: SnapshotEntry
    var body: some View {
        Frame(title: "Today", link: "vireek://dashboard/calls", stale: staleText(e)) {
            if let s = e.snapshot {
                Text("\(s.calls_answered) answered").font(.headline)
                Text("\(s.calls_missed) missed").font(.subheadline)
                Text((Double(s.revenue_recovered_cents) / 100).formatted(.currency(code: Locale.current.currency?.identifier ?? "USD")) + " recovered")
                    .font(.caption).foregroundStyle(.secondary)
            } else { SignedOut() }
        }
    }
}
struct TodayWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "VireekToday", provider: SnapshotProvider()) { TodayView(e: $0) }
            .configurationDisplayName("Today").description("Calls answered, missed and revenue recovered.")
            .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular, .accessoryInline])
    }
}

// MARK: - Next job
struct NextJobView: View {
    let e: SnapshotEntry
    var body: some View {
        Frame(title: "Next job", link: "vireek://tech/today", stale: staleText(e)) {
            if let s = e.snapshot {
                if let j = s.next_job {
                    Text(Date(timeIntervalSince1970: j.scheduled_ms / 1000).formatted(date: .omitted, time: .shortened)).font(.headline)
                    Text(j.service).font(.subheadline).lineLimit(2)
                } else { Text("No jobs left today").font(.subheadline) }
            } else { SignedOut() }
        }
    }
}
struct NextJobWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "VireekNextJob", provider: SnapshotProvider()) { NextJobView(e: $0) }
            .configurationDisplayName("Next job").description("Your next scheduled job.")
            .supportedFamilies([.systemSmall, .accessoryRectangular, .accessoryInline])
    }
}

// MARK: - On call
struct OnCallView: View {
    let e: SnapshotEntry
    var body: some View {
        Frame(title: "On call", link: "vireek://dashboard/on-call", stale: staleText(e)) {
            if let s = e.snapshot {
                if let o = s.on_call {
                    Text(o.is_me ? "You" : o.name).font(.headline).lineLimit(1)
                    Text("is on call now").font(.caption).foregroundStyle(.secondary)
                } else { Text("No rotation set up").font(.subheadline) }
            } else { SignedOut() }
        }
    }
}
struct OnCallWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "VireekOnCall", provider: SnapshotProvider()) { OnCallView(e: $0) }
            .configurationDisplayName("On-call status").description("Who is on call right now.")
            .supportedFamilies([.systemSmall, .accessoryRectangular, .accessoryCircular])
    }
}

// MARK: - Live Activity (lock screen + Dynamic Island)
struct CallLiveView: View {
    let state: VireekCallAttributes.ContentState
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: state.emergency ? "exclamationmark.triangle.fill" : "phone.fill")
                .foregroundStyle(state.emergency ? .red : .accentColor)
            VStack(alignment: .leading, spacing: 2) {
                Text(state.headline).font(.headline)
                Text(state.detail).font(.subheadline).foregroundStyle(.secondary)
            }
            Spacer()
            if state.stage != "ended" {
                Text(Date(timeIntervalSince1970: TimeInterval(state.startedAt)), style: .timer)
                    .monospacedDigit().font(.title3).multilineTextAlignment(.trailing).frame(maxWidth: 80)
            }
        }.padding()
    }
}

struct VireekCallLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: VireekCallAttributes.self) { ctx in
            CallLiveView(state: ctx.state).widgetURL(URL(string: "vireek://dashboard/live-calls"))
        } dynamicIsland: { ctx in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) { Image(systemName: ctx.state.emergency ? "exclamationmark.triangle.fill" : "phone.fill") }
                DynamicIslandExpandedRegion(.center) { Text(ctx.state.headline).font(.headline) }
                DynamicIslandExpandedRegion(.trailing) {
                    if ctx.state.stage != "ended" { Text(Date(timeIntervalSince1970: TimeInterval(ctx.state.startedAt)), style: .timer).monospacedDigit() }
                }
                DynamicIslandExpandedRegion(.bottom) { Text(ctx.state.detail).font(.subheadline) }
            } compactLeading: {
                Image(systemName: "phone.fill")
            } compactTrailing: {
                if ctx.state.stage != "ended" { Text(Date(timeIntervalSince1970: TimeInterval(ctx.state.startedAt)), style: .timer).monospacedDigit().frame(maxWidth: 48) }
            } minimal: { Image(systemName: "phone.fill") }
            .widgetURL(URL(string: "vireek://dashboard/live-calls"))
        }
    }
}

@main
struct VireekWidgetBundle: WidgetBundle {
    var body: some Widget {
        TodayWidget()
        NextJobWidget()
        OnCallWidget()
        VireekCallLiveActivity()
    }
}
