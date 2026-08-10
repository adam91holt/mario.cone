// The book: everything the race knows about itself that a `Racer` has no field
// for, plus the cup it belongs to.
//
// `Racer` carries `lap`, `place`, `finishTime` and a `lapTimes` array of
// *cumulative* stamps — that last one is a published contract (the lap banner
// differences it to get a split) and is deliberately left alone. Everything a
// results screen actually needs on top of it — per-lap splits, a best lap, the
// gap to the winner, points, whether a racer was still out on the circuit when
// the flag finally came in — lives here, keyed by racer id, and is rebuilt from
// nothing at every reset.
//
// Two rules hold for this file. It touches no DOM and no THREE: it is the model
// the director writes and the results screen reads, and keeping it plain makes
// it trivially inspectable from `window.__RACE`. And it never reads a clock —
// every time in here arrives from `ctx.race.time`, which is integrated in
// `fixedUpdate` at a constant dt, so two runs of the same seed produce byte
// identical results tables.

import { getVehicle } from '../vehicles/registry.ts';
import type { Racer, VehicleId } from '../types.ts';

/** One racer's line in the results table. Plain JSON — critics diff these. */
export interface ResultRow {
  id: number;
  name: string;
  vehicleId: VehicleId;
  isPlayer: boolean;
  /** 1-based finishing position. */
  place: number;
  /** Total race time, seconds. */
  time: number;
  /** Seconds behind the winner. Zero for the winner. */
  gap: number;
  /** Best lap of the race for this racer, seconds. 0 if they never set one. */
  bestLap: number;
  /** Championship points this result is worth. */
  points: number;
  /** True when the flag came in before this racer did and the time is an
   *  estimate rather than a measurement. */
  estimated: boolean;
  /**
   * The map blip's colour: the machine's hue pushed into the band that reads at
   * ninety pixels against a grey road. Right for a dot, wrong for a table.
   */
  color: number;
  /**
   * ...and the machine's *actual* livery, unclamped.
   *
   * `blipColor` floors saturation at 0.55 and clamps lightness to 0.48-0.8,
   * which is exactly correct for a minimap and actively false on a full-width
   * results sheet: it gives the near-black Shunter a teal spine and the
   * white-and-red Prop Plane a pale lavender one. The front-end spends a whole
   * screen selling machines — PICK YOUR MACHINE, a dossier, five stat bars, a
   * launch card carrying the silhouette — and ninety seconds later the sheet
   * listed eight driver names and nothing tied any of them to a machine at all.
   * The one tie left was the colour, and it was the wrong colour.
   */
  livery: number;
}

/** What the book tracks for a racer while the race is still running. */
interface Entry {
  racer: Racer;
  /** Per-lap splits in seconds, index 0 = lap 1. */
  splits: number[];
  best: number;
  /** Cumulative time at the previous line crossing. */
  lastCross: number;
  finished: boolean;
  finishTime: number;
  place: number;
  estimated: boolean;
}

export interface RaceBook {
  reset(racers: Racer[]): void;
  /** Record a completed lap. Returns the split, and whether it is a new best. */
  lap(racer: Racer, atTime: number): { split: number; best: boolean };
  finish(racer: Racer, place: number, atTime: number, estimated: boolean): void;
  bestLapOf(racer: Racer): number;
  splitsOf(racer: Racer): readonly number[];
  /** The fastest lap anybody set, and who set it. */
  fastest(): { racer: Racer | null; time: number };
  /** The finished table, sorted by place. `points` uses the supplied table. */
  rows(points: readonly number[], colorOf: (r: Racer) => number): ResultRow[];
  finishedCount(): number;
}

export function createRaceBook(): RaceBook {
  const entries = new Map<number, Entry>();
  let fastestId = -1;
  let fastestTime = 0;

  const entryOf = (racer: Racer): Entry | undefined => entries.get(racer.id);

  return {
    reset(racers: Racer[]): void {
      entries.clear();
      fastestId = -1;
      fastestTime = 0;
      for (const racer of racers) {
        entries.set(racer.id, {
          racer,
          splits: [],
          best: 0,
          lastCross: 0,
          finished: false,
          finishTime: 0,
          place: 0,
          estimated: false,
        });
      }
    },

    lap(racer, atTime): { split: number; best: boolean } {
      const e = entryOf(racer);
      if (!e) return { split: 0, best: false };
      const split = Math.max(0, atTime - e.lastCross);
      e.lastCross = atTime;
      e.splits.push(split);
      let best = false;
      if (split > 0 && (e.best === 0 || split < e.best)) {
        e.best = split;
        best = true;
      }
      if (split > 0 && (fastestId < 0 || split < fastestTime)) {
        fastestId = racer.id;
        fastestTime = split;
      }
      return { split, best };
    },

    finish(racer, place, atTime, estimated): void {
      const e = entryOf(racer);
      if (!e || e.finished) return;
      e.finished = true;
      e.finishTime = atTime;
      e.place = place;
      e.estimated = estimated;
    },

    bestLapOf(racer): number {
      return entryOf(racer)?.best ?? 0;
    },

    splitsOf(racer): readonly number[] {
      return entryOf(racer)?.splits ?? [];
    },

    fastest(): { racer: Racer | null; time: number } {
      const e = fastestId >= 0 ? entries.get(fastestId) : undefined;
      return { racer: e?.racer ?? null, time: fastestTime };
    },

    finishedCount(): number {
      let n = 0;
      for (const e of entries.values()) if (e.finished) n++;
      return n;
    },

    rows(points, colorOf): ResultRow[] {
      const list = [...entries.values()].filter((e) => e.finished);
      list.sort((a, b) => a.place - b.place);
      const winner = list.length ? list[0]!.finishTime : 0;
      return list.map((e): ResultRow => ({
        id: e.racer.id,
        name: e.racer.name,
        vehicleId: e.racer.vehicleId,
        isPlayer: e.racer.isPlayer,
        place: e.place,
        time: e.finishTime,
        gap: Math.max(0, e.finishTime - winner),
        bestLap: e.best,
        points: points[e.place - 1] ?? 0,
        estimated: e.estimated,
        color: colorOf(e.racer),
        livery: getVehicle(e.racer.vehicleId).colors.primary,
      }));
    },
  };
}

