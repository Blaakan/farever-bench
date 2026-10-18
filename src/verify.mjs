// ---------------------------------------------------------------------------
// verify.mjs - hold the model against the record and print the difference.
//
// Everything else in src/ computes what Farever OUGHT to do. capture.mjs reads
// what it DID. This file is the join, and it is the only place in the bench
// where the model can be told it is wrong by something other than a person.
//
// Four comparisons, ordered by how much they can be trusted:
//
//   1. PER-HIT. The model's damage-per-event against the capture's mean. What
//      one hit deals does not depend on how often it lands - it is the same
//      skill landing on the same target - so a disagreement here is a formula
//      error, or a STATE: something the hit found standing (a charge level, a
//      buff's stack count, a register another press had spent) that the
//      window holds in one mix and the model's fight in another. The split
//      below and one block replayed tell the two apart; the ledger names the
//      states it knows the build holds. This is the comparison to fix first.
//
//   2. SHARE. Each skill's fraction of total damage. Immune to fight length and
//      to any uniform scaling error, so it isolates rotation and cadence
//      mistakes from magnitude ones: a model can have every per-hit right and
//      still get share wrong by pressing the wrong things.
//
//   3. CRIT. Observed crit rate per skill. The capture shows DoT streams at 0%
//      and direct casts near the sheet value, so a skill on the wrong side of
//      that line is a mechanism error rather than a tuning one.
//
//      PER-HIT has one weakness, and a short window finds it: the capture's
//      mean is over the hits that happened, and whether a hit crit is a die.
//      Three presses with two crits read +30% against a model that is exact.
//      So the same comparison is also made on each half of the die - ordinary
//      hits against the model's ordinary hit, critical ones against its
//      critical one (`--split`) - and where a window is short, those two are
//      the per-hit verdict and the blended one is the luck.
//
//   4. RATE. How often each line lands: the model's rows over its fight
//      against the capture's rows over the time it was in play (capture.mjs
//      aggregate, `activeMs`) - and the two totals the same way, damage per
//      second against damage per second. It is the one comparison that needs
//      the clock, and the one PER-HIT cannot stand in for: the 2026-10-13
//      Rogue's sixteen rotations agree per hit to +0.6% and the model lands
//      7.6% more of them. It is like for like only on a window that is one
//      fight on one target (the rows held to the instance being fought), and
//      open-world play is neither: the player stops, walks, and fights things
//      the sim was never asked about. There, read it as a smell.
//
//      (This used to be CADENCE - the model line's `interval` against the
//      mean gap between capture rows - and it could not be read: a status
//      line's interval was the fight's own length, and a cast's was per CAST
//      beside a gap per ROW.)
//
// And two coverage buckets, which matter more than any delta:
//
//   MISSING - the game did it and the model has no line for it. Damage the
//             bench cannot see at all. Every one of these is a coverage hole.
//   PHANTOM - the model claims it and the capture never recorded it. Either the
//             build is wrong or the model invented a source.
//
// And one that is neither, for a window cut out of a longer sitting:
//
//   CARRIED-IN - the game did it INSIDE the window with something pressed or
//             applied BEFORE it: a tick of a status still up, the hit of a
//             cast already under way, a rider gated on such a status. The
//             model has a line for the skill in a fight that presses it and
//             none in this window's fight, which pressed nothing. That is the
//             window's edge, not a hole in the model, so the row is kept out
//             of MISSING and out of what coverage is measured against.
//
// A signed delta is always model MINUS capture, so a positive number means the
// model is claiming too much. The signs are what make the rows add up into a
// ledger instead of a list of complaints.
// ---------------------------------------------------------------------------

// --- what a capture is evidence OF -------------------------------------------
// A capture is a record of what ONE BUILD of the game did. Held against the
// data of another build it still produces a ledger, and every row the patch
// changed then reads as a model error: the 2026-10 build moved the Epic and
// Legendary item-level bonus (rarity.props.iLevelBonus), and a pre-patch
// snapshot's own affix values - baked by the old build - came back as SHEET
// rows several percent "wrong" against a model that was right about the new
// one, with two reworked Rogue rows as MISSING. So a ledger says which build its
// window was recorded on (capture.mjs captureEra) before it says anything
// else, and these two helpers turn that into the sentences and the target.

// The warning for a window that is not, or may not be, the installed build's.
// Null when it is.
export function eraWarning(era) {
  if (!era || era.onThisBuild === true) return null;
  const tail = 'MISSING, PHANTOM, PER-HIT and SHEET rows below include whatever the patch\n'
    + 'changed: they are evidence about that build, and only some of it is about the model.';
  return era.onThisBuild === false
    ? `this capture window is not this build's - ${era.reason}.\n${tail}`
    : `this capture window cannot be placed on a build - ${era.reason}.\n${tail}`;
}

// Unit rows that changed what a TARGET is, for captures recorded before the
// change. The install holds today's row only; what the row said on the build
// a capture was recorded on is history, and it is written down here with its
// evidence rather than guessed at.
//
//   Dummy   authored Armor / MagicArmor reduction 0 / 0 until the 2026-10
//           build (the 2026-07-27 data.cdb reads `armorReduction: 0`,
//           `magicReduction: 0`; every "0-armour dummy" calibration stands on
//           it) and 0.4 / 0.4 from it. A window with no session row that ended
//           before the installed boot was written is probe v9 or older on an
//           older build: its Dummy mitigated nothing.
export const TARGET_HISTORY = {
  Dummy: {
    priceAs: 'none',
    why: 'the Dummy row authored no armour (0 / 0) until the 2026-10 build',
  },
};

