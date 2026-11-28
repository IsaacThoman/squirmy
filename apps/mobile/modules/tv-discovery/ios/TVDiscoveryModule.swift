import ExpoModulesCore
import Foundation

public final class TVDiscoveryModule: Module {
  private var discovery: Discovery?

  public func definition() -> ModuleDefinition {
    Name("SquirmyTVDiscovery")
    Events("serversChanged")

    AsyncFunction("start") {
      guard self.discovery == nil else { return }
      self.discovery = Discovery { [weak self] servers in
        self?.sendEvent("serversChanged", ["servers": servers])
      }
    }.runOnQueue(.main)

    AsyncFunction("stop") {
      self.discovery = nil
    }.runOnQueue(.main)
  }
}

private final class Discovery: NSObject, NetServiceBrowserDelegate, NetServiceDelegate {
  private let browser = NetServiceBrowser()
  private var services: [String: NetService] = [:]
  private var resolved: [String: [String: String]] = [:]
  private let changed: ([[String: String]]) -> Void

  init(changed: @escaping ([[String: String]]) -> Void) {
    self.changed = changed
    super.init()
    browser.delegate = self
    browser.searchForServices(ofType: "_squirmy._tcp.", inDomain: "local.")
  }

  deinit {
    browser.stop()
    for service in services.values { service.stop() }
  }

  func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
    guard services[service.name] == nil, services.count < 32 else { return }
    services[service.name] = service
    service.delegate = self
    service.resolve(withTimeout: 5)
  }

  func netServiceBrowser(_ browser: NetServiceBrowser, didRemove service: NetService, moreComing: Bool) {
    services.removeValue(forKey: service.name)?.stop()
    if resolved.removeValue(forKey: service.name) != nil { publish() }
  }

  func netServiceDidResolveAddress(_ sender: NetService) {
    guard services[sender.name] === sender, let host = sender.hostName, sender.port > 0 else { return }
    // Keep the .local name so the connection can use whichever of its addresses is reachable.
    var address = URLComponents()
    address.scheme = "http"
    address.host = host.hasSuffix(".") ? String(host.dropLast()) : host
    address.port = sender.port
    guard let url = address.url?.absoluteString else { return }
    resolved[sender.name] = ["name": sender.name, "url": url]
    publish()
  }

  func netService(_ sender: NetService, didNotResolve errorDict: [String: NSNumber]) {
    if services[sender.name] === sender { services.removeValue(forKey: sender.name) }
  }

  private func publish() {
    changed(resolved.keys.sorted().compactMap { resolved[$0] })
  }
}
