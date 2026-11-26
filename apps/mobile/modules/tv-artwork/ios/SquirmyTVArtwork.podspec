Pod::Spec.new do |s|
  s.name           = 'SquirmyTVArtwork'
  s.version        = '1.0.0'
  s.summary        = 'Artwork that takes the system focus effect on Apple TV'
  s.description    = 'An image view that lifts, tilts and catches the light with the tvOS focus engine when its focusable parent is focused.'
  s.license        = 'GPL-3.0-or-later'
  s.author         = 'Squirmy'
  s.homepage       = 'https://github.com/IsaacThoman/squirmy'
  s.platforms      = { :ios => '16.4', :tvos => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.dependency 'SDWebImage'

  s.source_files = '**/*.swift'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