// `--target X` used to be two questions in one flag: WHICH ROWS of the capture
// to read (hits on archetype X) and WHAT the model is hit against. They are
// the same answer only while the unit row says today what it said when the
// capture was recorded. `--price-as` separates them; left unset, the model
// stands on the filter - except for a target with a recorded history, on a
// window from before it, where it stands on what the row said then.
//
//   filter      the --target archetype, or null
//   priceAs     the --price-as target, or null
//   unit        the unit id behind `filter` (combat.foe(filter).unit), or null
//   era         captureEra() of the window
//   logged      aggregate().targetLevels of the window: the levels the probe
//               logged its targets at (`tlvl`), or null
//   heroLevel   the character's level
//   difficulty  what the model knows about the filtered unit and the game's
//               difficulties, or null: { maxLevel, normalTop, heroicDiffers,
//               veteranLabel, heroicLabel, overread } - see below
//
// Returns the target NAME to hand combat.foe (null: the engine's default), the
// LEVEL to stand it at (null: wherever the name puts it), the notes to print
// when either is not simply what the filter says, and `difficulty` when the
// window's difficulty decides the target and the capture cannot say it.
//
// The level. A unit id is priced where its row puts it in Normal difficulty,
// and a capture is not always Normal: the Crab_Z1D row says lvl 4 and the
// pre-patch capture logged it at 25 on every one of its 1,746 hits (the level
// Veteran makes everything at). The probe logs where the target stood, so a
// window that is priced on its own filter stands the target there - the level
// most of its rows carry, with the count said.
// A mode the caller wrote on the name (`Ratsar@heroic`), a --price-as and a
// --target-level are each the caller's answer and are left alone. One thing
// the logged level cannot say: in an activity flagged DynamicScaling (a rift)
// the pool is rebuilt at the STRIKER's level whatever the target's own is
// (damage.mjs, the modes), and nothing in a capture row names the activity -
// so when the two levels differ the note says how to ask for that reading.
//
// The difficulty. A logged level is not a difficulty either. Veteran and
// Heroic both make every foe at MaxLevel (damage.mjs, the modes), so a unit
// logged there, above anything its row allows, stood in one of the two - and
// for most units that is one target, because only the heroic stat rows tell
// them apart. For the bosses that carry heroic ARMOUR rows it is two: on the
// 2026-10 build five of them resolve an inherited 0.30 in Veteran and their
// own 0.40 in Heroic, and a Heroic window priced on the Veteran rows reads
// every hit about 17% model-high (0.70 / 0.60 of what gets through) with
// nothing wrong in any formula. No capture row names the difficulty, so the
// model stays where the level alone puts it (the Normal rows at MaxLevel,
// which is Veteran exactly), the ledger opens by saying that this was a
// choice and what the other one costs, and `--price-as <unit>@heroic` or
// `@veteran` is how the reader makes it instead.
// `difficulty` carries what that takes: MaxLevel, the highest level Normal
// puts the unit at (null when that is the striker's own), whether its heroic
// armour differs, both labels, and the per-hit overread of pricing a Heroic
// window as Veteran. A unit whose own row already stands at MaxLevel is the
// same question with Normal in it too, and is asked the same way.
export function modelTarget({ filter = null, priceAs = null, unit = null, era = null, logged = null, heroLevel = null, difficulty = null } = {}) {
  if (priceAs) {
    return {
      name: priceAs, level: null, levelNote: null,
      note: filter && priceAs !== filter
        ? `the capture rows are hits on ${filter}; the model is priced against \`${priceAs}\` (--price-as)` : null,
    };
  }
  if (!filter) return { name: null, level: null, note: null, levelNote: null };
  const past = unit ? TARGET_HISTORY[unit] : null;
  if (past && era && era.onThisBuild === false && !(era.sessions ?? []).length) {
    return {
      name: past.priceAs, level: null, levelNote: null,
      note: `the model is priced against \`${past.priceAs}\`, not against today's ${unit} row: ${past.why}, and this window `
        + `predates it. --price-as ${filter} prices the row as it is now.`,
    };
  }
  const share = logged?.mode == null ? null : `${logged.modeRows} of the ${logged.logged} hits that logged a level`
    + (logged.logged < logged.matched ? ` (${logged.matched - logged.logged} logged none)` : '');
  const mode = /@([a-z]+)$/.exec(filter)?.[1] ?? null;
  if (mode) {
    // The caller's answer stands. The one thing worth saying is when the
    // capture contradicts it: Veteran and Heroic put the target at MaxLevel,
    // and a window logged anywhere else was neither.
    const contradicted = (mode === 'veteran' || mode === 'heroic') && difficulty?.maxLevel != null
      && logged?.mode != null && logged.mode !== difficulty.maxLevel;
    return {
      name: filter, level: null, note: null,
      levelNote: contradicted
        ? `the capture logged it at level ${logged.mode} on ${share}, not at ${difficulty.maxLevel}: this window was not @${mode}`
        : null,
    };
  }
  if (logged?.mode == null) return { name: filter, level: null, note: null, levelNote: null };
  const who = unit ?? filter;
  // At MaxLevel the window may be Heroic. `aboveRow` says the level alone
  // already rules Normal out; the heroic armour rows say whether it matters.
  const atMax = difficulty != null && logged.mode === difficulty.maxLevel;
  const aboveRow = atMax && difficulty.normalTop != null && difficulty.normalTop < difficulty.maxLevel;
  const undecided = atMax && difficulty.heroicDiffers === true;
  const pct = (x) => `${x >= 0 ? '+' : ''}${(100 * x).toFixed(1)}%`;
  return {
    name: filter, level: logged.mode,
    difficulty: !undecided ? null : aboveRow ? 'veteran-or-heroic' : 'heroic-or-not',
    note: undecided
      ? [
        `the capture logged ${who} at level ${logged.mode}, `
          + (aboveRow
            ? `above where its row puts it in Normal (level ${difficulty.normalTop}): this window is Veteran or Heroic - both make `
              + `every foe at level ${difficulty.maxLevel} - and no capture row says which.`
            : 'which is where Heroic makes every foe and where this one can stand outside it too: no capture row says whether '
              + 'this window was Heroic.'),
        `They are two targets here: Heroic reads ${who}'s heroic armour rows (${difficulty.heroicLabel}), `
          + `${aboveRow ? 'Veteran' : 'every other difficulty'} the rows Normal reads (${difficulty.veteranLabel}).`,
        `The model is priced ${aboveRow ? 'as Veteran' : 'on the Normal rows'}. If the window was Heroic, every hit reads about `
          + `${pct(difficulty.overread)} model-high for that reason alone: --price-as ${who}@heroic prices the Heroic rows, `
          + (aboveRow ? `--price-as ${who}@veteran says Veteran outright.` : `--price-as ${who} says it was not.`),
      ].join('\n')
      : null,
    levelNote: `the target stands at level ${logged.mode}, where the capture logged it on ${share}`
      + (aboveRow && !undecided
        ? ` - above its row's level (${difficulty.normalTop}), so Veteran or Heroic, which read the same armour rows for this unit`
        : '')
      + (heroLevel != null && logged.mode !== heroLevel
        ? `. If that was a rift, the pool is built at YOUR level (${heroLevel}) instead: --price-as ${who}@scaled`
        : ''),
  };
}

