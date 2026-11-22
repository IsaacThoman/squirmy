import AVKit
import ExpoModulesCore

/**
 * The system's AirPlay and Bluetooth output picker. Squirmy's own device list chooses which
 * device plays; this chooses where this phone's sound goes.
 */
class RoutePickerView: ExpoView {
  let picker = AVRoutePickerView()

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    picker.prioritizesVideoDevices = false
    addSubview(picker)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    picker.frame = bounds
  }
}
