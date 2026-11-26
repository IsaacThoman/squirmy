import CarPlay
import MediaPlayer
import UIKit

/// The car scene can connect before React Native starts. It owns the interface and always
/// installs a root, then the Expo module publishes app data into that same template stack.
@MainActor
public final class CarPlayRuntime: NSObject, CPInterfaceControllerDelegate, @preconcurrency CPNowPlayingTemplateObserver,
                                  CPSessionConfigurationDelegate, CPTabBarTemplateDelegate {
  public static let shared = CarPlayRuntime()

  typealias EventSink = (String, [String: Any]) -> Void
  typealias NavigationCompletion = (Bool, Error?) -> Void

  private struct MediaRequest {
    let payload: [String: Any]
    let completion: (Bool) -> Void
  }

  private var controller: CPInterfaceController?
  private weak var scene: CPTemplateApplicationScene?
  private var renderer: CarPlayRenderer?
  private var carConfiguration: CPSessionConfiguration?
  private var tabBar: CPTabBarTemplate?
  private var generation = 0
  private var active = false
  private var selections: [String: () -> Void] = [:]
  private var mediaRequests: [String: MediaRequest] = [:]
  private var unreadMediaIds: [String] = []
  private var nowPlayingState = CarPlayNowPlaying()
  private var installingRoot = false
  private var afterRootInstalled: [() -> Void] = []
  private let maximumDepth = 5
  private lazy var shuffleButton = CPNowPlayingShuffleButton { [weak self] _ in self?.selectNowPlaying("shuffle") }
  private lazy var repeatButton = CPNowPlayingRepeatButton { [weak self] _ in self?.selectNowPlaying("repeat") }
  private lazy var saveButton = imageButton(
    "heart", label: NSLocalizedString("Save to library", comment: "CarPlay playback control"), itemId: "like"
  )
  private lazy var removeButton = imageButton(
    "heart.fill", label: NSLocalizedString("Remove from library", comment: "CarPlay playback control"), itemId: "like"
  )

  private weak var listener: AnyObject?
  private var emit: EventSink?

  public func connect(_ controller: CPInterfaceController, scene: CPTemplateApplicationScene) {
    if let previous = self.controller { disconnect(previous) }
    self.controller = controller
    self.scene = scene
    controller.delegate = self
    carConfiguration = CPSessionConfiguration(delegate: self)
    generation += 1
    active = scene.activationState == .foregroundActive
    let renderer = makeRenderer(for: controller)
    self.renderer = renderer

    CPNowPlayingTemplate.shared.add(self)
    applyNowPlaying()

    // Set a root in the native scene connection callback, including when no JS has run yet.
    let first = renderer.make(CarPlayList(
      id: "_launch",
      title: "Squirmy",
      tabIcon: "house",
      emptyTitle: NSLocalizedString("Opening Squirmy…", comment: "CarPlay startup"),
      loading: true
    ))
    installRoot(first, on: controller) { _, error in
      if let error { NSLog("[CarPlay] Initial root: %@", String(describing: error)) }
    }
    emitState()
  }

  public func disconnect(_ controller: CPInterfaceController) {
    guard self.controller === controller else { return }
    CPNowPlayingTemplate.shared.remove(self)
    CPNowPlayingTemplate.shared.updateNowPlayingButtons([])
    CPNowPlayingTemplate.shared.isUpNextButtonEnabled = false
    CPNowPlayingTemplate.shared.isAlbumArtistButtonEnabled = false
    controller.delegate = nil
    self.controller = nil
    scene = nil
    tabBar = nil
    renderer = nil
    carConfiguration = nil
    active = false
    installingRoot = false
    let pending = afterRootInstalled
    afterRootInstalled.removeAll()
    pending.forEach { $0() }
    let outstanding = selections
    selections.removeAll()
    outstanding.values.forEach { $0() }
    emitState()
  }

  public func updateActivation(_ scene: CPTemplateApplicationScene) {
    guard self.scene === scene else { return }
    let next = scene.activationState == .foregroundActive
    guard active != next else { return }
    active = next
    emitState()
  }

  func listen(_ listener: AnyObject, send: @escaping EventSink) {
    self.listener = listener
    emit = send
  }

  func stopListening(_ listener: AnyObject) {
    guard self.listener === listener else { return }
    self.listener = nil
    emit = nil
  }

  func state() -> [String: Any] {
    [
      "connected": controller != nil,
      "active": active,
      "generation": generation,
      "maximumItems": CPListTemplate.maximumItemCount,
      "maximumSections": CPListTemplate.maximumSectionCount,
      "maximumTabCount": CPTabBarTemplate.maximumTabCount,
      "maximumImageRowItems": renderer?.maximumImageRowItems ?? 0,
      "listImagePixels": renderer?.listImagePixels ?? 120,
      "imageRowImagePixels": renderer?.imageRowImagePixels ?? 240,
      "headerImagePixels": renderer?.headerImagePixels ?? 360,
    ]
  }

  func setRoot(_ models: [CarPlayList], reset: Bool, completion: @escaping NavigationCompletion) {
    guard let controller, let renderer else { completion(false, nil); return }
    if installingRoot {
      afterRootInstalled.append { [weak self] in self?.setRoot(models, reset: reset, completion: completion) }
      return
    }
    let models = Array(models.prefix(max(1, CPTabBarTemplate.maximumTabCount)))
    guard let first = models.first else { completion(false, nil); return }
    if !reset, let tabBar {
      let oldTabs = tabBar.templates
      let tabs = models.map { model in
        if let existing = oldTabs.first(where: { renderer.id(of: $0) == model.id }) as? CPListTemplate {
          renderer.render(model, into: existing)
          return existing
        }
        return renderer.make(model)
      }
      if tabs.count != oldTabs.count || !zip(tabs, oldTabs).allSatisfy({ $0 === $1 }) {
        tabBar.updateTemplates(tabs)
      }
      completion(true, nil)
      return
    }

    let nextRenderer = reset ? makeRenderer(for: controller) : renderer
    if reset {
      self.renderer = nextRenderer
    }
    // During setup/sign-in we allow a single list root with no tab icon.
    let root: CPTemplate
    if (models.count == 1 && first.tabIcon == nil) || CPTabBarTemplate.maximumTabCount == 0 {
      root = nextRenderer.make(first)
      tabBar = nil
    } else {
      let tabs = CPTabBarTemplate(templates: models.map { nextRenderer.make($0) })
      tabs.delegate = self
      tabBar = tabs
      root = tabs
    }
    installRoot(root, on: controller, completion: completion)
  }

  func update(_ model: CarPlayList) {
    renderer?.update(model)
  }

  func push(_ model: CarPlayList, completion: @escaping NavigationCompletion) {
    guard let controller, let renderer else { completion(false, nil); return }
    if installingRoot {
      afterRootInstalled.append { [weak self] in self?.push(model, completion: completion) }
      return
    }
    if let existing = controller.templates.last(where: { renderer.id(of: $0) == model.id }) as? CPListTemplate {
      renderer.render(model, into: existing)
      reveal(existing, on: controller, completion: completion)
      return
    }
    reveal(renderer.make(model), on: controller, completion: completion)
  }

  func showNowPlaying(completion: @escaping NavigationCompletion) {
    guard let controller else { completion(false, nil); return }
    if installingRoot {
      afterRootInstalled.append { [weak self] in self?.showNowPlaying(completion: completion) }
      return
    }
    reveal(CPNowPlayingTemplate.shared, on: controller, completion: completion)
  }

  func pop(completion: @escaping NavigationCompletion) {
    guard let controller, controller.templates.count > 1 else { completion(false, nil); return }
    controller.popTemplate(animated: true, completion: completion)
  }

  func popToRoot(completion: @escaping NavigationCompletion) {
    guard let controller, controller.templates.count > 1 else { completion(true, nil); return }
    controller.popToRootTemplate(animated: true, completion: completion)
  }

  private func reveal(_ template: CPTemplate, on controller: CPInterfaceController,
                      completion: @escaping NavigationCompletion) {
    // End at the existing Now Playing screen when a row is chosen in Up Next. A template
    // already on the active stack can't be pushed a second time.
    if controller.topTemplate === template {
      completion(true, nil)
    } else if controller.templates.contains(where: { $0 === template }) {
      controller.pop(to: template, animated: true, completion: completion)
    } else if controller.templates.count < maximumDepth {
      controller.pushTemplate(template, animated: true, completion: completion)
    } else {
      completion(false, nil)
    }
  }

  func showAlert(title: String, detail: String?, completion: @escaping NavigationCompletion) {
    guard let controller, controller.presentedTemplate == nil else { completion(false, nil); return }
    if installingRoot {
      afterRootInstalled.append { [weak self] in self?.showAlert(title: title, detail: detail, completion: completion) }
      return
    }
    let ok = CPAlertAction(title: NSLocalizedString("OK", comment: "Dismiss CarPlay alert"), style: .default) { _ in }
    let titles = detail.map { ["\(title)\n\($0)", title] } ?? [title]
    let alert = CPAlertTemplate(titleVariants: titles, actions: [ok])
    controller.presentTemplate(alert, animated: true, completion: completion)
  }

  func finishSelection(_ requestId: String) {
    selections.removeValue(forKey: requestId)?()
  }

  func setNowPlaying(_ state: CarPlayNowPlaying) {
    guard state != nowPlayingState else { return }
    nowPlayingState = state
    if controller != nil { applyNowPlaying() }
  }

  private func applyNowPlaying() {
    let template = CPNowPlayingTemplate.shared
    template.isUpNextButtonEnabled = nowPlayingState.hasTrack && nowPlayingState.upNext
    template.isAlbumArtistButtonEnabled = nowPlayingState.hasTrack && nowPlayingState.album
    guard nowPlayingState.hasTrack else {
      template.updateNowPlayingButtons([])
      return
    }
    let commands = MPRemoteCommandCenter.shared()
    commands.changeShuffleModeCommand.currentShuffleType = nowPlayingState.shuffle ? .items : .off
    switch nowPlayingState.repeatMode {
    case "one": commands.changeRepeatModeCommand.currentRepeatType = .one
    case "all": commands.changeRepeatModeCommand.currentRepeatType = .all
    default: commands.changeRepeatModeCommand.currentRepeatType = .off
    }
    var buttons: [CPNowPlayingButton] = [shuffleButton, repeatButton]
    if let liked = nowPlayingState.liked, let heart = liked ? removeButton : saveButton {
      heart.isSelected = liked
      buttons.append(heart)
    }
    // Preserve unchanged native controls and rotary focus when a playback flag changes.
    let current = template.nowPlayingButtons
    if buttons.count != current.count || !zip(buttons, current).allSatisfy({ $0 === $1 }) {
      template.updateNowPlayingButtons(buttons)
    }
  }

  private func imageButton(_ symbol: String, label: String, itemId: String) -> CPNowPlayingButton? {
    guard let image = UIImage(systemName: symbol) else { return nil }
    image.accessibilityLabel = label
    return CPNowPlayingImageButton(image: image) { [weak self] _ in self?.selectNowPlaying(itemId) }
  }

  public func nowPlayingTemplateUpNextButtonTapped(_ nowPlayingTemplate: CPNowPlayingTemplate) {
    selectNowPlaying("up-next")
  }

  public func nowPlayingTemplateAlbumArtistButtonTapped(_ nowPlayingTemplate: CPNowPlayingTemplate) {
    selectNowPlaying("album")
  }

  public func templateDidAppear(_ template: CPTemplate, animated: Bool) {
    let visible = (template as? CPTabBarTemplate)?.selectedTemplate ?? template
    emitTemplateAppearance(visible)
  }

  public func tabBarTemplate(_ tabBarTemplate: CPTabBarTemplate, didSelect selectedTemplate: CPTemplate) {
    // The controller may still be finishing the selected tab's navigation change.
    DispatchQueue.main.async { [weak self, weak tabBarTemplate] in
      guard let self, let tabBarTemplate, self.tabBar === tabBarTemplate,
            tabBarTemplate.selectedTemplate === selectedTemplate else { return }
      self.templateDidAppear(self.controller?.topTemplate ?? selectedTemplate, animated: false)
    }
  }

  private func templateId(of template: CPTemplate) -> String? {
    let visible = (template as? CPTabBarTemplate)?.selectedTemplate ?? template
    return visible === CPNowPlayingTemplate.shared ? "now-playing" : renderer?.id(of: visible)
  }

  private func emitTemplateAppearance(_ visible: CPTemplate) {
    guard let id = templateId(of: visible) else { return }
    var stack = controller?.templates.compactMap(templateId) ?? []
    if !stack.contains(id) { stack.append(id) }
    emit?("onTemplateAppear", ["templateId": id, "stack": stack, "generation": generation])
  }

  public func sessionConfiguration(_ sessionConfiguration: CPSessionConfiguration,
                                   limitedUserInterfacesChanged limitedUserInterfaces: CPLimitableUserInterface) {
    emitState()
  }

  public func sessionConfiguration(_ sessionConfiguration: CPSessionConfiguration, contentStyleChanged contentStyle: CPContentStyle) {
    guard let controller else { return }
    renderer?.traits = controller.carTraitCollection
    emitState()
  }

  public func publishMediaIntent(query: String?, mediaType: String?, shuffle: Bool?, resume: Bool,
                                 completion: @escaping (Bool) -> Void) {
    let id = UUID().uuidString
    let timeout: TimeInterval = 12
    var payload: [String: Any] = [
      "id": id,
      "resume": resume,
      "expiresAt": Date().addingTimeInterval(timeout).timeIntervalSince1970 * 1000,
    ]
    payload["query"] = query
    payload["mediaType"] = mediaType
    payload["shuffle"] = shuffle
    mediaRequests[id] = MediaRequest(payload: payload, completion: completion)
    unreadMediaIds.append(id)
    emit?("onMediaIntent", payload)
    DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak self] in
      self?.completeMediaIntent(id, success: false)
    }
  }

  func takeMediaIntents() -> [[String: Any]] {
    let payloads = unreadMediaIds.compactMap { mediaRequests[$0]?.payload }
    unreadMediaIds.removeAll()
    return payloads
  }

  func completeMediaIntent(_ id: String, success: Bool) {
    unreadMediaIds.removeAll { $0 == id }
    mediaRequests.removeValue(forKey: id)?.completion(success)
  }

  private func installRoot(_ root: CPTemplate, on controller: CPInterfaceController,
                           completion: @escaping NavigationCompletion) {
    installingRoot = true
    controller.setRootTemplate(root, animated: false) { [weak self, weak controller] success, error in
      guard let self, let controller, self.controller === controller else {
        completion(false, nil)
        return
      }
      self.installingRoot = false
      completion(success, error)
      let pending = self.afterRootInstalled
      self.afterRootInstalled.removeAll()
      pending.forEach { $0() }
    }
  }

  private func makeRenderer(for controller: CPInterfaceController) -> CarPlayRenderer {
    let renderer = CarPlayRenderer(traits: controller.carTraitCollection)
    renderer.select = { [weak self, weak renderer] templateId, itemId, completion in
      guard let self, self.renderer === renderer else { completion?(); return }
      self.select(templateId, itemId: itemId, completion: completion)
    }
    return renderer
  }

  private func emitState() {
    emit?("onStateChange", state())
  }

  private func selectNowPlaying(_ itemId: String) {
    select("now-playing", itemId: itemId, completion: nil)
  }

  private func select(_ templateId: String, itemId: String, completion: (() -> Void)?) {
    guard controller != nil, listener != nil, let emit else { completion?(); return }
    let requestId = UUID().uuidString
    if let completion {
      selections[requestId] = completion
      DispatchQueue.main.asyncAfter(deadline: .now() + 12) { [weak self] in self?.finishSelection(requestId) }
    }
    emit("onSelect", ["templateId": templateId, "itemId": itemId, "requestId": requestId, "generation": generation])
  }
}
