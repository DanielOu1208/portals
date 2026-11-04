import AgentCore
import SwiftUI
import os

struct SidebarMessageMatches<Content: View, Row: View>: View {
    let query: String
    let fleet: Fleet
    let threads: [ThreadRecord]
    let titles: Set<ThreadKey>
    let showsEmpty: Bool
    let isVisible: Bool
    @ViewBuilder var content: () -> Content
    @ViewBuilder var row: (ThreadRecord, ThreadSearchHit) -> Row
    @State private var search = SidebarMessageSearch()
    @State private var hover = RowHover()
    @Environment(\.isOutOfSight) private var isOutOfSight

    private var hosts: [SidebarMessageSearch.Host] {
        var machines: Set<String> = []
        return fleet.hosts.compactMap { host in
            guard let backend = host.threadSearcher,
                  machines.insert(host.host.machineID ?? host.id.rawValue).inserted else { return nil }
            return .init(id: host.id, backend: backend)
        }
    }

    private struct Request: Equatable {
        var query: String
        var hosts: [HostID]
        var isVisible: Bool
    }

    var body: some View {
        let isVisible = self.isVisible && !isOutOfSight
        let hosts = isVisible ? self.hosts : []
        ScrollView {
            LazyVStack(alignment: .leading, spacing: RowMetrics.spacing) {
                content()
                MessageSearchGroup(
                    search: search, query: query, threads: threads, titles: titles, showsEmpty: showsEmpty, row: row
                )
            }
            .threadRowHover(hover)
            .padding(.horizontal, RowMetrics.inset)
            .padding(.top, RowMetrics.blockGap)
            .padding(.bottom, Theme.grid * 2)
        }
        .scrollDismissesKeyboard(.immediately)
        .frame(maxHeight: .infinity, alignment: .top)
        .task(id: Request(query: query, hosts: hosts.map(\.id), isVisible: isVisible)) {
            await search.search(query, hosts: hosts, isVisible: isVisible) {
                AppLog.chat.error("Message search failed")
            }
        }
    }
}

private struct MessageSearchGroup<Row: View>: View {
    let search: SidebarMessageSearch
    let query: String
    let threads: [ThreadRecord]
    let titles: Set<ThreadKey>
    let showsEmpty: Bool
    @ViewBuilder var row: (ThreadRecord, ThreadSearchHit) -> Row

    var body: some View {
        let matches = search.matches(for: query, in: threads, excluding: titles)
        if !matches.isEmpty {
            GroupTitle(text: "In messages")
            ForEach(matches) { match in
                row(match.record, match.hit)
            }
        } else if showsEmpty {
            ContentUnavailableView.search(text: query)
                .padding(.top, Theme.grid * 4)
        }
    }
}
