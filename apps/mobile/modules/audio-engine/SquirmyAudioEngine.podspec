# At the module's root rather than in ios/, so the pod can take the core package's sources
# (core/, which `swift test` runs on macOS) along with the Expo module's.
Pod::Spec.new do |s|
  s.name           = 'SquirmyAudioEngine'
  s.version        = '1.0.0'
  s.summary        = 'Squirmy’s native audio engine'
  s.description    = 'Gapless playback through AVSampleBufferAudioRenderer, with Apple’s decoders and a sparse byte cache.'
  s.license        = 'GPL-3.0-or-later'
  s.author         = 'Squirmy'
  s.homepage       = 'https://github.com/IsaacThoman/squirmy'
  s.platforms      = { :ios => '16.4', :tvos => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = ['ios/**/*.swift', 'core/Sources/**/*.swift']
  s.frameworks = 'AVFoundation', 'AudioToolbox', 'CoreMedia', 'Accelerate'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
