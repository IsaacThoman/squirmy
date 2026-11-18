import * as Haptics from 'expo-haptics';

export const playerColors = {
  text: '#F6F3FC',
  muted: '#B8B1C7',
  quiet: '#ADA5BC',
  lilac: '#CBC1FF',
  ink: '#19142B',
  stroke: '#FFFFFF1A',
  surface: '#FFFFFF0D',
};

export function selectionFeedback() {
  void Haptics.selectionAsync().catch(() => {});
}
