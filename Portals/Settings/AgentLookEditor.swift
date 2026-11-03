import AgentCore
import SwiftUI

/// Choose an agent's body shape, resting face and colour, with the avatar itself as
/// the preview. A coding agent can show its maker's logo instead. Changes apply as they
/// are made.
struct AgentLookEditor: View {
    let agent: Agent
    /// The coding agent's logo; nil for every other agent.
    let logo: CodingAgentLogo?
    @State private var look: AgentLook
    var onChange: (AgentLook) -> Void

    @Environment(\.dismiss) private var dismiss

    init(agent: Agent, look: AgentLook, logo: CodingAgentLogo? = nil, onChange: @escaping (AgentLook) -> Void) {
        self.agent = agent
        self.logo = logo
        _look = State(initialValue: look)
        self.onChange = onChange
    }

    private var style: AgentAvatarStyle { AgentLookCatalogue.style(for: look, logo: logo) }

    /// On is no setting at all, since the logo is what an agent that has one wears; off is kept.
    private var showsLogo: Binding<Bool> {
        Binding { look.shows(logo) } set: { look.showsLogo = $0 ? nil : false }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: Theme.grid * 3) {
                    AgentAvatarView(mood: .idle, size: 140, style: style, accessibilityLabel: "\(agent.displayName)'s avatar")
                        .padding(.top, Theme.grid)

                    if let logo {
                        Toggle("Show the \(logo.brand) logo instead", isOn: showsLogo.animation(.smooth(duration: 0.25)))
                            // A switch on a Mac too, where a toggle is a checkbox unless told.
                            .toggleStyle(.switch)
                            .padding(.horizontal, Theme.grid * 2)
                            .padding(.vertical, Theme.grid * 1.5)
                            .background(Theme.cardFill, in: Theme.cardShape)
                            .pageMargins()
                            .accessibilityIdentifier("shows-logo")
                    }

                    // The avatar's own choices, which the logo hides while it is shown.
                    VStack(spacing: Theme.grid * 3) {
                        section("Shape") {
                            ForEach(AgentLookCatalogue.shapes.indices, id: \.self) { index in
                                choice(isSelected: look.shape == index, label: AgentLookCatalogue.shapes[index].rawValue) {
                                    look.shape = index
                                } content: {
                                    AgentAvatarView(state: .idle, frozenAt: 1, size: 52, style: styled { $0.shape = index })
                                }
                            }
                        }

                        section("Face") {
                            ForEach(AgentLookCatalogue.faces.indices, id: \.self) { index in
                                choice(isSelected: look.face == index, label: AgentLookCatalogue.faces[index].rawValue) {
                                    look.face = index
                                } content: {
                                    AgentAvatarView(state: .idle, frozenAt: 1, size: 52, style: styled { $0.face = index })
                                }
                            }
                        }
                    }
                    .disabled(style.showsLogo)
                    .opacity(style.showsLogo ? 0.4 : 1)

                    section("Colour") {
                        ForEach(AgentLookCatalogue.tints.indices, id: \.self) { index in
                            let tint = AgentLookCatalogue.tints[index]
                            choice(isSelected: look.tint == index, label: tint.name) {
                                look.tint = index
                                if look.showsLogo == true { look.showsLogo = nil }
                            } content: {
                                Circle()
                                    .fill(tint.color.map(AnyShapeStyle.init) ?? AnyShapeStyle(.primary))
                                    .frame(width: 34, height: 34)
                                    .frame(width: 52, height: 52)
                            }
                        }
                    }
                }
                .padding(.bottom, Theme.grid * 3)
            }
            .background { AmbientGradient(tint: style.tint, mood: .working) }
            .navigationTitle(agent.displayName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .onChange(of: look) { _, look in onChange(look) }
        }
        .presentationDetents([.large])
        .sheetOnMac(height: 720)
    }

    /// The current look with one thing changed, for a choice's own preview.
    private func styled(_ change: (inout AgentLook) -> Void) -> AgentAvatarStyle {
        var copy = look
        change(&copy)
        return AgentLookCatalogue.style(for: copy)
    }

    private func section(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: Theme.grid) {
            Text(title)
                .font(.app.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, Theme.margin)
            ScrollView(.horizontal) {
                HStack(spacing: Theme.grid) {
                    content()
                }
                .padding(.horizontal, Theme.margin)
            }
            .scrollIndicators(.hidden)
        }
    }

    private func choice(
        isSelected: Bool,
        label: String,
        action: @escaping () -> Void,
        @ViewBuilder content: () -> some View
    ) -> some View {
        Button(action: action) {
            content()
                .padding(Theme.grid / 2)
                .background(Theme.cardFill, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .strokeBorder(.primary, lineWidth: isSelected ? 2 : 0)
                }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}
