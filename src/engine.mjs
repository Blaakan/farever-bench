// ---------------------------------------------------------------------------
// engine.mjs - one object that loads everything and scores a loadout.
//
// The optimiser calls `score()` tens of thousands of times, so the expensive
// work (parsing the CastleDB, building the attribute table, flattening skill
// profiles) happens once here and the per-call path allocates only the three
// modifier maps and the sheet.
//
// A scalar score is what a search needs, but a single number is also how a
// tool starts lying, so `evaluate()` returns every component and the CLI
// prints them next to the winner.
// ---------------------------------------------------------------------------

import { loadCdb } from './cdb.mjs';
import { buildContext, baseStats, auditModel } from './model.mjs';
import { buildCatalog } from './catalog.mjs';
import { buildCombat } from './damage.mjs';
import { evaluate as evaluateLoadout, skillsOf, classOf, socketsOf } from './loadout.mjs';

export const GOALS = ['dps', 'hps', 'sps', 'ehp', 'mixed'];

export const DEFAULT_ASSUME = {
  fervorDamage: true,
  mastery: true,
};

export function createEngine({ game, assume = {}, quiet = false } = {}) {
  const cdb = loadCdb({ game, quiet });
  const ctx = buildContext(cdb);
  const cat = buildCatalog(cdb, ctx);
  const combat = buildCombat(cdb, ctx);
  const opts = { assume: { ...DEFAULT_ASSUME, ...assume } };

  const baseCache = new Map();
  const baseStatsFor = (unit, level) => {
    const k = unit + '@' + level;
    let b = baseCache.get(k);
    if (!b) { b = baseStats(cdb, ctx, unit, level); baseCache.set(k, b); }
    return b;
  };

  // Skill profiles depend only on (id, rank), and both are stable across a
  // search, so the whole rotation is resolved once per distinct skill set.
  const rotationCache = new Map();
  function rotationFor(loadout, rank) {
    const { ids } = skillsOf(cat, loadout);
    const key = rank + '|' + ids.slice().sort().join(',');
    let r = rotationCache.get(key);
    if (!r) {
      r = ids.map((id) => combat.profile(id, rank)).filter(Boolean);
      rotationCache.set(key, r);
    }
    return r;
  }

  /** Full evaluation: stat sheet, throughput, survivability, rotation lines. */
  function evaluate(loadout, { target, rank = 1, mix = 0.5 } = {}) {
    const cls = classOf(cat, loadout);
    const tgt = target ?? combat.foe('reference', loadout.level);
    const weaponPower = combat.weaponPowerFor(cat, loadout, cls);
    const r = evaluateLoadout(cat, loadout, {
      baseStatsFor,
      injectFlat: new Map([['WeaponPower', weaponPower]]),
    });
    const profs = rotationFor(loadout, rank);
    const tp = combat.throughput(profs, r.sheet, tgt, opts);
    const sv = combat.survivability(r.sheet, tgt, mix);
    return { ...r, target: tgt, weaponPower, rotation: profs, throughput: tp, survivability: sv };
  }

  /**
   * The scalar the search maximises.
   *
   * A single goal is used raw. A weighted blend is normalised against a
   * reference evaluation captured once at the start of a run, so "dps=1,
   * ehp=0.25" means what it looks like instead of being swamped by whichever
   * metric happens to have the larger units.
   */
  function makeScorer({ goal = 'dps', weights = null, target, rank = 1, mix = 0.5, ref = null }) {
    const metrics = (ev) => ({
      dps: ev.throughput.dps,
      hps: ev.throughput.hps,
      sps: ev.throughput.sps,
      ehp: ev.survivability.ehp,
    });
    const w = weights && Object.keys(weights).length ? weights : null;
    if (!w && goal !== 'mixed') {
      return {
        metrics,
        score: (loadout) => metrics(evaluate(loadout, { target, rank, mix }))[goal] ?? 0,
        scoreFrom: (ev) => metrics(ev)[goal] ?? 0,
      };
    }
    const blend = w ?? { dps: 1, ehp: 0.25 };
    const refM = ref ? metrics(ref) : null;
    const norm = (m) => {
      let s = 0;
      for (const [k, wk] of Object.entries(blend)) {
        const base = refM?.[k];
        s += wk * ((m[k] ?? 0) / (base && base > 0 ? base : 1));
      }
      return s;
    };
    return {
      metrics,
      score: (loadout) => norm(metrics(evaluate(loadout, { target, rank, mix }))),
      scoreFrom: (ev) => norm(metrics(ev)),
    };
  }

  const audit = [...auditModel(cdb, ctx), ...combat.audit];

  return {
    cdb, ctx, cat, combat, opts, audit,
    baseStatsFor, evaluate, makeScorer, socketsOf: (l) => socketsOf(cat, l),
    meta: cdb.meta,
  };
}
