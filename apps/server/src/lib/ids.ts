import { v4, v7 } from 'uuid'

/** Time-ordered id for every row except assets. */
export function newId(): string {
  return v7()
}

/** Unguessable id for things addressed by unauthenticated URLs (artwork). */
export function newPublicId(): string {
  return v4()
}
