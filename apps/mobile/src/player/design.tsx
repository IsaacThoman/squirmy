import * as Haptics from 'expo-haptics';

export function selectionFeedback() {
  void Haptics.selectionAsync().catch(() => {});
}

/** Something asked for was done, though it shows elsewhere than where it was asked (a song queued from a menu). */
export function successFeedback() {
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
}
