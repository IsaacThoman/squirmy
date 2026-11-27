Pod::Spec.new do |s|
  s.name           = 'SquirmyTVSearch'
  s.version        = '1.0.0'
  s.summary        = 'The system search field and keyboard for Apple TV'
  s.description    = 'Hosts a UISearchController with the one-row tvOS keyboard and reports what is typed.'
  s.license        = 'GPL-3.0-or-later'
  s.author         = 'Squirmy'
  s.homepage       = 'https://github.com/IsaacThoman/squirmy'
  s.platforms      = { :ios => '16.4', :tvos => '16.4' }
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
