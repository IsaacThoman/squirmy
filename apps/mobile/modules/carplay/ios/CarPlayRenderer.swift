import CarPlay
import UIKit

@MainActor
final class CarPlayRenderer {
  private struct RenderedRow {
    let model: CarPlayRow
    let item: CPListTemplateItem
  }

  private struct RenderedSection {
    let title: String?
    let rows: [RenderedRow]

    func hasSameLayout(as other: RenderedSection) -> Bool {
      title == other.title && rows.count == other.rows.count &&
        zip(rows, other.rows).allSatisfy { $0.item === $1.item }
    }
  }

  private final class ListState {
    var model: CarPlayList?
    var sections: [RenderedSection] = []
    var headerActions: [CarPlayRow] = []
  }

  private let artwork = CarPlayArtwork()
  private let lists = NSHashTable<CPListTemplate>.weakObjects()
  var traits: UITraitCollection
  var select: ((String, String, (() -> Void)?) -> Void)?

  init(traits: UITraitCollection) {
    self.traits = traits
  }

  var scale: CGFloat { max(traits.displayScale, 1) }
  var listImagePixels: Int { pixels(for: CPListItem.maximumImageSize) }

  var imageRowImagePixels: Int {
    if #available(iOS 26.0, *) {
      return pixels(for: CPListImageRowItemImageGridElement.maximumImageSize)
    }
    return pixels(for: CPListImageRowItem.maximumImageSize)
  }

  var headerImagePixels: Int {
    if #available(iOS 27.0, *) {
      return pixels(for: CPThumbnailImage.maximumImageSize(forAspectRatio: 1))
    }
    return Int(180 * scale)
  }

  var maximumImageRowItems: Int {
    if #available(iOS 17.4, *) { return Int(CPMaximumNumberOfGridImages) }
    return 0
  }

  func make(_ model: CarPlayList) -> CPListTemplate {
    let template = CPListTemplate(title: model.title, sections: [])
    template.userInfo = ListState()
    if model.id == "home" {
      template.assistantCellConfiguration = CPAssistantCellConfiguration(
        position: .bottom, visibility: .whileLimitedUIActive, assistantAction: .playMedia
      )
    }
    lists.add(template)
    render(model, into: template)
    return template
  }

  func id(of template: CPTemplate) -> String? {
    (template.userInfo as? ListState)?.model?.id
  }

  func update(_ model: CarPlayList) {
    for list in lists.allObjects where id(of: list) == model.id {
      render(model, into: list)
    }
  }

  func render(_ model: CarPlayList, into template: CPListTemplate) {
    guard let state = template.userInfo as? ListState else { return }
    let oldModel = state.model
    let actions = headerActions(for: model)
    let headerIds = Set(actions.map(\.id))
    var remaining = Int(CPListTemplate.maximumItemCount)
    var sections: [RenderedSection] = []
    for section in model.sections {
      guard remaining > 0, sections.count < CPListTemplate.maximumSectionCount else { break }
      let rows = section.items.filter { !headerIds.contains($0.id) }
      guard !rows.isEmpty else { continue }
      let previous = state.sections.indices.contains(sections.count) ? state.sections[sections.count] : nil
      let oldRows = previous?.title == section.title ? previous?.rows ?? [] : []
      let oldById = Dictionary(oldRows.map { ($0.model.id, $0) }, uniquingKeysWith: { first, _ in first })
      let items = rows.prefix(remaining).map { row in
        render(row, previous: oldById[row.id], templateId: model.id)
      }
      remaining -= items.count
      sections.append(RenderedSection(title: section.title, rows: items))
    }
    if sections.count != state.sections.count ||
      !zip(sections, state.sections).allSatisfy({ $0.hasSameLayout(as: $1) }) {
      template.updateSections(sections.map { CPListSection(items: $0.rows.map(\.item), header: $0.title, sectionIndexTitle: nil) })
    }
    if oldModel == nil || oldModel?.emptyTitle != model.emptyTitle {
      template.emptyViewTitleVariants = model.emptyTitle.map { [$0] } ?? []
    }
    if oldModel == nil || oldModel?.emptyDetail != model.emptyDetail {
      template.emptyViewSubtitleVariants = model.emptyDetail.map { [$0] } ?? []
    }
    if #available(iOS 18.4, *), oldModel?.loading != model.loading {
      template.showsSpinnerWhileEmpty = model.loading == true
    }
    if oldModel == nil || oldModel?.title != model.title || oldModel?.tabIcon != model.tabIcon {
      template.tabTitle = model.title
      template.tabImage = model.tabIcon.flatMap { UIImage(systemName: $0) }
    }
    if #available(iOS 26.4, *), oldModel?.header != model.header || state.headerActions != actions {
      template.listHeader = model.header.map { makeHeader($0, actions: actions, templateId: model.id, list: template) }
    }
    state.sections = sections
    state.headerActions = actions
    state.model = model
  }

  private func render(_ model: CarPlayRow, previous: RenderedRow?, templateId: String) -> RenderedRow {
    if let previous, previous.model == model { return previous }
    if let tiles = model.images?.prefix(maximumImageRowItems), !tiles.isEmpty {
      let row = makeRail(model.title, tiles: Array(tiles), templateId: templateId)
      row.isEnabled = model.enabled != false
      return RenderedRow(model: model, item: row)
    }

    let existing = previous?.item as? CPListItem
    let row = existing ?? CPListItem(text: model.title, detailText: model.detail)
    if existing == nil {
      row.playingIndicatorLocation = .trailing
      row.handler = { [weak self] _, completion in
        guard let select = self?.select else { completion(); return }
        select(templateId, model.id, completion)
      }
    }
    if row.text != model.title { row.setText(model.title) }
    if row.detailText != model.detail { row.setDetailText(model.detail) }
    if row.isEnabled != (model.enabled != false) { row.isEnabled = model.enabled != false }
    if row.isPlaying != (model.playing == true) { row.isPlaying = model.playing == true }
    let accessory: CPListItemAccessoryType = model.disclosure == true ? .disclosureIndicator : .none
    if row.accessoryType != accessory { row.accessoryType = accessory }
    if existing == nil || previous?.model.imageUrl != model.imageUrl || previous?.model.icon != model.icon {
      let symbol = model.icon.flatMap { UIImage(systemName: $0) }
      row.userInfo = model.imageUrl
      if let url = model.imageUrl {
        row.setImage(symbol ?? placeholder(pixels: listImagePixels))
        artwork.load(url, pixels: listImagePixels, scale: scale) { [weak row] image in
          guard let row, row.userInfo as? URL == url else { return }
          row.setImage(image)
        }
      } else {
        row.setImage(symbol)
      }
    }
    return RenderedRow(model: model, item: row)
  }

  private func makeRail(_ title: String, tiles: [CarPlayTile], templateId: String) -> CPListImageRowItem {
    let pixels = imageRowImagePixels
    let missing = placeholder(pixels: pixels)
    let row: CPListImageRowItem
    if #available(iOS 26.0, *) {
      let elements = tiles.map {
        CPListImageRowItemImageGridElement(image: missing, imageShape: .roundedRectangle, title: $0.title, accessorySymbolName: nil)
      }
      row = CPListImageRowItem(text: title, imageGridElements: elements, allowsMultipleLines: true)
    } else if #available(iOS 17.4, *) {
      row = CPListImageRowItem(text: title, images: tiles.map { _ in missing }, imageTitles: tiles.map(\.title))
    } else {
      row = CPListImageRowItem(text: title, images: tiles.map { _ in missing })
    }

    for (index, tile) in tiles.enumerated() {
      guard let url = tile.imageUrl else { continue }
      artwork.load(url, pixels: pixels, scale: scale) { [weak row] image in
        guard let row else { return }
        if #available(iOS 26.0, *) {
          let elements = row.elements
          guard elements.indices.contains(index) else { return }
          elements[index].image = image
          row.elements = elements
        } else {
          var images = row.gridImages
          guard images.indices.contains(index) else { return }
          images[index] = image
          row.update(images)
        }
      }
    }
    row.listImageRowHandler = { [weak self] _, index, completion in
      guard tiles.indices.contains(index), let select = self?.select else { completion(); return }
      select(templateId, tiles[index].id, completion)
    }
    return row
  }

  private func headerActions(for model: CarPlayList) -> [CarPlayRow] {
    guard #available(iOS 26.4, *), let header = model.header else { return [] }
    let rows = model.sections.flatMap(\.items)
    return Array(header.actionIds.compactMap { id in
      rows.first { $0.id == id && $0.icon.flatMap { UIImage(systemName: $0) } != nil }
    }.prefix(CPListTemplateDetailsHeader.maximumActionButtonCount))
  }

  @available(iOS 26.4, *)
  private func makeHeader(_ model: CarPlayHeader, actions: [CarPlayRow], templateId: String,
                          list: CPListTemplate) -> CPListTemplateDetailsHeader {
    let pixels = headerImagePixels
    let thumbnail = CPThumbnailImage(image: placeholder(pixels: pixels))
    let buttons = actions.compactMap { action -> CPButton? in
      guard let icon = action.icon, let image = UIImage(systemName: icon) else { return nil }
      image.accessibilityLabel = action.title
      let button = CPButton(image: image) { [weak self] _ in self?.select?(templateId, action.id, nil) }
      button.isEnabled = action.enabled != false
      return button
    }
    let header = CPListTemplateDetailsHeader(thumbnail: thumbnail, title: model.title, subtitle: model.detail, actionButtons: buttons)
    header.wantsAdaptiveBackgroundStyle = true
    if let url = model.imageUrl {
      artwork.load(url, pixels: pixels, scale: scale) { [weak list, weak header] image in
        guard let header else { return }
        header.thumbnail = CPThumbnailImage(image: image)
        if let list, list.listHeader === header { list.listHeader = header }
      }
    }
    return header
  }

  private func pixels(for size: CGSize) -> Int {
    let points = max(size.width, size.height)
    return Int(min(max(points * scale, 32), 800))
  }

  private func placeholder(pixels: Int) -> UIImage {
    CarPlayArtwork.placeholder(size: CGFloat(pixels) / scale, scale: scale, dark: traits.userInterfaceStyle == .dark)
  }
}