// --- a mechanic's slots, when the snapshot does not carry them -----------------
// The Mage's conduit slots may hold one conduit several times, and what they
// hold is a build fact like a talent: probe v7 wrote it (`snap_conduit`), and
// on build 25782799 probe v10 could not (`snap_err conduit mage=n`). Left to
// the model's default fill - the pool's options in turn - the 2026-10-13 Mage
// was priced with two Shard conduits she did not slot: 160 hits and a fifth
// of her damage that the capture holds no row of, beside a Power conduit at
// a third of its real stack income.
//
// What the slots hold shows in the rows. A conduit that hits writes `inflict`
// rows under its own id; one that buffs applies its status to the caster, one
// stack per slotted instance, all in the same millisecond. So:
//
//   slots      how many the pool has at this level
//   options    [{ id, statuses }] - the pool's options in order, each with the
//              statuses its own script applies to its owner
//   evidence   capture.mjs mechanicEvidence over the snapshot's span
//
// An option is SEEN when it left hits or status applications. A seen option
// whose status rose n at a time holds n slots; the slots left over go to the
// seen options that say no count, in turn, and to all the seen ones when none
// is left. Nothing seen, or counts that do not fit the slots, and the answer
// is null: the caller keeps its default and says the rows did not settle it.
//
// Returns { fill: [ids] | null, seen: [{ id, hits, applied, perEvent }], exact }
// - `exact` when every slot was placed by a count and none by taking turns.
export function fillFromEvidence({ slots = 0, options = [], evidence = null } = {}) {
  const seen = [];
  for (const o of options) {
    const hits = evidence?.hits?.[o.id] ?? 0;
    const sts = (o.statuses ?? []).map((sid) => evidence?.statuses?.[sid]).filter((x) => x?.events > 0);
    const applied = sts.reduce((n, x) => n + x.events, 0);
    if (!hits && !applied) continue;
    seen.push({ id: o.id, hits, applied, perEvent: sts.length ? Math.max(...sts.map((x) => x.perEvent ?? 0)) || null : null });
  }
  if (!seen.length || !(slots > 0)) return { fill: null, seen, exact: false };
  const fill = [];
  for (const s of seen) if (s.perEvent) for (let i = 0; i < s.perEvent; i++) fill.push(s.id);
  if (fill.length > slots) return { fill: null, seen, exact: false };
  const exact = fill.length === slots;
  const uncounted = seen.filter((s) => !s.perEvent);
  const turns = uncounted.length ? uncounted : seen;
  for (let i = 0; fill.length < slots; i++) fill.push(turns[i % turns.length].id);
  // Slot order is the pool's own.
  const order = new Map(options.map((o, i) => [o.id, i]));
  fill.sort((a, b) => order.get(a) - order.get(b));
  return { fill, seen, exact };
}

// --- which piece of the capture -----------------------------------------------
// A capture recorded for a purpose is a sequence of labelled blocks - sixty
// seconds of basic attacks, one skill pressed alone, a rotation, then the same
// again one talent point later - and a ledger over all of it averages the
// blocks into something no block ever was. The 2026-10-13 dummy sessions made
// that concrete: the Warrior's Judgement read +41.8% per hit over a window
// that mixed three charge levels with armed and unarmed presses, and each of
// those, alone, is a number a formula can be held to. So a window can be
// GIVEN (`--since`, `--until`, `--window a..b`), and the build it is priced
// with is then a second question with its own answer (`--snapshot`).
//
// Times are epoch milliseconds, the capture's own clock - what a `ts_ms`
// column holds and what a journal of blocks records. Both ends are inclusive.

// Read the window flags into a list of ranges, or say what is wrong with them.
//
//   since, until   one range's ends, either one alone leaves the other open
//   windows        `--window` values, each "<from>..<to>" with either side
//                  empty for open; several are read as their union
//
// Returns { windows: [{ from, to }] | null, error }: null windows when nothing
// was asked for (the caller keeps its own default), never both.
export function parseWindows({ since = null, until = null, windows = [] } = {}) {
  const asked = (v) => v !== null && v !== undefined;
  const ms = (v, what) => {
    if (v === true || v === '') return { error: `${what} needs a time in epoch milliseconds` };
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return { error: `${what} needs a time in epoch milliseconds, not "${v}"` };
    return { value: n };
  };
  const out = [];
  if (asked(since) || asked(until)) {
    const a = asked(since) ? ms(since, '--since') : { value: null };
    if (a.error) return { windows: null, error: a.error };
    const b = asked(until) ? ms(until, '--until') : { value: null };
    if (b.error) return { windows: null, error: b.error };
    out.push({ from: a.value, to: b.value });
  }
  for (const w of windows ?? []) {
    const m = /^\s*(\d*)\s*\.\.\s*(\d*)\s*$/.exec(String(w));
    if (!m || (m[1] === '' && m[2] === '')) {
      return { windows: null, error: `--window needs <from>..<to> in epoch milliseconds (either side may be empty), not "${w}"` };
    }
    out.push({ from: m[1] === '' ? null : Number(m[1]), to: m[2] === '' ? null : Number(m[2]) });
  }
  for (const w of out) {
    if (w.from !== null && w.to !== null && w.to < w.from) {
      return { windows: null, error: `a window ends (${w.to}) before it starts (${w.from})` };
    }
  }
  return { windows: out.length ? out.sort((x, y) => (x.from ?? -Infinity) - (y.from ?? -Infinity)) : null, error: null };
}

