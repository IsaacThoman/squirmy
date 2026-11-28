import ExpoModulesCore
import UIKit

public class TVMenuModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SquirmyTVMenu")

    View(TVMenuView.self) {
      Events("onAction")
      Prop("title") { (view: TVMenuView, title: String?) in
        view.title = title ?? ""
      }
      Prop("actions") { (view: TVMenuView, actions: [MenuAction]?) in
        view.actions = actions ?? []
      }
    }

    View(TVButtonView.self) {
      Events("onPress", "onAction")
      Prop("title") { (view: TVButtonView, title: String?) in
        view.title = title
      }
      Prop("systemImage") { (view: TVButtonView, image: String?) in
        view.systemImage = image
      }
      Prop("prominent") { (view: TVButtonView, prominent: Bool?) in
        view.prominent = prominent ?? false
      }
      Prop("tint") { (view: TVButtonView, tint: UIColor?) in
        view.tint = tint
      }
      Prop("actions") { (view: TVButtonView, actions: [MenuAction]?) in
        view.actions = actions ?? []
      }
      Prop("enabled") { (view: TVButtonView, enabled: Bool?) in
        view.button.isEnabled = enabled ?? true
      }
    }
  }
}

struct MenuAction: Record {
  @Field var id: String = ""
  @Field var title: String = ""
  @Field var subtitle: String?
  /** An SF Symbol. */
  @Field var image: String?
  @Field var destructive: Bool = false
  @Field var disabled: Bool = false
  /** On: a checkmark. */
  @Field var checked: Bool = false
  /** A submenu, such as the playlists under Add to Playlist. */
  @Field var children: [MenuAction]?
  /** Shown inline, set apart by separators, rather than as a submenu. */
  @Field var inline: Bool = false
}

/**
 * Gives the focusable view inside it the system's context menu: hold the remote's click on it
 * and the glass menu opens beside it, as across tvOS. React Native's `Pressable` is that view;
 * a menu choice comes back as `onAction` with the action's id.
 */
/** A menu entry, its submenus and inline groups included; `choose` gets the id of what was picked. */
func menuElement(_ action: MenuAction, choose: @escaping (String) -> Void) -> UIMenuElement {
  let image = action.image.flatMap { UIImage(systemName: $0) }
  if let children = action.children, !children.isEmpty || !action.inline {
    return UIMenu(title: action.title, image: image, options: action.inline ? .displayInline : [], children: children.map { menuElement($0, choose: choose) })
  }
  let item = UIAction(title: action.title, image: image) { _ in choose(action.id) }
  if let subtitle = action.subtitle { item.subtitle = subtitle }
  var attributes: UIMenuElement.Attributes = []
  if action.destructive { attributes.insert(.destructive) }
  if action.disabled { attributes.insert(.disabled) }
  item.attributes = attributes
  item.state = action.checked ? .on : .off
  return item
}

final class TVMenuView: ExpoView, UIContextMenuInteractionDelegate {
  let onAction = EventDispatcher()
  var title = ""
  var actions: [MenuAction] = [] { didSet { attach() } }
  private lazy var interaction = UIContextMenuInteraction(delegate: self)
  private weak var host: UIView?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = false
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    // Off screen, the menu lets go of its view: React Native reuses views, and one given to
    // another row must not keep this row's menu.
    if window == nil { detach() } else { attach() }
  }

  deinit {
    host?.removeInteraction(interaction)
  }

  private func detach() {
    host?.removeInteraction(interaction)
    host = nil
  }

  override func didAddSubview(_ subview: UIView) {
    super.didAddSubview(subview)
    attach()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    if host == nil || host?.isDescendant(of: self) != true { attach() }
  }

  /** Moves the interaction onto the first focusable view inside, or takes it off without actions. */
  private func attach() {
    let target = actions.isEmpty || window == nil ? nil : focusable(in: self)
    if target === host, target != nil { return }
    host?.removeInteraction(interaction)
    host = target
    target?.addInteraction(interaction)
  }

  private func focusable(in view: UIView) -> UIView? {
    for child in view.subviews {
      if child.canBecomeFocused { return child }
      if let found = focusable(in: child) { return found }
    }
    return nil
  }

  private func element(_ action: MenuAction) -> UIMenuElement {
    menuElement(action) { [weak self] id in self?.onAction(["id": id]) }
  }

  func contextMenuInteraction(_ interaction: UIContextMenuInteraction, configurationForMenuAtLocation location: CGPoint) -> UIContextMenuConfiguration? {
    guard !actions.isEmpty else { return nil }
    return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
      guard let self else { return nil }
      return UIMenu(title: self.title, children: self.actions.map(self.element))
    }
  }
}

/**
 * The system's button: the frosted platter that turns white and lifts when focused, with the
 * system's motion. With `actions` it opens that menu when clicked, as "More" buttons do.
 */
final class TVButtonView: ExpoView {
  let onPress = EventDispatcher()
  let onAction = EventDispatcher()
  let button = UIButton(type: .system)
  var title: String? { didSet { configure() } }
  var systemImage: String? { didSet { configure() } }
  var prominent = false { didSet { configure() } }
  var tint: UIColor? { didSet { configure() } }
  var actions: [MenuAction] = [] { didSet { configure() } }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = false
    button.addAction(UIAction { [weak self] _ in self?.onPress([:]) }, for: .primaryActionTriggered)
    addSubview(button)
    configure()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    button.frame = bounds
  }

  private func configure() {
    var configuration = prominent ? UIButton.Configuration.borderedProminent() : UIButton.Configuration.bordered()
    configuration.cornerStyle = .capsule
    configuration.title = title
    // One line, always: the view's width comes from React Native, which cannot measure the button.
    configuration.titleLineBreakMode = .byTruncatingTail
    if let systemImage {
      configuration.image = UIImage(systemName: systemImage)
      configuration.imagePadding = 12
    }
    if let tint { configuration.baseForegroundColor = tint }
    if title == nil { configuration.contentInsets = .zero }
    button.configuration = configuration
    button.accessibilityLabel = accessibilityLabel ?? title
    if actions.isEmpty {
      button.menu = nil
      button.showsMenuAsPrimaryAction = false
    } else {
      button.menu = UIMenu(children: actions.map { menuElement($0) { [weak self] id in self?.onAction(["id": id]) } })
      button.showsMenuAsPrimaryAction = true
    }
  }
}
