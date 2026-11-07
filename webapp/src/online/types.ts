/** What the server sends: shared by the Worker and the browser. */
import type { Pace, Pack, Phase } from '../engine/game';

export interface MemberView {
  id: string;
  nickname: string;
  /** Join order in the lobby, frozen when a game starts. Also the player's colour. */
  seat: number;
  host: boolean;
  /** Checked in within the last few seconds. */
  online: boolean;
  /** Left the room after this game started. */
  left: boolean;
  /** Has done what the current phase asks: drawn, written a fib, voted. */
  done: boolean;
  /** The artist of the drawing being shown. */
  artist: boolean;
  /** Points from the drawings revealed so far. */
  score: number;
}

/** A title to vote for. `mine`: you wrote it (or it's your drawing's real title), so you can't vote for it. */
export interface OptionView {
  text: string;
  mine: boolean;
}

/** One title in the reveal, in the order it is revealed (the real one last). */
export interface RevealItem {
  text: string;
  truth: boolean;
  /** Seats of the players who wrote this fib (none for the real title). */
  authors: number[];
  /** Seats of the players who voted for it. */
  voters: number[];
  /** Points this title gave each author (or the artist, for the real title). */
  points: number;
}

export interface GameView {
  id: string;
  /** 'over' when every drawing was played, 'ended' when the host stopped it. */
  status: 'playing' | 'over' | 'ended';
  pack: Pack;
  rounds: number;
  round: number;
  phase: Phase;
  /** Which drawing of the round is being shown, and how many the round has. */
  step: number;
  steps: number;
  phaseAt: number;
  endsAt: number;
  startedAt: number;
  finishedAt: number | null;
  /** The drawing being shown (fib, vote, reveal). */
  drawing: { id: string; artist: number } | null;
  /** Your prompt while drawing; your drawing's real title while others guess it; the real title in the reveal. */
  prompt: string | null;
  /** Your part in this phase (null for a TV or someone who isn't playing). */
  you: {
    seat: number;
    drew: boolean;
    fib: string | null;
    /** Index in `options` of your vote. */
    vote: number | null;
    artist: boolean;
  } | null;
  /** The titles to vote on, in the order shown to everyone. */
  options: OptionView[] | null;
  reveal: RevealItem[] | null;
  /** Points each seat earned from this drawing (reveal only). */
  gains: number[] | null;
  /** Every drawing of the game with its title, once it's over. */
  gallery: { id: string; prompt: string; artist: number; round: number }[] | null;
}

export interface RoomSettings {
  rounds: number;
  pack: Pack;
  pace: Pace;
}

export interface RoomView {
  id: string;
  code: string;
  status: 'lobby' | 'playing' | 'finished' | 'closed';
  hostId: string;
  /** The viewer's player id; null for a TV. */
  you: string | null;
  /** In the lobby: who is in the room. During and after a game: its players, in seat order. */
  members: MemberView[];
  /** Players waiting in the room for the next game (joined after the last one started). */
  waiting: MemberView[];
  /** A TV screen is showing this room. */
  tv: boolean;
  settings: RoomSettings;
  game: GameView | null;
  /** The server's clock, to compare with the times above. */
  now: number;
}

export interface Player {
  id: string;
  nickname: string;
}
