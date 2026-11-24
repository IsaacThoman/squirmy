/**
 * iOS 26's edge effects, off on every side. `modules/scroll-edges` hides them on every scroll view;
 * a stack left at `automatic` would turn them on again for its screens' scroll views.
 */
export const noScrollEdgeEffects = { top: 'hidden', bottom: 'hidden', left: 'hidden', right: 'hidden' } as const;
