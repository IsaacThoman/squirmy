Pod::Spec.new do |s|
  s.name           = 'SquirmyScrollEdges'
  s.version        = '1.0.0'
  s.summary        = 'Turns off the system scroll edge effects for Squirmy'
  s.description    = 'Hides the edge effects iOS 26 draws where scroll views meet the status bar and bars; the app draws its own.'
  s.license        = 'GPL-3.0-or-later'
  s.author         = 'Squirmy'
  s.homepage       = 'https://github.com/IsaacThoman/squirmy'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.swift'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
