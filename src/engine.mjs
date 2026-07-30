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
import { buildSkillPlan } from './skills.mjs';
import { evaluate as evaluateLoadout, classOf, socketsOf } from './loadout.mjs';

export const GOALS = ['dps', 'hps', 'sps', 'ehp', 'mixed'];
export const FERVOR_SCOPES = ['skills', 'all', 'none'];

export const DEFAULT_ASSUME = {
  // Fervor's description says "your Skills", so base attacks are excluded by
  // default. Which reading is right decides whether Fervor gear or penetration
  // gear wins, and neither is verified - see docs/MODEL.md.
  fervorScope: 'skills',
  mastery: true,
};

export function createEngine({ game, assume = {}, quiet = false } = {}) {
  const cdb = loadCdb({ game, quiet });
  const ctx = buildContext(cdb);
  const cat = buildCatalog(cdb, ctx);
  const combat = buildCombat(cdb, ctx);
  const plan = buildSkillPlan(cdb, ctx, cat, combat);
  const opts = { assume: { ...DEFAULT_ASSUME, ...assume } };
  if (!FERVOR_SCOPES.includes(opts.assume.fervorScope)) {
    throw new Error(`fervorScope must be one of ${FERVOR_SCOPES.join(', ')}`);
  }

  const baseCache = new Map();
  const baseStatsFor = (unit, level) => {
    const k = unit + '@' + level;
    let b = baseCache.get(k);
    if (!b) { b = baseStats(cdb, ctx, unit, level); baseCache.set(k, b); }
    return b;
  };

  // The rotation depends on the gear AND on which skills are slotted, so the
  // cache key has to carry both. It is worth caching: the search re-evaluates
  // the same weapon plus skill choice thousands of times.
  const rotationCache = new Map();
  function rotationFor(loadout, rank) {
    const key = rank + '|' + (loadout.gear.Slot_Weapon1?.item ?? '-')
      + '|' + (loadout.gear.Slot_Weapon2?.item ?? '-')
      + '|' + Object.entries(loadout.skills ?? {}).sort().map(([k, v]) => k + ':' + v.join('+')).join(';')
      + '|' + cat.combatSlots().map((s) => loadout.gear[s.id]?.item ?? '').join(',')
      + '|' + Object.entries(loadout.augments ?? {}).filter(([, v]) => v).sort().join(',');
    let r = rotationCache.get(key);
    if (!r) { r = plan.resolve(loadout, rank); rotationCache.set(key, r); }
    return r;
  }

  /** Full evaluation: stat sheet, throughput, survivability, rotation lines. */
  function evaluate(loadout, { target, rank = 1, mix = 0.5 } = {}) {
    const cls = classOf(cat, loadout);
    const tgt = target ?? combat.foe('reference', loadout.level);
    const weaponPower = combat.weaponPowerFor(cat, loadout, cls);
    const rot = rotationFor(loadout, rank);

    // Stats that come from what you know rather than from what you wear:
    //
    //   * a passive ability's own affixes - the weapon-class block skills at
    //     +50/+60 BlockMitigation;
    //   * self-buff statuses a skill applies, at full stacks - the weapon
    //     enchants, where Zealot is +6 CritChanceRating x 5 stacks. That is the
    //     entire value of an enchant slot, and without it the search correctly
    //     concluded that no enchant was worth having.
    const inject = new Map([['WeaponPower', weaponPower]]);
    const addFlat = (atb, v) => inject.set(atb, (inject.get(atb) ?? 0) + v);

    for (const p of rot.passive ?? []) {
      for (const a of p.affixes ?? []) {
        if (a.ref === 'TAttribute_Flat') addFlat(a.target.attribute, a.val ?? 0);
      }
    }
    const buffs = plan.selfBuffs(rot);
    for (const b of buffs) {
      for (const a of b.affixes) {
        if (a.ref === 'TAttribute_Flat') addFlat(a.target.attribute, (a.val ?? 0) * b.stacks);
      }
    }

    const r = evaluateLoadout(cat, loadout, { baseStatsFor, injectFlat: inject });
    const tp = combat.throughput(rot, r.sheet, tgt, opts);
    const sv = combat.survivability(r.sheet, tgt, mix);
    return { ...r, target: tgt, weaponPower, rotation: rot, buffs, throughput: tp, survivability: sv };
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

  const audit = [
    ...auditModel(cdb, ctx),
    ...combat.audit.filter((a) => !(a.what.startsWith('Fervor') && opts.assume.fervorScope === 'none')),
    {
      severity: 'unverified',
      what: 'Slot_Weapon2 contributes 40% of its stats (slot.affixFactor = 0.4)',
      why: 'That is what the data says. Players report the arsenal weapon feeling halved, so if the ' +
           'in-game sheet shows 50%, the number to change is itemType Slot_Weapon2 slot.affixFactor.',
    },
    {
      severity: 'assumption',
      what: 'self-buff statuses are counted at full stacks and 100% uptime',
      why: 'A 15-second buff refreshed by a 30%-per-attack proc does sit at its cap in sustained combat, ' +
           'but a short fight or a movement-heavy one would not reach it.',
    },
    {
      severity: 'assumption',
      what: 'only the main-hand weapon\'s base-attack chain is used',
      why: 'The arsenal is a weapon you swap to, so counting both chains at once would double the filler. ' +
           'Its slotted skills still contribute, which is what UnlockLevel_Arsenal describes.',
    },
  ];

  return {
    cdb, ctx, cat, combat, plan, opts, audit,
    baseStatsFor, evaluate, makeScorer, socketsOf: (l) => socketsOf(cat, l),
    meta: cdb.meta,
  };
}
