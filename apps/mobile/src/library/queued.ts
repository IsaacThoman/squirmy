import * as Haptics from 'expo-haptics';
import { announce } from '../inlineFeedback';
import { queuedMessage } from './albumActions';

/**
 * Says that songs went into the queue: a menu closes on them and the queue is out of sight, so
 * the phone taps once and VoiceOver hears it. The app has no toasts.
 */
export function confirmQueued(placement: 'next' | 'last') {
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  announce(queuedMessage(placement));
}