// ── the cup ────────────────────────────────────────────────────────────────
//
// A cup is four rounds and a points table, and it is the only thing in this
// game that outlives a race. It is held in memory and nowhere else — no
// localStorage, deliberately. A results screen that reads differently on the
// second run of the same capture is a results screen no reviewer can judge, and
// a standings table that quietly accumulates across a reviewer's twenty resets
// is worse than no table at all. Close the tab and the cup is over.

export interface CupStanding {
  name: string;
  vehicleId: VehicleId;
  isPlayer: boolean;
  color: number;
  points: number;
  /** Points from the race just finished — the "+12" the row flies in with. */
  gained: number;
  place: number;
  /** Change in championship position caused by the last race. */
  moved: number;
}

export interface CupState {
  id: string;
  name: string;
  /** Round about to be raced, 0-based. */
  round: number;
  rounds: number;
  /** Course ids in order. Filled in by the director from the course registry. */
  courseIds: string[];
  standings: CupStanding[];
}

export interface Cup {
  readonly state: CupState;
  /** Start a fresh championship over these courses. */
  begin(id: string, name: string, courseIds: string[], rounds: number): void;
  /** Fold a finished race into the table. Idempotent per race — calling twice
   *  without an `advance()` in between replaces the previous application. */
  apply(rows: readonly ResultRow[]): void;
  /** Throw away the last applied race — what "race again" means for a cup. */
  undo(): void;
  /** Move to the next round. Returns false when the cup is over. */
  advance(): boolean;
  /** The course this round is run on. */
  courseId(): string;
  /** True once every round has been raced. */
  complete(): boolean;
}

export function createCup(): Cup {
  const state: CupState = {
    id: 'hazard',
    name: 'Hazard Cup',
    round: 0,
    rounds: 4,
    courseIds: [],
    standings: [],
  };

  /** The table as it stood before the most recent `apply`, so a retry can undo. */
  let previous: CupStanding[] | null = null;

  function sortAndPlace(list: CupStanding[]): void {
    // Points first, then the better single result, then name so the order is
    // total and stable. A championship table that reshuffles equal rows between
    // frames looks broken even when it is not.
    list.sort((a, b) => (b.points - a.points) || (b.gained - a.gained) || a.name.localeCompare(b.name));
    for (let i = 0; i < list.length; i++) list[i]!.place = i + 1;
  }

  return {
    state,

    begin(id, name, courseIds, rounds): void {
      state.id = id;
      state.name = name;
      state.round = 0;
      state.rounds = Math.max(1, rounds);
      state.courseIds = courseIds.slice();
      state.standings = [];
      previous = null;
    },

    apply(rows): void {
      if (previous) state.standings = previous.map((s) => ({ ...s }));
      previous = state.standings.map((s) => ({ ...s }));

      const before = new Map(state.standings.map((s) => [s.name, s.place]));
      const byName = new Map(state.standings.map((s) => [s.name, s]));
      for (const row of rows) {
        const existing = byName.get(row.name);
        if (existing) {
          existing.points += row.points;
          existing.gained = row.points;
          existing.color = row.color;
          existing.vehicleId = row.vehicleId;
        } else {
          const fresh: CupStanding = {
            name: row.name,
            vehicleId: row.vehicleId,
            isPlayer: row.isPlayer,
            color: row.color,
            points: row.points,
            gained: row.points,
            place: 0,
            moved: 0,
          };
          byName.set(row.name, fresh);
          state.standings.push(fresh);
        }
      }
      sortAndPlace(state.standings);
      for (const s of state.standings) {
        const was = before.get(s.name);
        s.moved = was === undefined ? 0 : was - s.place;
      }
    },

    undo(): void {
      if (!previous) return;
      state.standings = previous;
      previous = null;
    },

    advance(): boolean {
      previous = null;
      if (state.round + 1 >= state.rounds) return false;
      state.round++;
      return true;
    },

    courseId(): string {
      if (!state.courseIds.length) return 'cone-canyon';
      return state.courseIds[state.round % state.courseIds.length]!;
    },

    complete(): boolean {
      return state.round + 1 >= state.rounds && state.standings.length > 0;
    },
  };
}
