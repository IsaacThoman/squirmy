import { createContext, useCallback, useContext, useMemo, useRef, useState, type PropsWithChildren, type RefObject } from 'react';
import {
  cancelAnimation, Easing, interpolate, ReduceMotion, useAnimatedReaction, useSharedValue, withSpring, withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { scheduleOnUI } from 'react-native-worklets';

export type PlayerPage = 'player' | 'lyrics' | 'queue';

/** The mini-player's frame in the window, and where its cover sits inside it. */
export type Bubble = {
  x: number;
  y: number;
  width: number;
  height: number;
  coverSize: number;
  coverInset: number;
  compact: boolean;
};

export type BubbleVariant = { compact: boolean; native: boolean; width: number; height: number };

/**
 * Now Playing grows out of the mini-player on two springs. `lead` carries the top edge and
 * `follow` carries everything that trails it: the bottom edge, the side insets, the artwork,
 * and the glass turning solid. Both run from 0 (mini-player) to 1 (full screen). Without a
 * bubble to grow from, the player cross-fades instead.
 */
export type Motion = {
  lead: SharedValue<number>;
  follow: SharedValue<number>;
  bubble: SharedValue<Bubble | null>;
  /** The overlay is on screen and has taken over from the mini-player. */
  active: SharedValue<boolean>;
  expanding: SharedValue<boolean>;
  dragging: SharedValue<boolean>;
};

// A spring never quite arrives. The player counts as collapsed below these values, and
// `progress` maps them to exactly zero so nothing jumps when the mini-player takes over.
const leadRest = 0.008;
const followRest = 0.025;

const critical = (stiffness: number) => ({ mass: 1, stiffness, damping: 2 * Math.sqrt(stiffness), overshootClamping: true });
const expandLead = critical(330);
const expandFollow = critical(290);
const collapseLead = critical(340);
const collapseFollow = critical(240);
const crossFade = { duration: 220, easing: Easing.out(Easing.quad), reduceMotion: ReduceMotion.Never };

export function miniCoverSize(compact: boolean, native: boolean) {
  return compact ? 28 : native ? 36 : 42;
}

export function progress(motion: Motion) {
  'worklet';
  return {
    lead: Math.min(1, Math.max(0, (motion.lead.value - leadRest) / (1 - leadRest))),
    follow: Math.min(1, Math.max(0, (motion.follow.value - followRest) / (1 - followRest))),
  };
}

/** How far a finger travels to carry the player between the bubble and the top of the screen. */
export function travel(bubble: Bubble) {
  'worklet';
  return Math.max(240, bubble.y);
}

/** How far the panel stands in from the window's sides. It keeps the bubble's margins for most of the way. */
export function sideInsets(bubble: Bubble, follow: number, width: number) {
  'worklet';
  const inset = interpolate(follow, [0, 0.6, 1], [1, 0.72, 0]);
  return { left: bubble.x * inset, right: Math.max(0, width - bubble.x - bubble.width) * inset };
}

/** Take the player off its animations so a finger can carry it. */
export function grab(motion: Motion) {
  'worklet';
  cancelAnimation(motion.lead);
  cancelAnimation(motion.follow);
  motion.dragging.value = true;
}

/** Send the player to full screen or back into the bubble, keeping the finger's velocity. */
export function settle(motion: Motion, open: boolean, velocity = 0) {
  'worklet';
  motion.dragging.value = false;
  motion.expanding.value = open;
  const to = open ? 1 : 0;
  if (!motion.bubble.value) {
    motion.lead.value = withTiming(to, crossFade);
    motion.follow.value = withTiming(to, crossFade);
    return;
  }
  motion.lead.value = withSpring(to, { ...(open ? expandLead : collapseLead), velocity });
  motion.follow.value = withSpring(to, { ...(open ? expandFollow : collapseFollow), velocity });
}

/** Put the overlay on screen, collapsed onto `bubble` or transparent when there is none. */
export function present(motion: Motion, bubble: Bubble | null) {
  'worklet';
  motion.bubble.value = bubble;
  motion.lead.value = 0;
  motion.follow.value = 0;
  motion.active.value = true;
}

const TransitionContext = createContext<{
  motion: Motion;
  variants: BubbleVariant[];
  registerBubble: (variant: BubbleVariant) => void;
  /** A mini-player offers itself as the place the player grows from when it is opened from elsewhere. */
  registerOrigin: (compact: boolean, expand: () => void) => () => void;
  showPage: RefObject<((page: PlayerPage) => void) | null>;
  open: (page?: PlayerPage) => void;
  close: () => void;
} | null>(null);

export function PlayerTransitionProvider({ children }: PropsWithChildren) {
  const lead = useSharedValue(0);
  const follow = useSharedValue(0);
  const bubble = useSharedValue<Bubble | null>(null);
  const active = useSharedValue(false);
  const expanding = useSharedValue(false);
  const dragging = useSharedValue(false);
  const motion = useMemo(
    () => ({ lead, follow, bubble, active, expanding, dragging }),
    [lead, follow, bubble, active, expanding, dragging],
  );
  const [variants, setVariants] = useState<BubbleVariant[]>([]);
  const showPage = useRef<((page: PlayerPage) => void) | null>(null);
  const origins = useRef(new Map<boolean, () => void>());

  useAnimatedReaction(
    () => active.value && !expanding.value && !dragging.value && lead.value <= leadRest && follow.value <= followRest,
    (collapsed) => {
      if (!collapsed) return;
      cancelAnimation(lead);
      cancelAnimation(follow);
      lead.value = 0;
      follow.value = 0;
      active.value = false;
    },
  );

  const registerBubble = useCallback((variant: BubbleVariant) => setVariants((known) => {
    const index = known.findIndex(item => item.compact === variant.compact && item.native === variant.native);
    if (index < 0) return [...known, variant];
    if (known[index].width === variant.width && known[index].height === variant.height) return known;
    return known.map((item, position) => position === index ? variant : item);
  }), []);

  const registerOrigin = useCallback((compact: boolean, expand: () => void) => {
    origins.current.set(compact, expand);
    return () => {
      if (origins.current.get(compact) === expand) origins.current.delete(compact);
    };
  }, []);

  const open = useCallback((page: PlayerPage = 'player') => {
    showPage.current?.(page);
    const expand = origins.current.get(false) ?? origins.current.get(true);
    if (expand) {
      expand();
      return;
    }
    scheduleOnUI(() => {
      'worklet';
      if (!motion.active.value) present(motion, null);
      settle(motion, true);
    });
  }, [motion]);

  const close = useCallback(() => scheduleOnUI(() => {
    'worklet';
    if (motion.active.value) settle(motion, false);
  }), [motion]);

  const value = useMemo(
    () => ({ motion, variants, registerBubble, registerOrigin, showPage, open, close }),
    [motion, variants, registerBubble, registerOrigin, open, close],
  );
  return <TransitionContext.Provider value={value}>{children}</TransitionContext.Provider>;
}

export function usePlayerTransition() {
  const value = useContext(TransitionContext);
  if (!value) throw new Error('PlayerTransitionProvider is missing');
  return value;
}