// Which snapshot a window is priced with, and whether the window is ONE build.
//
//   snaps      the character's snapshots in file order (capture.mjs
//              `snapshots`: ts, until, index), each with `usable` - whether it
//              describes enough of a build to price (the caller's test)
//   windows    the given ranges, or null when the caller is on its default
//   want       `--snapshot`: null, a 1-based index, or "@<ms>" for whichever
//              stood at that moment
//   differ     (a, b) -> the list of differences between two snapshots as
//              builds, empty when they are the same one (capture.mjs
//              `buildDiff`)
//
// The rule for a given window: the build is the snapshot STANDING when the
// window opens - the last one written at or before it. A snapshot stands
// until the next, so that is the build the first row was dealt with. When no
// snapshot precedes the window (the probe writes its first a little after
// login, and a smoke test can beat it) the first one written inside it is
// used, and said. When none is written inside it either - or the one
// standing is too thin to price - the nearest one in time that describes a
// build is used, and said to be a guess. `--snapshot` overrides all three.
//
// Then the honesty half. Every OTHER snapshot that stands somewhere inside
// the window is compared with the chosen one; each that differs is returned
// in `mixed` with what differs and from when. A window priced with one build
// while part of it was dealt with another is still a ledger - but every row
// after the change is evidence about the other build, and the caller has to
// say so before anything else.
//
// Returns { snap, how, note, mixed, error }. `how` is 'asked', 'standing',
// 'next', 'nearest' or null (no window was given, or the character has no
// snapshot that describes a build: the caller's default applies); `note` is
// a sentence for anything a reader would not expect.
export function chooseSnapshot({ snaps = [], windows = null, want = null, differ = () => [] } = {}) {
  const none = { snap: null, how: null, note: null, mixed: [], error: null };
  const inWindows = (s) => (windows ?? []).some((w) => s.ts <= (w.to ?? Infinity) && (s.until ?? Infinity) > (w.from ?? -Infinity));
  const mixedWith = (chosen) => (windows ? snaps.filter((s) => s !== chosen && inWindows(s)) : [])
    .map((s) => ({ index: s.index, ts: s.ts, until: s.until ?? null, differs: differ(chosen, s) }))
    .filter((m) => m.differs.length);

  if (want !== null && want !== undefined) {
    let snap = null;
    const at = /^@(\d+)$/.exec(String(want));
    if (at) {
      const ts = Number(at[1]);
      for (const s of snaps) if (s.ts <= ts) snap = s;
      if (!snap) return { ...none, error: `--snapshot ${want}: no snapshot of this character was written at or before that time` };
    } else {
      const n = Number(want);
      if (!Number.isInteger(n) || n < 1) {
        return { ...none, error: `--snapshot needs a snapshot number (1..${snaps.length}, see --snapshots) or @<epoch ms>, not "${want}"` };
      }
      snap = snaps.find((s) => s.index === n) ?? null;
      if (!snap) return { ...none, error: `--snapshot ${n}: this character has ${snaps.length} snapshot(s) in the capture (see --snapshots)` };
    }
    if (!snap.usable) {
      return { ...none, error: `--snapshot ${snap.index}: that snapshot does not describe a build (too little worn gear in it to price)` };
    }
    return { snap, how: 'asked', note: null, mixed: mixedWith(snap), error: null };
  }
  if (!windows) return none;

  const opens = windows[0].from;
  let standing = null;
  if (opens !== null) for (const s of snaps) if (s.ts <= opens) standing = s;
  if (standing?.usable) return { snap: standing, how: 'standing', note: null, mixed: mixedWith(standing), error: null };
  // Nothing usable stood at the opening: the first usable one written after
  // it, if the window reaches that far.
  const next = snaps.find((s) => s.usable && (opens === null || s.ts > opens) && inWindows(s)) ?? null;
  if (next) {
    return {
      snap: next, how: 'next', mixed: mixedWith(next), error: null,
      note: standing
        ? `the snapshot standing when the window opens (#${standing.index}) does not describe a build; priced with #${next.index}, the first one after it that does`
        : `the window opens before this character's first snapshot; priced with #${next.index}, the first one written inside it`,
    };
  }
  // No build stands at the opening and none is written inside the window: a
  // smoke test recorded before the probe's first snapshot (the 2026-10-13
  // Warrior's first eight rows end 29.5 seconds before it), or a stretch under
  // a snapshot too thin to price. The build is then a guess, and the best
  // one is the NEAREST snapshot in time that does describe a build - the
  // first written after the window closes, or the last that stood before
  // the thin one. It used to be left to the caller, which took the snapshot
  // with the most damage under it and called it that; nearest is the better
  // guess, and either way the ledger has to say it is one.
  const closes = windows.reduce((m, w) => (w.to === null || m === null ? null : Math.max(m, w.to)), -Infinity);
  let nearest = null;
  for (const s of snaps) {
    if (!s.usable) continue;
    const gap = closes !== null && s.ts > closes ? s.ts - closes
      : opens !== null && s.ts <= opens ? opens - (s.until ?? opens) : null;
    if (gap === null) continue;
    if (!nearest || gap < nearest.gap) nearest = { snap: s, gap, after: closes !== null && s.ts > closes };
  }
  if (!nearest) return none;
  const secs = (ms) => `${(ms / 1000).toFixed(ms < 100_000 ? 1 : 0)}s`;
  return {
    snap: nearest.snap, how: 'nearest', mixed: mixedWith(nearest.snap), error: null,
    note: (standing
      ? `the snapshot standing when the window opens (#${standing.index}) does not describe a build, and none is written inside the window; `
      : 'no snapshot of this character stands in or before this window; ')
      + `priced with #${nearest.snap.index}, `
      + (nearest.after ? `written ${secs(nearest.gap)} after it closes` : 'the last one before it that describes a build')
      + '. Nothing says the build was the same: --snapshot <n> names another.',
  };
}

