Pod::Spec.new do |s|
  s.name           = 'SquirmyTVMenu'
  s.version        = '1.0.0'
  s.summary        = 'The system context menu for focusable views'
  s.description    = 'Attaches the system long-press context menu to the focusable React Native view inside it.'
  s.license        = 'GPL-3.0-or-later'
  s.author         = 'Squirmy'
  s.homepage       = 'https://github.com/IsaacThoman/squirmy'
  s.platforms      = { :ios => '16.4', :tvos => '17.0' }
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
