import { Button, Image, Menu, ProgressView, RNHostView } from '@expo/ui/swift-ui';
import {
  accessibilityAddTraits, accessibilityHidden, accessibilityLabel, background, buttonStyle, contentShape, controlSize, frame, menuIndicator, progressViewStyle, shapes, tint,
} from '@expo/ui/swift-ui/modifiers';
import { View } from 'react-native';
import type { ComponentProps } from 'react';
import type { Artwork, TrackSummary } from '@squirmy/contracts';
import { trackActionKey, useRunTrackAction, useTrackActions, type TrackAction, type TrackActionOptions } from '../library/trackActions';
import { Cover } from '../ui';
import { useColors } from '../theme';

type SymbolName = ComponentProps<typeof Image>['systemName'];
export const plainButton = buttonStyle('plain');
export const hitShape = contentShape(shapes.rectangle());
const iconFrame = frame({ width: 44, height: 44 });

/**
 * A symbol beside a label or inside a labelled button. Hidden from VoiceOver, which would
 * otherwise read its system name ("Personal Hotspot With A Slash", "Server Rack").
 */
export function Symbol({ name, size = 20, color }: { name: string; size?: number; color?: string }) {
  return <Image systemName={name as SymbolName} size={size} color={color} modifiers={[accessibilityHidden(true)]} />;
}

export function IconButton({ symbol, label, size = 20, color, width = 44, height = 44, selected, busy, filled, onPress }: {
  symbol: string;
  label: string;
  size?: number;
  color?: string;
  width?: number;
  height?: number;
  selected?: boolean;
  /** Shows the system's activity spinner in place of the symbol; the button still works. */
  busy?: boolean;
  /** The symbol knocked out of a circle filled with `color`, for a toggle that is on. */
  filled?: boolean;
  onPress?: () => void;
}) {
  const colors = useColors();
  const fill = filled ? [frame({ width: 36, height: 36 }), background(color ?? colors.text, shapes.circle())] : [];
  return (
    <Button onPress={onPress} modifiers={[
      plainButton, accessibilityLabel(label),
      ...(selected ? [accessibilityAddTraits(['isSelected'])] : []),
    ]}>
      {busy
        ? <ProgressView modifiers={[progressViewStyle('circular'), controlSize(size >= 32 ? 'large' : 'regular'), tint(color ?? colors.text),
          frame({ width, height }), hitShape]} />
        : <Image systemName={symbol as SymbolName} size={filled ? size * 0.82 : size} color={filled ? colors.background : color ?? colors.text}
          modifiers={[...fill, frame({ width, height }), hitShape]} />}
    </Button>
  );
}

export function NativeCover({ artwork, size, radius }: { artwork: Artwork | null | undefined; size: number; radius?: number }) {
  return <RNHostView matchContents>
    <View style={{ width: size, height: size }}><Cover artwork={artwork} size={size} radius={radius} /></View>
  </RNHostView>;
}

export function TrackCover({ track, size = 42, radius = 8 }: { track: TrackSummary | undefined; size?: number; radius?: number }) {
  return <NativeCover artwork={track?.album?.artwork} size={size} radius={radius} />;
}

/** Actions as menu buttons. Plain elements: nothing is computed until one is chosen. */
export function TrackActionButtons({ actions, onRun }: { actions: readonly TrackAction[]; onRun: (action: TrackAction) => void }) {
  return <>
    {actions.map(action => action.children
      // A submenu, such as Rating's stars.
      ? <Menu key={trackActionKey(action)} label={action.title} systemImage={action.icon as SymbolName}>
        <TrackActionButtons actions={action.children} onRun={onRun} />
      </Menu>
      : <Button key={trackActionKey(action)} label={action.title} systemImage={action.icon as SymbolName}
        role={action.destructive ? 'destructive' : undefined} onPress={() => onRun(action)} />)}
  </>;
}

/** The ellipsis menu for actions a row has already described. */
export function TrackActionsMenu({ actions, onRun, label, color, children }: {
  actions: readonly TrackAction[]; onRun: (action: TrackAction) => void; label: string; color?: string; children?: React.ReactNode;
}) {
  const colors = useColors();
  return <Menu label={<Image systemName="ellipsis" size={19} color={color ?? colors.muted} modifiers={[iconFrame, hitShape]} />}
    modifiers={[plainButton, menuIndicator('hidden'), accessibilityLabel(label)]}>
    <TrackActionButtons actions={actions} onRun={onRun} />
    {children}
  </Menu>;
}

/** One track's ellipsis menu, reading what it needs itself. For a single menu, such as Now Playing's. */
export function TrackMenu({ track, options, label, color, children }: {
  track: TrackSummary | undefined; options?: TrackActionOptions; label?: string; color?: string; children?: React.ReactNode;
}) {
  const actions = useTrackActions(track, options);
  const run = useRunTrackAction(false);
  return <TrackActionsMenu actions={actions} onRun={run} label={label ?? `More options for ${track?.title ?? 'this song'}`} color={color}>
    {children}
  </TrackActionsMenu>;
}