// --- a recorded press sequence, played as the fight ------------------------------
// `--replay` holds the model to the capture's own PRESS SEQUENCE, not just its
// press SET: the sim's chooser is replaced by the recorded timeline - each
// press fires at its recorded offset if the model agrees it is ready - so
// WHICH press finds a register armed, a conduit spent or a charge banked is
// the capture's own order. That is what a replay settles. It is not every
// difference in rate: the swings between the presses are still the model's,
// on the model's clock (their authored durations, back to back), and the
// 2026-10-13 Rogue's 48 replayed rotations still land 484 final combos where
// the capture landed 411 (bench audit, the entries on a press between swings
// and on the chain's round). Where the model DISAGREES that a recorded press
// was possible, that is counted and reported, not silently absorbed: a
// divergence is a finding about the model's cooldown or resource state.
//
//   presses   [{ t, id }] - seconds from the fight's start and the pressed
//             skill, in any order
//   silence   a sequence is ONE fight: it is cut at the first gap between two
//             presses longer than this many seconds (an open-ended window can
//             span several sittings)
//   fight     how long the fight is, when the caller knows: a given window's
//             own length, or what was asked for. Null leaves it to `tail`
//   opens     when the recorded sitting's first skill state opened, in seconds
//             from the fight's start (the log's first `go_state ... Skill` row
//             of the character inside the window), or null when the log does
//             not say. The fight stands still until then: a window is opened
//             by whoever cut it, a third of a second before the player's
//             first swing in the 2026-10-13 Rogue's segments (0.28-0.36 s),
//             and a chain started at the window's first millisecond is that
//             far ahead of the recorded one at every press that follows -
//             which decides what a press that interrupts finds in progress.
//   tail      with no `fight`, it runs this long past its last press, so that
//             press's hits and ticks land inside it. (That was once the only
//             rule, and a 30.5 s window was replayed over 40 s - ten seconds
//             of chain the capture holds no row of - whatever the caller's
//             fight length said.) It is also the rule for a sequence that was
//             cut at a silence: what was given then spans more than one fight.
//
// Returns { seq, fight, policy, tally }: the presses kept, in order; the fight
// length in seconds (null when nothing is left to press); the policy to hand
// `evaluate`; and the tally the policy keeps - of `total` presses, how many
// were `replayed`, how many the model refused as `notReady`, how many are
// `unknown` to its rotation, how many of the replayed ones went off more than
// a second late (`pressedLate`), how many more were pressed at or after the
// fight's end and are not in it (`beyond`), how many swings of the chain a
// replayed press cut short (`cut`: `voided` before the swing's hit, `kept`
// after it - see below), and how many `fights` the schedule was played through.
//
// A PRESS INSIDE A SWING. The fight decides what to press between swings, and
// for most skills that is the game's own rule: a use that interrupts nothing
// waits for the running skill to end. A skill whose row authors
// `props.interruptStyle` does not wait (damage.mjs, `interruptStyleNames`:
// Skill.canInterruptOnUse@9638) - it starts at once and the swing stops where
// it is. The 2026-10-13 Rogue's key cycle did that to 480 of the 3,145 chain
// links its 48 rotation segments started: 338 were stopped before their hit
// and dealt nothing, 142 after it. So a schedule tells the fight what its
// next press is (`policy.peek`), and the fight cuts the swing that press
// falls inside when the pressed skill interrupts. Played without that, the
// same 48 replays landed 560 final combos where the capture landed 411.
//
// ONE EVALUATION IS SEVERAL FIGHTS. sim.mjs rolls a fight `fights` times and
// engine.mjs runs the whole thing again when a conduit buff or the
// crowd-control gate has to be closed on the first pass's schedule, and the
// evaluation that comes back is the LAST one. So the schedule starts over at
// every fight (`policy.reset`, which sim.mjs calls where a fight's state is
// initialised) and the tally with it: what is reported is what the returned
// fight pressed. Before this the cursor was a closure variable that outlived
// the first pass, and on every build that takes a second one the returned
// fight found the sequence spent - the 2026-10-13 Warrior's rotation came back
// with every pressed line MISSING under "45/48 presses replayed".
export function replaySchedule(presses = [], { silence = 120, tail = 15, fight: asked = null, opens = null } = {}) {
  const seq = presses.map((p) => ({ t: p.t, id: p.id })).sort((a, b) => a.t - b.t);
  let cutAtSilence = false;
  for (let i = 1; i < seq.length; i++) {
    if (seq[i].t - seq[i - 1].t > silence) { seq.length = i; cutAtSilence = true; break; }
  }
  const fight = !seq.length ? null
    : asked > 0 && !cutAtSilence ? asked : seq[seq.length - 1].t + tail;
  // A press at or after the bell is not in the fight.
  let beyond = 0;
  while (seq.length && fight !== null && seq[seq.length - 1].t >= fight) { seq.length--; beyond++; }
  const tally = { total: seq.length, replayed: 0, notReady: 0, unknown: 0, pressedLate: 0, beyond, cut: { voided: 0, kept: 0 }, fights: 0 };
  let cursor = 0;
  const policy = ({ ready, actives, t }) => {
    while (cursor < seq.length && seq[cursor].t <= t + 0.05) {
      const want = seq[cursor].id;
      // A via-granted active (the orb status rides its S1 cast) is pressed
      // under its PRESSER's id in the live log.
      const i = actives.findIndex((a) => a.prof.id === want || a.via === want);
      if (i < 0) { cursor++; tally.unknown++; continue; }
      if (!ready.includes(i)) { cursor++; tally.notReady++; continue; }
      cursor++;
      tally.replayed++;
      if (t - seq[cursor - 1].t > 1) tally.pressedLate++;
      return i;
    }
    return -1;
  };
  // When the next recorded press is due, for a fight with nothing to do until
  // then (sim.mjs, where it stands still).
  policy.nextAt = () => (cursor < seq.length ? seq[cursor].t : Infinity);
  // Until when the fight stands still at its opening (see `opens`).
  policy.opensAt = () => (opens > 0 ? opens : 0);
  // ...and what it is, for a fight about to start a swing that press falls
  // inside (sim.mjs, "a recorded press inside this swing"): { t, id } or null.
  policy.peek = () => (cursor < seq.length ? seq[cursor] : null);
  // The swings such a press cut short, counted by the fight as it plays:
  // `voided` before the swing's hit (it dealt nothing), `kept` after it (the
  // hit stood and the swing ended at the press). (The fight also says which
  // link and how far into it; the tally keeps the two counts.)
  policy.cut = (kind) => { tally.cut[kind]++; };
  policy.reset = () => {
    cursor = 0;
    tally.replayed = 0; tally.notReady = 0; tally.unknown = 0; tally.pressedLate = 0;
    tally.cut = { voided: 0, kept: 0 };
    tally.fights++;
  };
  return { seq, fight, policy, tally };
}

// --- what a logged amount is ----------------------------------------------------
// A hero's direct hit reaches the log as a WHOLE number, and that number is
// the CEILING of the float the formula produces: the damage is quantized
// hero-side before the inflict event exists (the accepted build's
// applyDamage, read in MODEL.md: "heroes display ceil"). The model prices the
// float. Left alone, the join then reads every whole-number line low by the
// part the ceiling adds, which is nothing on a 1,500 hit and 3% on a 15 one:
// the 2026-10-13 capture's sword swings logged a mean of 15.25 against a
// model of 15.03, and the two are the same swing.
//
// Checked on that capture, on lines that do not vary: the Warrior's finisher
// priced 229.3 and logged 230 on every plain hit, its second strike 144.3 ->
// 145, its critical strike 352.4 -> 353, and under the +30% of Worldsplitter's
// passive 298.1 -> 299 and 187.6 -> 188 - five ceilings, where rounding
// misses four and flooring all five. And on the one that does: Judgement's
// swings in one fixed buff state, priced 112.3 with the ±10% band, logged
// 102..124 over 64 hits - ceil(101.07) and ceil(123.53) exactly.
//
// So a line whose every logged amount is whole is compared with the model
// lifted by the ceiling's expected half point. For a hit that varies (a
// swing's band, changing buffs) that is the mean of the ceiling; for one that
// never varies the true lift is its own fixed fraction, anywhere in (0, 1],
// so the comparison can still sit half a point off - which the footer says
// in percent for the lines small enough to care. A line that logs fractions
// (the status-tick streams) is not quantized, and takes no lift.
export const INTEGER_STREAM = { lift: 0.5 };

