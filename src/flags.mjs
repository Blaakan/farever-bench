// ---------------------------------------------------------------------------
// The flags `bench` takes: every one bin/bench.mjs reads, in one table.
//
// The parser used to store whatever `--key` it was handed, and a key nobody
// reads was a run of the defaults with nothing said: on build 25782799
// `bench sheet --class Mage --pin weapon1=Staff_Censer --infusion none
// --target-lvl 3 --infusion-stats best` printed the default sheet byte for
// byte - 134.0 where `--target-level 3` gives 179.7 - with an empty stderr and
// exit 0. The update that came with that build put flags one letter apart
// (--infusions / --infusion-stat, --target / --targets / --target-level /
// --target-health, --since / --until / --window, --snapshot / --snapshots),
// so a typo is another search and not an error.
//
// A name that is not in this table is refused by `parseArgs`, with the
// nearest name that is. The table is held from both sides by the suite: every
// flag bin/bench.mjs reads is in it and every entry is read there, and every
// entry is named in `bench --help` and every `--name` the help prints is an
// entry. Adding a flag is therefore three edits that cannot be half done: the
// read, the row here, the line of help.
// ---------------------------------------------------------------------------

// name -> what the parser has to know about it.
//   repeat  it may be given several times; the values are kept in order
//   alias   another spelling of the named flag (not listed in the help by
//           itself, and never read under the name it stands for)
const one = {};
const many = { repeat: true };
export const FLAGS = {
  // which command, which character
  help: one, h: { alias: 'help' }, version: one, V: { alias: 'version' },
  class: one, level: one, game: one, build: one, json: one, verbose: one,
  questlog: one, 'questlog-build': one,
  // the build
  pin: many, 'no-augment': many, skills: many, rune: many, talent: many, 'talent-points': one,
  stars: one, rarity: one, 'rarity-cap': one, 'no-rarity-roll': one, drops: one,
  exclude: one, 'include-all': one, infusions: one, 'infusion-stat': one,
  'class-skills': one, rank: one,
  // the question
  goal: one, weight: many, mix: one, slot: one, all: one,
  // the fight
  target: one, 'target-level': one, 'target-health': one, targets: one,
  fight: one, fights: one, lookahead: one, 'rotation-file': one,
  // the model's assumptions
  'fervor-scope': one, 'no-fervor-damage': one, 'no-mastery': one, 'tick-source': one,
  'chain-persists': one, 'behind-fraction': one, 'swing-floor': one, pickups: one,
  // the search
  restarts: one, 'no-empty': one,
  // profiles, weapons, rotation, layouts
  profile: one, 'profile-base': one, 'profile-peak': one, across: one, 'across-search': one,
  'no-arsenal': one, pairs: one, top: one,
  rounds: one, 'kit-restarts': one, validate: one,
  main: one, arsenal: one, out: one, fresh: one, show: one,
  // verify
  character: one, char: { alias: 'character' }, capture: one, sessions: one, dump: one,
  since: one, until: one, window: many, snapshot: one, snapshots: one,
  split: one, replay: one, 'all-instances': one, 'price-as': one,
  // update
  accept: one, 'with-stale-citations': one, reanchor: one, write: one, only: one, against: one, row: one,
  // ui
  open: one, port: one, host: one,
};

export const REPEATABLE = new Set(Object.keys(FLAGS).filter((k) => FLAGS[k].repeat));

// How far two names are apart: insertions, deletions, substitutions and the
// swap of two neighbours each count one.
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/**
 * The flags a mistyped name most likely meant: the known names within two
 * edits of it (one, for a name of four letters or fewer), nearest first, and
 * the ones it is the start of. Empty when nothing is close - a refusal that
 * guesses at random is worse than one that says it does not know.
 */
export function nearestFlags(name) {
  const key = String(name).toLowerCase();
  const names = Object.keys(FLAGS).filter((k) => !FLAGS[k].alias && k.length > 1);
  const reach = key.length <= 4 ? 1 : 2;
  const scored = names.map((k) => ({ k, d: distance(key, k) }))
    .filter((x) => x.d <= reach || (key.length >= 3 && x.k.startsWith(key)))
    .sort((a, b) => a.d - b.d || a.k.localeCompare(b.k));
  return scored.slice(0, 3).map((x) => x.k);
}
