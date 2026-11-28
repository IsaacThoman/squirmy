# At the module's root rather than in ios/, so the pod can take the snapshot model in shared/,
# which the app target and the widget extension compile too.
Pod::Spec.new do |s|
  s.name           = 'SquirmyAppIntents'
  s.version        = '1.0.0'
  s.summary        = 'Squirmy’s widgets, Siri and Shortcuts, and Live Activity'
  s.description    = 'Answers App Intents from JavaScript, writes the widgets’ snapshot into the App Group, and keeps the downloads Live Activity.'
  s.license        = 'GPL-3.0-or-later'
  s.author         = 'Squirmy'
  s.homepage       = 'https://github.com/IsaacThoman/squirmy'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = ['ios/**/*.swift', 'shared/**/*.swift']
  s.frameworks = 'ActivityKit', 'ImageIO', 'UniformTypeIdentifiers', 'WidgetKit'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