// How close is close enough, per comparison. These are reporting thresholds and
// nothing branches on them - they exist so a 200-row table can be read.
export const BANDS = {
  perHit: { match: 0.03, close: 0.10 },
  share: { match: 0.02, close: 0.05 },
  crit: { match: 0.03, close: 0.08 },
};

function verdict(rel, band) {
  if (rel === null || !Number.isFinite(rel)) return 'UNKNOWN';
  const a = Math.abs(rel);
  if (a <= band.match) return 'MATCH';
  if (a <= band.close) return 'CLOSE';
  return 'MISS';
}

const rel = (model, live) => (live ? (model - live) / live : null);

// Join the model's throughput lines to a capture aggregate.
//
//   modelLines      sim result `.lines` - {id, hits, total:{damage}, interval}
//   captureGroups   aggregate(..., {groupBy:'skill'}).groups
//   only            optional Set of skill ids to consider (a build's own kit)
//   pressed         optional Set of the skill ids pressed in the window: a
//                   model line the capture holds no row of is NOT-PRESSED when
//                   its skill is not in it, PHANTOM when it is
//   carried         optional Set of skill ids the build's own UNRESTRICTED
//                   fight has a line for (the caller's, for a window in which
//                   nothing was pressed): a capture row with no model line is
//                   CARRIED-IN when its skill is in it, MISSING when it is not
//   modelSeconds    how long the model's fight was
//   liveSeconds     how long the capture was in play over these rows
//                   (aggregate().activeMs / 1000). With both, every row that
//                   has both sides carries its RATE - rows per second either
//                   side and the signed difference - and the totals carry
//                   damage per second the same way; without, they are null.
//
// Returns the per-skill rows plus the totals that let a reader see whether the
// gap is spread across everything or concentrated in a few lines.
export function compare({ modelLines = [], captureGroups = [], only = null, pressed = null, carried = null, modelSeconds = null, liveSeconds = null } = {}) {
  const clocked = modelSeconds > 0 && liveSeconds > 0;
  // ONE SKILL ID, TWO HITS. Folding a script-played step into its host (below)
  // is right when the game logs them as one stream and wrong when the rows
  // themselves tell them apart - which they do by AFFINITY. Lethal Poison is
  // the case: the status's tick is Magic, the direct hit its re-application
  // plays is Physical, both are logged under the status's id, and one is a
  // quarter the size of the other; folded, the row's per-hit is the mix of
  // how many of each happened to land. So where the capture holds a skill
  // under two affinities or more, and every model line folding into that
  // skill deals ONE affinity, and they do not all deal the same one, the
  // skill is compared affinity by affinity: a row `<skill> (<Affinity>)` per
  // affinity either side holds. A line that deals two affinities at once
  // (a finisher's Physical and Magic halves, logged as two rows a hit) is
  // one stream and stays folded.
  const liveById = new Map();
  for (const g of captureGroups) if (!only || only.has(g.key)) liveById.set(g.key, g);
  // A PET'S SWINGS ARE COMPARED WHERE THE CAPTURE HOLDS THEM. The fight
  // prices a summon's damage on a line of its summoner (`<cast>#pets`); the
  // game logs each swing under the pet's own skill (`petSkill`), and WHOSE
  // row that is depends on the probe: v10 writes the owner as source
  // (2026-10-13: 56 rows of Summon_Imp_Auto with the Mage as source), older
  // probes wrote the summon, and an aggregate filtered to the player then
  // holds none. So a pet line is folded onto its pet's skill when the
  // capture has rows under that id, and is left out of the join when it has
  // none - where it is neither MISSING nor a claim the rows could refute.
  const petHost = (l) => (l.petSkill && liveById.has(l.petSkill) ? l.petSkill : null);
  const hostOf = (l) => (l.petSource ? petHost(l)
    : l.id.includes('#') ? l.id.slice(0, l.id.indexOf('#')) : l.id);
  const affinitiesBySkill = new Map();
  for (const l of modelLines) {
    if (!l?.id || !((l.total?.damage ?? 0) > 0)) continue;
    const id = hostOf(l);
    if (id == null) continue;
    if (!affinitiesBySkill.has(id)) affinitiesBySkill.set(id, []);
    affinitiesBySkill.get(id).push(l.affinity ?? null);
  }
  const apart = new Set();
  for (const [id, affs] of affinitiesBySkill) {
    if (!(liveById.get(id)?.byAffinity?.length > 1)) continue;
    if (affs.some((a) => !a || a.includes('|')) || new Set(affs).size < 2) continue;
    apart.add(id);
  }
  // The skill a row is about, when the row is one affinity of it.
  const skillOf = new Map();
  const rowKey = (id, affinity) => {
    if (!apart.has(id)) return id;
    const k = `${id} (${affinity})`;
    skillOf.set(k, { skill: id, affinity });
    return k;
  };

  const model = new Map();
  for (const l of modelLines) {
    if (!l?.id) continue;
    const hits = l.hits ?? 0;
    const damage = l.total?.damage ?? 0;
    // A line the fight never played is not a claim about anything - and
    // neither is a line that deals no damage. A heal or a shield cast has
    // hits, but the capture's damage stream never sees it, so keeping it made
    // every Priest prayer a PHANTOM: damage the model "claimed" and the game
    // "never recorded", when nothing damage-shaped was ever claimed at all.
    if (damage <= 0) continue;
    // A script rider carries the id `<host>#<step>`, because the model prices
    // the step separately from the cast that played it. The game does not: the
    // probe logs `dmg.baseSkill`, so every step a skill plays lands under that
    // skill's name. Folding is therefore not a convenience - reporting the
    // rider on its own line would show it as damage the game never recorded
    // AND leave the host looking short by the same amount, which is two wrong
    // answers from one naming difference.
    // A pet line goes to its pet's own skill, or nowhere (`petHost`).
    const host = hostOf(l);
    if (host == null) continue;
    const id = rowKey(host, l.affinity);
    const prev = model.get(id);
    // The crit decomposition of the line, when the fight kept one (sim.mjs
    // `splitAdd`): what its ordinary hits dealt and how many there were, and
    // the same for its critical ones. A row folded from several lines has
    // one only when every line it was folded from does - half a
    // decomposition is not a smaller truth, it is a wrong mean.
    const split = l.split ? { ...l.split } : null;
    // The same id can also appear as both an active and a triggered line; the
    // capture cannot tell those apart either, so neither may we.
    if (prev) {
      prev.hits += hits;
      prev.damage += damage;
      if (prev.split && split) {
        for (const k of ['ncDamage', 'ncHits', 'cDamage', 'cHits']) prev.split[k] += split[k];
      } else prev.split = null;
      if (l.id !== host) prev.parts.push(l.petSource ? l.id : l.id.slice(l.id.indexOf('#') + 1));
    } else {
      model.set(id, {
        id,
        name: l.name ?? id,
        hits,
        damage,
        split,
        interval: l.interval ?? null,
        // A GLOBAL pool dot's per-tick is share x rotation-dps x interval - a
        // rate, not a per-event constant - so its per-hit verdict would just
        // re-measure the rotation-rate difference per-hit exists to ignore.
        globalPool: l.pool ? l.pool.own === false : false,
        parts: l.id !== host ? [l.petSource ? l.id : l.id.slice(l.id.indexOf('#') + 1)] : [],
      });
    }
  }

  const live = new Map();
  for (const g of captureGroups) {
    if (only && !only.has(g.key)) continue;
    if (apart.has(g.key)) {
      for (const sub of g.byAffinity) live.set(rowKey(g.key, sub.key), { ...sub, key: rowKey(g.key, sub.key) });
    } else live.set(g.key, g);
  }

  // What was carried into the window (see the top): a capture row the model's
  // fight has no line for, of a skill the build's unrestricted fight does
  // have. Its damage is not this fight's to explain, so the live total every
  // share and the coverage are measured against leaves it out.
  const isCarried = (id) => carried instanceof Set && !model.has(id) && carried.has(skillOf.get(id)?.skill ?? id);
  const modelTotal = [...model.values()].reduce((s, m) => s + m.damage, 0);
  const recorded = [...live.values()].reduce((s, g) => s + g.total, 0);
  const carriedDamage = [...live].reduce((s, [id, g]) => s + (isCarried(id) ? g.total : 0), 0);
  const liveTotal = recorded - carriedDamage;

  const rows = [];
  for (const id of new Set([...model.keys(), ...live.keys()])) {
    const m = model.get(id);
    const c = live.get(id);

    if (!c) {
      // Two different absences. If the player never PRESSED the skill in this
      // window, the model simply played a rotation the human did not - that is
      // a divergence to know about, not an invented damage source. PHANTOM is
      // reserved for the damning case: pressed, and no damage ever recorded.
      const neverPressed = pressed instanceof Set && !pressed.has(skillOf.get(id)?.skill ?? id);
      const status = neverPressed ? 'NOT-PRESSED' : 'PHANTOM';
      rows.push({
        id, name: m.name, status, ...(skillOf.get(id) ?? {}),
        modelHits: m.hits, modelDamage: m.damage,
        modelShare: modelTotal ? m.damage / modelTotal : 0,
        liveHits: 0, liveDamage: 0, liveShare: 0,
        perHitDelta: null, shareDelta: null, critDelta: null, verdict: status,
      });
      continue;
    }
    if (!m) {
      const status = isCarried(id) ? 'CARRIED-IN' : 'MISSING';
      rows.push({
        id, name: id, status, ...(skillOf.get(id) ?? {}),
        modelHits: 0, modelDamage: 0, modelShare: 0,
        liveHits: c.hits, liveDamage: c.total,
        // (A carried-in row is outside the total the shares are of.)
        liveShare: status === 'MISSING' && liveTotal ? c.total / liveTotal : 0,
        liveMean: c.mean, liveCrit: c.critRate,
        liveNonCrit: c.nonCrit?.mean ?? null, liveNonCritHits: c.nonCrit?.hits ?? 0,
        liveNonCritMin: c.nonCrit?.min ?? null, liveNonCritMax: c.nonCrit?.max ?? null,
        liveCritMean: c.crit?.mean ?? null, liveCritHits: c.crit?.hits ?? 0,
        liveCritMin: c.crit?.min ?? null, liveCritMax: c.crit?.max ?? null,
        perHitDelta: null, shareDelta: null, critDelta: null, verdict: status,
      });
      continue;
    }

    const modelMean = m.hits ? m.damage / m.hits : null;
    const modelShare = modelTotal ? m.damage / modelTotal : 0;
    const liveShare = liveTotal ? c.total / liveTotal : 0;
    // A whole-number stream is the ceiling of the model's float - see
    // INTEGER_STREAM. `perHitRaw` keeps the unlifted comparison.
    const lift = c.integrality === 1 ? INTEGER_STREAM.lift : 0;
    const lifted = (x) => (x === null ? null : x + lift);
    const perHitDelta = rel(lifted(modelMean), c.mean);
    const perHitRaw = rel(modelMean, c.mean);
    // The two halves of the die, each against its own. A half is compared
    // only where both sides have it: the model kept a decomposition for the
    // row, and the window holds at least one hit of that kind.
    const sp = m.split;
    const modelNonCrit = sp && sp.ncHits > 1e-9 ? sp.ncDamage / sp.ncHits : null;
    const modelCrit = sp && sp.cHits > 1e-9 ? sp.cDamage / sp.cHits : null;
    const modelCritRate = sp && sp.ncHits + sp.cHits > 1e-9 ? sp.cHits / (sp.ncHits + sp.cHits) : null;
    const liveNonCrit = c.nonCrit?.mean ?? null;
    const liveCritMean = c.crit?.mean ?? null;
    // Share is already a fraction, so its delta is a difference in percentage
    // points rather than a ratio - a skill at 2% claimed as 4% is 2pp out, and
    // calling that "+100%" would rank it above things that matter more.
    const shareDelta = modelShare - liveShare;

    rows.push({
      id, name: m.name, status: 'BOTH',
      // One affinity of a skill the capture logs under several (see the top).
      ...(skillOf.get(id) ?? {}),
      modelHits: m.hits, modelDamage: m.damage, modelMean, modelShare,
      // Which script-played steps were folded into this row, so a reader can
      // see that the model's hit count is a cast plus its riders.
      parts: m.parts,
      liveHits: c.hits, liveDamage: c.total, liveMean: c.mean, liveShare,
      liveCrit: c.critRate, liveP05: c.p05, liveP95: c.p95,
      // The split: ordinary hits and critical ones apart, on both sides.
      modelNonCrit, modelCrit, modelCritRate,
      liveNonCrit, liveNonCritHits: c.nonCrit?.hits ?? 0, liveNonCritMin: c.nonCrit?.min ?? null, liveNonCritMax: c.nonCrit?.max ?? null,
      liveCritMean, liveCritHits: c.crit?.hits ?? 0, liveCritMin: c.crit?.min ?? null, liveCritMax: c.crit?.max ?? null,
      nonCritDelta: modelNonCrit !== null && liveNonCrit !== null ? rel(lifted(modelNonCrit), liveNonCrit) : null,
      critHitDelta: modelCrit !== null && liveCritMean !== null ? rel(lifted(modelCrit), liveCritMean) : null,
      // What the log's whole numbers were allowed for (0 on a fractional
      // stream), and the comparison without it.
      logLift: lift, perHitRaw,
      liveIntegrality: c.integrality,
      // RATE: rows per second, each side on its own clock, and model minus
      // capture - positive is the model landing the line more often. Both
      // are counted in ROWS (a finisher of two damage instances is two).
      modelRate: clocked ? m.hits / modelSeconds : null,
      liveRate: clocked ? c.hits / liveSeconds : null,
      rateDelta: clocked ? rel(m.hits / modelSeconds, c.hits / liveSeconds) : null,
      // The same comparison as seconds per row, under the names it has
      // always had. (`cadenceDelta` is therefore NEGATIVE where the model
      // lands more.)
      modelInterval: clocked && m.hits ? modelSeconds / m.hits : null,
      liveGapS: clocked && c.hits ? liveSeconds / c.hits : null,
      perHitDelta,
      shareDelta,
      cadenceDelta: clocked && m.hits && c.hits ? rel(modelSeconds / m.hits, liveSeconds / c.hits) : null,
      // A globally-fed pool is judged on SHARE: its tick magnitude is a rate
      // (Hemorrhage read "+34.7% per hit" while its own pricing reproduced
      // the live lattice to the integer - the delta was the model rotation's
      // dps and a second concurrent target, both invisible to a per-tick
      // comparison). The per-hit delta stays on the row, informationally;
      // the ledger prints `pool` in its PER-HIT column and counts the row
      // apart (`totals.pools`), because a figure under that header was read
      // as the formula's: on the 2026-10-13 Rogue's whole span the pool Chaos
      // Scorch feeds (Daggers_Demondash_Passive_Status) stood at +52.7%
      // beside a share 1.6 points out.
      globalPool: m.globalPool || undefined,
      verdict: m.globalPool
        ? (Math.abs(shareDelta) <= BANDS.share.match ? 'MATCH'
          : Math.abs(shareDelta) <= BANDS.share.close ? 'CLOSE' : 'MISS')
        : verdict(perHitDelta, BANDS.perHit),
      shareVerdict: Math.abs(shareDelta) <= BANDS.share.match ? 'MATCH'
        : Math.abs(shareDelta) <= BANDS.share.close ? 'CLOSE' : 'MISS',
    });
  }

  // Worst first, but coverage holes above tuning errors: an unmodelled skill is
  // a bigger problem than a mispriced one, however small its share. A skill the
  // player simply did not press sorts below everything - it is a note about the
  // rotation, not about the model - and so does one carried into the window,
  // which is a note about where the window was cut.
  const rank = (r) => (r.status === 'MISSING' ? 3 : r.status === 'PHANTOM' ? 2
    : r.status === 'NOT-PRESSED' ? 0 : r.status === 'CARRIED-IN' ? 0.5 : 1);
  rows.sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(b) - rank(a);
    return (b.liveDamage || b.modelDamage) - (a.liveDamage || a.modelDamage);
  });

  const missing = rows.filter((r) => r.status === 'MISSING');
  const phantom = rows.filter((r) => r.status === 'PHANTOM');
  const notPressed = rows.filter((r) => r.status === 'NOT-PRESSED');
  const carriedIn = rows.filter((r) => r.status === 'CARRIED-IN');
  const both = rows.filter((r) => r.status === 'BOTH');

  return {
    rows,
    totals: {
      modelDamage: modelTotal,
      // Everything the window recorded, carried-in rows included; the shares
      // and the coverage below are of this less `carriedInDamage`.
      liveDamage: recorded,
      // THE RATE, like for like: what the joined lines deal per second of the
      // model's fight, what the capture's rows dealt per second in play, and
      // the first over the second. PER-HIT cannot say this - it is the count
      // of hits as much as their size. Null without both clocks.
      rate: clocked ? {
        modelSeconds, liveSeconds,
        modelDps: modelTotal / modelSeconds,
        liveDps: recorded / liveSeconds,
        delta: rel(modelTotal / modelSeconds, recorded / liveSeconds),
        // ...and how much of that difference the hits' SIZE accounts for:
        // the capture's own hit counts priced at the model's mean hit, over
        // the lines both sides hold. What is left is how often they land.
        // (At the model's own figure: the half point a whole-number log is
        // allowed in PER-HIT is in neither total above.)
        perHitPart: (() => {
          const live = both.reduce((n, r) => n + r.liveDamage, 0);
          const repriced = both.reduce((n, r) => n + r.liveHits * (r.modelMean ?? 0), 0);
          return live > 0 ? repriced / live - 1 : null;
        })(),
      } : null,
      modelSkills: model.size,
      liveSkills: live.size,
      matched: both.length,
      missing: missing.length,
      phantom: phantom.length,
      notPressed: notPressed.length,
      carriedIn: carriedIn.length,
      carriedInDamage: carriedDamage,
      // The share of what the game actually did that the model has any line
      // for. This is the number that belongs next to a dps figure: a model
      // explaining 78% of observed damage should never print three digits of
      // precision on the other 22%.
      coverage: liveTotal
        ? both.reduce((s, r) => s + r.liveDamage, 0) / liveTotal
        : null,
      missingDamage: missing.reduce((s, r) => s + r.liveDamage, 0),
      // The PER-HIT count: the lines that have a per-hit claim. A globally
      // fed pool has none (its verdict above is its SHARE's) and is counted
      // under `pools`, so the two are never added into one figure with one
      // name.
      verdicts: {
        match: both.filter((r) => !r.globalPool && r.verdict === 'MATCH').length,
        close: both.filter((r) => !r.globalPool && r.verdict === 'CLOSE').length,
        miss: both.filter((r) => !r.globalPool && r.verdict === 'MISS').length,
      },
      pools: {
        match: both.filter((r) => r.globalPool && r.verdict === 'MATCH').length,
        close: both.filter((r) => r.globalPool && r.verdict === 'CLOSE').length,
        miss: both.filter((r) => r.globalPool && r.verdict === 'MISS').length,
      },
    },
  };
}
