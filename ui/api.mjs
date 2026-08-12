// ---------------------------------------------------------------------------
// api.mjs - every /api/* endpoint behind the bench UI, per ui/API.md.
//
// One default engine serves bootstrap/catalog/tooltips; /api/sheet draws from
// a small LRU keyed on the engine-construction-time fight options (targets is
// construction-time only - API.md pitfall 3). The optimizer runs in a child
// process (ui/optimize-worker.mjs) because a search blocks the event loop for
// seconds, and its progress comes back as JSON lines relayed over SSE.
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createEngine, GOALS } from '../src/engine.mjs';
import { illegalReason } from '../src/loadout.mjs';
import { ratingGiven, affixSummary } from '../src/format.mjs';
import { buildView, sanitizeLoadout } from './view.mjs';

// A thrown ApiError picks the status; anything else is a bug and reads 500.
class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const toHex = (n) => '#' + (n ?? 0).toString(16).padStart(6, '0');

// icons.mjs is built in parallel with this file and may not exist yet. The
// server must still boot without it - every icon ref degrades to null and
// /asset//icon 404 - so the import is tolerant. Same surface either way.
export async function loadIconService({ benchRoot, game }) {
  const path = join(benchRoot, 'ui', 'icons.mjs');
  if (existsSync(path)) {
    const { createIconService } = await import(pathToFileURL(path).href);
    return createIconService({ benchRoot, game });
  }
  return { iconRef: () => null, atlasFor: () => null, handle: () => false, close() {} };
}

// --- description templates --------------------------------------------------
// The game fills its own tooltips in `HText.makeSkillText`
// (src/const/HText.hx:1036), and what follows is a PORT of that function
// rather than a convention invented here. Every rule below was read out of the
// shipped bytecode with farever-mods/tools/dis-hlcode.mjs and each function is
// named by findex so the reading can be repeated:
//
//   ::(-?)(ref([\d]*)_)?([a-zA-Z]+)([\d]*)(%?)(#?)::        HText.hx:1046
//     -      print the value signed rather than absolute
//     refN_  read the N-th status the row references, not the row itself
//     name   the value's name; trailing DIGITS ARE AN INDEX, so `val1` is the
//            name `val` at index 0 and `dmg2` the name `dmg` at index 1
//     %      render as a percentage
//     #      multiply by the status's LIVE stack count - `getStatusStackMult`
//            @20938 reads `Status.stacks` off a running instance, and a
//            builder has none, so it is 1 here and the token prints one stack
//
// Resolution order, verbatim from fn@21059 (HText.hx:1123-1184):
//   1. the WHOLE name: charges, cooldown, dmgs, dur, duration, name, stacks;
//   2. `inf.vars[name+digits]`, which OVERRIDES step 1 when the row carries it
//      - `Daggers_Start_Combo` authors `vars.duration` and means that one;
//   3. the COMPUTED families - atbgain, dmg, heal, shield, val - which are not
//      stored anywhere. `val` is an affix off the row and needs no character;
//      the rest are damage/healing and have to be priced against one.
//
// The game degrades an unresolved token to the EMPTY STRING (fn@21059 returns
// an `s` that starts empty) and leaves the whole token in place when a `refN_`
// names a status the row does not apply. Neither is useful in a builder, so a
// miss comes back as `MISS` and the caller is told which token it was - and
// the fill NEVER throws, because a template hole is not a server error.

// The last resort. Every family that can degrade to a real authored number
// does so instead of printing this - see `fillDesc`'s `price` contract.
export const MISS = '?';

const TOKEN_RE = /::(-?)(ref(\d*)_)?([a-zA-Z]+)(\d*)(%?)(#?)::/g;
// `HText.parseIdx`: no digits is index 0, `ref2`/`val2` is index 1.
const parseIdx = (d) => (d ? Math.max(0, (parseInt(d, 10) || 1) - 1) : 0);

// `Std.string` on a float. The rounding is this file's own: a ratio that
// arrives as 0.30000000000000004 is not a number the game would ever print.
const numText = (v) => String(Math.round(v * 1e6) / 1e6);

/**
 * `HText.formatVal` (fn@21058, HText.hx:1086).
 *
 * `isRatio` decides what a `%` means. A stored FRACTION scales by 100
 * (`vars.damage: 0.25` -> "25%"); a value already in the attribute's own units
 * does not - a flat +5 CritChance affix reads "5%", not "500%". The game makes
 * that call by testing the affix's ref id for the substring "Ratio", which is
 * the same flat/ratio split `upgradeRider` spells out further down this file.
 */
function formatVal(v, { allowNeg = false, isPercent = false, isRatio = true, valMult = 1 } = {}) {
  let x = v;
  if (!allowNeg && x < 0) x = -x;
  x *= valMult;
  if (!isPercent) return numText(x);
  return isRatio ? `${Math.round(x * 100)}%` : `${numText(x)}%`;
}

// `HSkill.matchesEffectConds` - the one gate the whole file uses for a rank
// band, applied to affixes here and to scaling entries in the pricer.
function condsHold(conds, rank, runes) {
  if (!conds) return true;
  if (conds.minRank != null && rank < conds.minRank) return false;
  if (conds.maxRank != null && rank > conds.maxRank) return false;
  if (conds.equalRank != null && rank !== conds.equalRank) return false;
  if (conds.mastery && !(runes?.has?.(conds.mastery))) return false;
  return true;
}

/**
 * `::valN::` - the N-th AFFIX the row declares that survives the rank filter
 * (fn@21059 @338-444). Pure data: it needs no character and so it resolves in
 * `/api/bootstrap` exactly as well as it does under a loadout.
 */
function affixText(row, idx, rank, runes, opts) {
  const rows = (row?.affixes ?? []).filter((a) => condsHold(a.conds, rank, runes));
  const a = rows[idx];
  if (!a || typeof a.val !== 'number') return null;
  return formatVal(a.val, { ...opts, isRatio: /Ratio/.test(String(a.ref ?? '')) });
}

function refRowsOf(cdb, skillRow) {
  const rows = [];
  const refs = skillRow?.texts?.refs;
  if (refs && typeof refs === 'object') {
    // texts.refs keys are `ref`, `ref2`, `ref3`... in display order.
    const keys = Object.keys(refs).sort((a, b) =>
      (parseInt(a.replace(/\D/g, ''), 10) || 1) - (parseInt(b.replace(/\D/g, ''), 10) || 1));
    for (const k of keys) rows.push(cdb.byId('skill').get(refs[k]) ?? null);
  }
  if (!rows.length) {
    for (const st of skillRow?.steps ?? []) {
      const ref = st.props?.status?.ref;
      if (ref) rows.push(cdb.byId('skill').get(ref) ?? null);
    }
  }
  return rows;
}

function termName(cdb, term) {
  const gt = cdb.byId('gameTerm').get(term);
  if (gt?.texts?.name?.v) return gt.texts.name.v;
  const at = cdb.byId('attribute').get(term);
  if (at?.name) return at.name;
  const st = cdb.byId('statusType').get(term);
  if (st?.texts?.name?.v) return st.texts.name.v;
  // ...and a SKILL row, which is what a sentence means when it links the
  // status it applies: twelve links in this build resolve nowhere else, and
  // "applying a Staff_Censer_Mark" is meant to read "applying a Luon Mark".
  const sk = cdb.byId('skill').get(term)?.texts?.name;
  if (typeof sk === 'string' && sk) return sk;
  return term;
}

// CastleDB marks a float column `display: 1` (DisplayMode.Percent) when the
// stored 0..1 value is READ as a percentage. All 33 such columns in this cdb
// are ratios - drop rates, armorReduction, affixFactor - and exactly two of
// them are `skill.vars`: `chance` and `threshold`. So a bare `::chance::` is
// "6%" and not "0.06", which is what the game prints ("Your Base Attacks have
// a 4% chance to attack twice" off a vars.chance of 0.04); the `%` suffix on a
// token is an explicit spelling of the same rule, not the only way to ask for
// it. Sixty-nine descriptions in this build write the token bare.
const percentVarCache = new WeakMap();
function percentVars(cdb) {
  let set = percentVarCache.get(cdb);
  if (set) return set;
  set = new Set();
  try {
    for (const sh of cdb.raw?.sheets ?? []) {
      if (sh.name !== 'skill@vars') continue;
      for (const c of sh.columns ?? []) if (c.display === 1 && c.name) set.add(c.name);
    }
  } catch { /* a cdb shaped differently just loses the nicety */ }
  percentVarCache.set(cdb, set);
  return set;
}

/**
 * Fill one description template.
 *
 * @param own      the row's vars at the rank being described - the caller
 *                 resolves `props.rankOverride`, because a rank is exactly
 *                 what selects between them.
 * @param rank     the rank the sentence describes; gates affix conditions.
 * @param runes    slotted mastery ids, for a rune-gated affix condition.
 * @param varsFor  vars of a REFERENCED row, resolved at `rank` the same way.
 * @param infFor   `(row) => {cooldown, charges, duration}` at that rank, which
 *                 are COLUMNS and not vars - the game keeps both, and three
 *                 rows in this build author a `vars.cooldown` that wins over
 *                 the column exactly as it does in game.
 * @param price    `(row, spec) => string|null` for the computed families -
 *                 dmg/dmgs/heal/shield/atbgain. Null when there is no
 *                 character to price against, which is the honest answer in
 *                 `/api/bootstrap`; the caller then falls back to the authored
 *                 coefficient rather than to `MISS`.
 * @param notes    optional array; every unresolved token is pushed onto it as
 *                 `{ token, why }` so the endpoint can report what it refused.
 */
export function fillDesc(cdb, desc, {
  own = {}, skillRow = null, skillName = null,
  rank = 1, runes = null, varsFor = null, infFor = null, price = null, notes = null,
} = {}) {
  if (!desc) return '';
  const refs = refRowsOf(cdb, skillRow);
  const pcts = percentVars(cdb);
  const name = skillName ?? skillRow?.texts?.name ?? skillRow?.id ?? '';
  const miss = (token, why) => { notes?.push({ token, why }); return MISS; };

  const filled = String(desc).replace(TOKEN_RE,
    (whole, neg, refPrefix, refDigits, key, idxDigits, pctSign, hashSign) => {
      try {
        const ref = refPrefix ? (refs[parseIdx(refDigits)] ?? null) : null;
        if (refPrefix && !ref) {
          return miss(whole, 'the row does not apply a status at that reference index');
        }
        const row = ref ?? skillRow;
        const full = key + idxDigits;
        const vars = ref
          ? (varsFor ? (varsFor(ref) ?? ref.vars ?? {}) : (ref.vars ?? {}))
          : own;
        const opts = {
          allowNeg: neg === '-',
          // A bare `::chance::` is a percentage: CastleDB marks the column
          // `display: 1` and the game hardcodes the same name (fn@21059
          // @202). All 33 such columns are ratios and exactly two of them are
          // `skill.vars` - `chance` and `threshold` - so "6%" and not "0.06",
          // which is what the game prints off a `vars.chance` of 0.06.
          isPercent: pctSign === '%' || pcts.has(full),
          // `#` is the live stack count, and there is no live status here.
          valMult: 1,
        };
        void hashSign;

        // (1) the whole-name specials. `name` returns the display name rather
        // than the game's `[id]` link because this file resolves links to
        // plain terms and a skill id is not a gameTerm.
        let special = null;
        const inf = (infFor ? infFor(row) : null) ?? row ?? {};
        if (full === 'name') return ref?.texts?.name ?? name;
        // A resolved 0 means "this row has no such column" far more often
        // than it means zero seconds, so it degrades to a miss rather than to
        // a confident "0s".
        else if (full === 'cooldown') {
          const v = inf.cooldown || row?.cooldown;
          if (v > 0) special = `${numText(v)}s`;
        } else if (full === 'charges') {
          const v = inf.charges ?? row?.props?.charges;
          if (typeof v === 'number') special = numText(v);
        } else if (full === 'dur' || full === 'duration') {
          const v = inf.duration || row?.duration;
          if (v > 0) special = `${numText(v)}s`;
        } else if (full === 'stacks') {
          // `props.status.maxStacks ?? 1`. A -1 means "no cap", which is not a
          // count a sentence can carry, so it falls through to a miss.
          const v = row?.props?.status?.maxStacks;
          if (typeof v === 'number' && v > 0) special = String(v);
          else if (v == null) special = '1';
        } else if (full === 'dmgs' && price) {
          special = price(row, { kind: 'damage-all', index: 0, ...opts });
        }

        // (2) an authored var WINS over the special above - that is the order
        // the game runs, and `Daggers_Start_Combo`'s `vars.duration` is why.
        const v = vars?.[full];
        if (v != null && typeof v !== 'object') {
          // The three named formats fn@21059 dispatches on the NAME rather
          // than the whole token, so `dur1` and `time2` are seconds too.
          // One row in the build - DS_Bladeleaf_Skill1 - writes "::time::
          // seconds" and so reads "4s seconds", which is what the game shows.
          if (key === 'chance') return `${Math.round(v * 100)}%`;
          if ((key === 'dur' || key === 'time') && !opts.isPercent) {
            return `${numText(v * opts.valMult)}s`;
          }
          return formatVal(v, opts);
        }
        if (special != null) return special;

        // (3) the computed families.
        const idx = parseIdx(idxDigits);
        if (key === 'val') {
          const t = affixText(row, idx, rank, runes, opts);
          if (t != null) return t;
          return miss(whole, `the row has no affix ${idx + 1} at rank ${rank}`);
        }
        if (key === 'dmg' || key === 'dmgs' || key === 'heal'
          || key === 'shield' || key === 'atbgain') {
          const t = price ? price(row, { kind: key === 'dmgs' ? 'damage-all' : key, index: idx, ...opts }) : null;
          if (t != null) return t;
          return miss(whole, price
            ? `${row?.id ?? 'the row'} declares no ${key} this reader can price`
            : 'no character to price it against');
        }
        return miss(whole, `no value named "${full}" on ${row?.id ?? 'the row'}`);
      } catch { return MISS; }
    });
  return filled.replace(/\[([^\]]*)\]/g, (_, term) => termName(cdb, term));
}

// --- pricing a magnitude ----------------------------------------------------
// A skill's damage is not a stored var: it is computed from the skill's steps
// against the character, which is why 154 `::dmg::` tokens used to print '?'.
//
// WHICH effect a token names comes off `HSkill.getEffectIndex` (@20830): it
// walks `steps` in order and each step's `effects` in order, counts the ones
// its predicate accepts, and returns the index-th. There is NO rank filter and
// NO script/played distinction on that walk, which is exactly right and is why
// this reads the RAW cdb row rather than damage.mjs's profile:
//
//   * `GA_Craft_Skill1` (Rampage) declares Hit1/Hit2/Hit3 as mutually
//     exclusive charge levels and its sentence says "between ::dmg:: and
//     ::dmg3::" - the profile keeps only the full-charge step, so indexing it
//     would print the 6x Strength number for BOTH ends of that range;
//   * `Staff_Censer_Skill2`'s whole payload is a script-played `Explosion`
//     step, which the profile files under `scripted` and the sentence still
//     calls `::dmg::`.
//
//   dmg      predicate `affinity != null`   (HSkill.getDamageEffect@20755)
//   heal     `effect == Heal`               (HText.makeEffectDetail@20948)
//   shield   `effect == Shield`
//   atbgain  `effect == GainAtb`
//   dmgs     every Damage effect, grouped by affinity and joined with " + ",
//            SKIPPING steps played by script (`on == Code`) - the one place
//            the two walks differ (HText.makeDamageDetails@20947 + fn@21063)
//
// WHAT it prints is `HText.skillEffectValText` (@20949, HText.hx:1417):
//
//   raw    = baseVal + SUM(ratio x attribute)
//   raw   *= getDamageRatio(root)   // (1 + mastery + Fervor) x DamageModifier
//   amount = ceil(raw)              // ent.Hero.flattenAtbScaling@7448 is ceil
//   range  = WeaponAttack_RandomRange x amount, and ZERO unless the row's type
//            is Attack..Attack4 (getEffectRange@20779) - so a weapon skill, a
//            finisher and a status tick each print ONE number and only a basic
//            swing prints a band
//   print    floor(lo x mult) - ceil(hi x mult) when they differ, else
//            floor(amount x mult), where mult is DamageModifier /
//            HealGivenMultiplier / ShieldPowerMultiplier by effect kind
//
// DamageModifier therefore lands TWICE on a Damage effect - once inside
// getDamageRatio@4505 and once as `mult`. That is the game's own arithmetic
// and not a transcription slip: both reads go through `atbVal`@4499, which
// normalises a percent-flagged attribute by 0.01, so a neutral 100 is 1.0 and
// only a build that actually carries DamageModifier can tell the difference.
//
// Notice what is NOT in that expression: no crit, no armour, no target at all.
// The tooltip is a PRE-MITIGATION number, which is why it never agrees with a
// damage meter directly - see the note on `tooltipSkill`.
const MIX_ATB = 0.6;   // WeaponPowerRatio.MainhandWeaponSkill, the other half
const MIX_FLAT = 0.4;  // of it - see damage.mjs `amountOf` for the ten measured

/**
 * Whether an effect carries a magnitude AT ALL, as opposed to a placeholder
 * the runtime fills in. Two shapes are refused, both of them skills.mjs's own
 * tests rather than new ones:
 *
 *   * `dynVal` with nothing beside it - the magnitude is injected by a script
 *     and `Priest_Talent_BurningRays_Status` has no baseVal and no scaling at
 *     all, so reading baseVal+scaling scores it zero, which is right, and
 *     printing that zero would not be;
 *   * NO scaling and |baseVal| <= 1 - a POOL DOT. `Axe_Boomerang_Skill1_Status`
 *     is a Bleed whose whole amount is a share of the strike that applied it,
 *     and its row carries `baseVal: 1` as a marker. Priced as an amount it
 *     reads "a Bleeding effect dealing 2 over 8s", which is a made-up number
 *     for a bleed that hits for hundreds.
 */
function priceable(e) {
  const base = typeof e?.baseVal === 'number' ? e.baseVal : 0;
  const scaling = (e?.scaling ?? []).length;
  if ((e?.dynVal ?? 0) !== 0 && !scaling) return false;
  if (!scaling) return Math.abs(base) > 1;
  return true;
}

/**
 * A pricer bound to one character. `sheet` is the RESTING sheet - what the
 * game shows you standing still - because that is what its tooltip reads.
 */
function createPricer(engine, { loadout, sheet, rank = 1, mixIds = null }) {
  const { cat, cdb, ctx, combat } = engine;
  const effectNames = cdb.enumValues('skill@steps@effects', 'effect');
  const typeNames = cdb.enumValues('skill', 'type');
  const stepOnNames = cdb.enumValues('skill@steps', 'on');
  const num = (v) => (typeof v === 'number' ? v : 0);
  const stat = (id) => sheet.get(id) ?? 0;

  // `isWeaponBased` (BaseSkill@6057) is a set of skill TYPES with no slot
  // check, so the arsenal's skills mix exactly like the mainhand's and a class
  // skill stays pure attribute.
  const WEAPON_BASED = new Set(['Attack', 'Attack2', 'Attack3', 'Attack4',
    'AttackCombo', 'Block', 'WeaponSkill', 'WeaponSubSkill', 'WeaponPassive']);
  const BASIC_SWING = new Set(['Attack', 'Attack2', 'Attack3', 'Attack4']);

  // WeaponPower reads the weapon's flat PLUS the mean of the ITEM's aptitude
  // attributes, and a weapon skill's attribute scaling mixes 60% attribute
  // with 40% of that attribute's own budget curve. Both are engine.mjs's own
  // derivation, lifted here so a tooltip cannot disagree with the sheet.
  const mainItem = loadout?.gear?.Slot_Weapon1?.item
    ? cat.itemById.get(loadout.gear.Slot_Weapon1.item) : null;
  const swingAttrs = mainItem
    ? mainItem.aptitudes.map((a) => combat.primaryAtbFor({ aptitude: a })).filter(Boolean)
    : [];
  const mixFlats = (mainItem || loadout?.gear?.Slot_Weapon2?.item)
    ? combat.attributeBudgets(loadout.level) : null;

  const dmgMod = stat('DamageModifier') / 100;
  const healMod = stat('HealGivenMultiplier') / 100;
  const shieldMod = stat('ShieldPowerMultiplier') / 100;
  const fervor = stat('Fervor') / 100;
  // getDamageARatio@4509: Magic reads MagicMastery, Physical PhysicalMastery,
  // Raw nothing at all.
  const masteryOf = (root) => (root === 'Magic' ? stat('MagicMastery') / 100
    : root === 'Physical' ? stat('PhysicalMastery') / 100 : 0);

  const kindOf = (e) => effectNames[e?.effect ?? -1] ?? null;
  const effectsOf = (row, { skipCode = false } = {}) => {
    const out = [];
    for (const st of row?.steps ?? []) {
      if (skipCode && stepOnNames[st.on ?? -1] === 'Code') continue;
      for (const e of st.effects ?? []) out.push(e);
    }
    return out;
  };

  // A STATUS row has no type of its own, so `isWeaponBased` says no - and yet
  // a status a WEAPON grants ticks on the mix like every other weapon cast,
  // which is measured (damage.mjs `tickScaling.mixIds`, and the game's own
  // renderer hands `getStepEffectScaling` the granting item so its type chain
  // reaches MainhandWeapon). `mixIds` is that set, taken off the rotation the
  // build actually plays so the tooltip and the meter cannot disagree.
  const takesMix = (row) => WEAPON_BASED.has(typeNames[row?.type ?? -1])
    || !!mixIds?.has(row?.id);

  const amountOf = (row, e) => {
    let a = num(e.baseVal);
    const mix = takesMix(row) ? mixFlats : null;
    for (const sc of e.scaling ?? []) {
      if (!sc.atb || !condsHold(sc.conds, rank, null)) continue;
      let v = stat(sc.atb);
      if (sc.atb === 'WeaponPower' && swingAttrs.length) {
        let sum = 0;
        for (const atb of swingAttrs) sum += stat(atb);
        v += sum / swingAttrs.length;
      } else if (mix) {
        const f = mix.get(sc.atb);
        if (f) v = MIX_ATB * v + MIX_FLAT * f;
      }
      a += num(sc.ratio) * v;
    }
    return a;
  };

  const render = (row, e) => {
    const kind = kindOf(e);
    if (!priceable(e)) return null;
    let x = amountOf(row, e);
    if (!Number.isFinite(x)) return null;
    const root = e.affinity ? combat.affinityOf(e.affinity).root : null;
    if (root) x *= (1 + masteryOf(root) + fervor) * dmgMod;
    const amount = Math.ceil(x);
    const band = (kind === 'Damage' && BASIC_SWING.has(typeNames[row?.type ?? -1]))
      ? (ctx.consts.weaponAttackRandomRange ?? 0.1) : 0;
    const mult = kind === 'Damage' ? dmgMod
      : kind === 'Heal' ? healMod : kind === 'Shield' ? shieldMod : 1;
    const lo = Math.floor(Math.ceil(amount - band * amount) * mult);
    const hi = Math.ceil(Math.ceil(amount + band * amount) * mult);
    return lo < hi ? `${lo}–${hi}` : String(Math.floor(amount * mult));
  };

  return (row, { kind, index }) => {
    try {
      if (kind === 'damage-all') {
        // Grouped by affinity root, values joined with " + " inside a group -
        // "Strikes with both weapons" is two effects and the game prints both.
        const groups = new Map();
        for (const e of effectsOf(row, { skipCode: true })) {
          if (kindOf(e) !== 'Damage') continue;
          const t = render(row, e);
          if (t == null) continue;
          const root = e.affinity ? combat.affinityOf(e.affinity).root : 'Damage';
          if (!groups.has(root)) groups.set(root, []);
          groups.get(root).push(t);
        }
        if (!groups.size) return null;
        const parts = [...groups].map(([root, vals]) =>
          (groups.size > 1 ? `${vals.join(' + ')} ${root}` : vals.join(' + ')));
        return parts.join(' and ');
      }
      const want = kind === 'dmg' ? ((e) => e.affinity != null)
        : kind === 'heal' ? ((e) => kindOf(e) === 'Heal')
          : kind === 'shield' ? ((e) => kindOf(e) === 'Shield')
            : ((e) => kindOf(e) === 'GainAtb');
      let n = 0;
      for (const e of effectsOf(row)) {
        if (!want(e)) continue;
        if (n === index) return render(row, e);
        n++;
      }
      return null;
    } catch { return null; }
  };
}

/**
 * The same families with NO character to price against.
 *
 * The game's own answer here is the product of the effect's scaling ratios as
 * a percentage (skillEffectValText @117-150, the `unit == null` branch), which
 * for a two-attribute effect multiplies 1.2 by 1.2 and prints 144%. That is a
 * number nobody can use, so this prints the SAME information the game's
 * expanded tooltips render - "120% Intellect + 120% Faith" - which is what the
 * row actually authors and is readable without a build. Only a row that
 * authors no magnitude at all falls through to `MISS`.
 */
function createCoefficientPricer(engine, { rank = 1 } = {}) {
  const { cdb } = engine;
  const effectNames = cdb.enumValues('skill@steps@effects', 'effect');
  const stepOnNames = cdb.enumValues('skill@steps', 'on');
  // Six attributes ship with an empty display name (MaxSpark among them), and
  // "18% " is not a sentence - the id is the readable fallback.
  const attrName = (id) => cdb.byId('attribute').get(id)?.name || id;
  const kindOf = (e) => effectNames[e?.effect ?? -1] ?? null;
  const effectsOf = (row, skipCode) => {
    const out = [];
    for (const st of row?.steps ?? []) {
      if (skipCode && stepOnNames[st.on ?? -1] === 'Code') continue;
      for (const e of st.effects ?? []) out.push(e);
    }
    return out;
  };
  const coeff = (e) => {
    if (!priceable(e)) return null;
    const terms = [];
    if (typeof e.baseVal === 'number' && e.baseVal !== 0) terms.push(String(e.baseVal));
    for (const sc of e.scaling ?? []) {
      if (!sc.atb || !condsHold(sc.conds, rank, null)) continue;
      terms.push(`${Math.round((sc.ratio ?? 0) * 100)}% ${attrName(sc.atb)}`);
    }
    return terms.length ? terms.join(' + ') : null;
  };
  return (row, { kind, index }) => {
    try {
      if (kind === 'damage-all') {
        const parts = effectsOf(row, true)
          .filter((e) => kindOf(e) === 'Damage').map(coeff).filter(Boolean);
        return parts.length ? parts.join(' + ') : null;
      }
      const want = kind === 'dmg' ? ((e) => e.affinity != null)
        : kind === 'heal' ? ((e) => kindOf(e) === 'Heal')
          : kind === 'shield' ? ((e) => kindOf(e) === 'Shield')
            : ((e) => kindOf(e) === 'GainAtb');
      let n = 0;
      for (const e of effectsOf(row, false)) {
        if (!want(e)) continue;
        if (n === index) return coeff(e);
        n++;
      }
      return null;
    } catch { return null; }
  };
}

// --- the api ----------------------------------------------------------------

export async function createApi({ benchRoot, game = null }) {
  const version = (() => {
    try { return JSON.parse(readFileSync(join(benchRoot, 'package.json'), 'utf8')).version ?? '0.1.0'; }
    catch { return '0.1.0'; }
  })();

  // Engines keyed by the construction-time fight options. The default key is
  // also what bootstrap/catalog/tooltips read from. createEngine is ~50ms
  // warm, so an LRU miss is cheap; rank/mix/goal/target stay per-evaluate.
  const engines = new Map();
  function engineFor({ targets = 1, fight = 200, lookahead = 0 } = {}) {
    const key = `${targets}|${fight}|${lookahead}`;
    let e = engines.get(key);
    if (e) { engines.delete(key); engines.set(key, e); return e; } // refresh LRU order
    e = createEngine({ quiet: true, game, fight: { seconds: fight, targets, lookahead } });
    engines.set(key, e);
    if (engines.size > 4) engines.delete(engines.keys().next().value);
    return e;
  }
  const eng = engineFor(); // the default engine, booted once up front
  // The engine already resolved the install dir, so the icon service never
  // has to repeat the auto-detection.
  const icons = await loadIconService({ benchRoot, game: game ?? eng.meta.game });

  const skillRow = (id) => eng.cdb.byId('skill').get(id);
  const skillName = (id) => skillRow(id)?.texts?.name ?? id;
  const skillIcon = (id) => {
    const g = skillRow(id)?.gfx;
    return g?.file ? icons.iconRef(g) : null;
  };
  const itemTypeRow = (id) => eng.cdb.byId('itemType').get(id);
  const typeNameOf = (typeId) => {
    const t = itemTypeRow(typeId)?.texts?.name;
    return (t && typeof t === 'object' ? t.v : t) ?? typeId;
  };
  const attrName = (id) => eng.cdb.byId('attribute').get(id)?.name ?? id;

  // --- GET /api/bootstrap ---------------------------------------------------

  let bootstrapCache = null;
  function bootstrap() {
    if (bootstrapCache) return bootstrapCache;
    const { cat, ctx, combat, talents, cdb } = eng;

    const colorRows = new Map(cdb.lines('color').map((r) => [r.id, r.value]));
    const classes = cat.classes.map((c) => {
      const iconRow = cdb.byId('icon').get(`Class_${c.unit}`);
      return {
        unit: c.unit,
        aptitude: c.aptitude,
        name: c.aptitudeName ?? c.unit,
        color: toHex(colorRows.get(`${c.unit}_Light`)),
        icon: iconRow?.gfx ? icons.iconRef(iconRow.gfx) : null,
        flagIcon: cdb.byId('unit').get(c.unit)?.gfx
          ? icons.iconRef(cdb.byId('unit').get(c.unit).gfx) : null,
        armorReduction: cat.armorReductionFor(c.aptitude),
      };
    });

    const rarities = cdb.lines('rarity').map((r) => ({
      id: r.id,
      name: r.name,
      color: toHex(r.color),
      iLevelBonus: r.props?.iLevelBonus ?? 0,
      stars: r.props?.gearUpgrades ?? 0,
    }));

    const attributes = {};
    for (const a of cdb.lines('attribute')) {
      const t = ctx.attrTable.byId.get(a.id);
      attributes[a.id] = {
        name: a.name ?? a.id,
        color: toHex(a.color),
        icon: a.gfx?.file ? icons.iconRef(a.gfx) : null,
        percent: !!t?.isPercent,
        rating: !!t?.isRating,
        desc: a.desc ?? null,
      };
    }

    // The doll in the game's visual order, then the three weapon slots. The
    // empty-slot tile comes off the Slot_* itemType row when it carries one
    // and the slot's item type otherwise (weapon slots do it the second way).
    const DOLL = [
      ['Slot_Head', 'left'], ['Slot_Neck', 'left'], ['Slot_Shoulders', 'left'],
      ['Slot_Chest', 'left'], ['Slot_Back', 'left'], ['Slot_FingerLeft', 'left'],
      ['Slot_Hands', 'right'], ['Slot_Waist', 'right'], ['Slot_Legs', 'right'],
      ['Slot_Feet', 'right'], ['Slot_Trinket', 'right'], ['Slot_FingerRight', 'right'],
    ];
    const WEAPONS = ['Slot_Weapon1', 'Slot_Weapon2', 'Slot_OffhandWeapon'];
    // Which socket types can ever appear on this slot: the union over every
    // item that fits it, which is what cat.augmentTypes' target chains mean.
    const socketsForSlot = (slotId) => {
      const found = new Set();
      for (const it of cat.items) {
        if (it.isAugment || !it.slots.includes(slotId)) continue;
        for (const t of cat.socketsFor(it)) found.add(t);
      }
      return [...found];
    };
    const slotEntry = (slotId, column) => {
      const slot = cat.slotById.get(slotId);
      const row = itemTypeRow(slotId);
      const short = slotId.replace(/^Slot_/, '');
      const gfx = row?.gfx ?? itemTypeRow(slot?.types?.[0])?.gfx ?? null;
      const label = row?.texts?.slotName
        ?? (typeof row?.texts?.name === 'object' ? row.texts.name.v : row?.texts?.name)
        ?? short;
      return {
        id: slotId, short, column, label,
        emptyIcon: gfx ? icons.iconRef(gfx) : null,
        sockets: socketsForSlot(slotId),
      };
    };
    const slots = [
      ...DOLL.map(([id, col]) => slotEntry(id, col)),
      ...WEAPONS.map((id) => slotEntry(id, null)),
    ];

    const targets = combat.foes.map((id) => ({
      id, label: combat.foe(id, ctx.consts.maxLevel).name,
    }));

    // Bootstrap is CLASS-WIDE and has no build, so a magnitude here has no
    // honest number - a talent's poison ticks for whatever the character
    // wearing it has. These sentences therefore carry the AUTHORED
    // coefficient ("35% Dexterity") rather than a bare '?', and the skill
    // tooltip re-prices the same line against the live loadout the moment one
    // exists. Rank 1 throughout: a talent's own ladder is `readableValue`, and
    // a rune is authored against its skill's rank-1 steps.
    const coeff = createCoefficientPricer(eng, { rank: 1 });

    const talentTrees = {};
    for (const c of cat.classes) {
      const tree = talents.treeFor(c.unit);
      talentTrees[c.unit] = {
        root: tree.root,
        thresholds: talents.thresholds,
        displayCost: talents.thresholds.map((t) => Math.max(0, t - 1)),
        unlockLevel: talents.unlockLevel,
        nodes: tree.nodes.map((n) => {
          const row = skillRow(n.skill);
          const rv = talents.readableValue(n.skill, 1);
          return {
            id: n.skill,
            name: n.name,
            tier: n.tier,
            branch: n.branch,
            branchIndex: n.branchIndex,
            maxPoints: rv.maxPoints,
            icon: skillIcon(n.skill),
            desc: fillDesc(cdb, row?.texts?.desc, {
              own: { ...(row?.vars ?? {}) }, skillRow: row, rank: 1, price: coeff,
            }),
            readable: rv.readable,
            kind: rv.kind,
          };
        }),
      };
    }

    const runes = {};
    for (const s of cdb.lines('skill')) {
      const masteries = (s.mastery ?? []).filter((m) => m.id);
      if (masteries.length < 2) continue;
      runes[s.id] = {
        skillName: s.texts?.name ?? s.id,
        skillIcon: skillIcon(s.id),
        options: talents.runesFor(s.id).map((o) => {
          const m = masteries.find((x) => x.id === o.id);
          return {
            id: o.id,
            name: o.name,
            desc: fillDesc(cdb, o.desc, {
              own: { ...(o.props ?? {}), ...(s.vars ?? {}), ...(o.vars ?? {}) },
              skillRow: s, rank: 1, runes: new Set([o.id]), price: coeff,
            }),
            icon: m?.gfx?.file ? icons.iconRef(m.gfx) : null,
            readable: o.readable,
          };
        }),
      };
    }

    const augments = {};
    for (const t of cat.augmentTypes) {
      augments[t.id] = cat.augmentCandidates(t.id).map((a) => ({
        id: a.id,
        name: a.name,
        icon: a.raw?.gfx?.file ? icons.iconRef(a.raw.gfx) : null,
        rarity: a.rarity,
        effect: affixSummary(a.affixes),
        // Sigils are class-gated via usableBy; augmentCandidates does not
        // filter them (pitfall 14), so the gate is derived here.
        classGate: t.id === 'AugmentDemonSigil'
          ? (cat.classes.find((c) => cat.usableBy(a, c.aptitude))?.unit ?? null)
          : null,
        acquire: icons.atlasFor(a.id)?.acquire ?? null,
      }));
    }

    bootstrapCache = {
      meta: {
        version,
        cdbSha: eng.meta.cdbSha,
        bootSha: eng.meta.bootSha,
        game: eng.meta.game,
      },
      classes, rarities, attributes, slots, targets,
      goals: GOALS,
      talents: talentTrees,
      runes,
      augments,
      constants: {
        maxLevel: ctx.consts.maxLevel,
        talentPointsAtCap: talents.defaultPointsAtCap,
      },
    };
    return bootstrapCache;
  }

  // --- GET /api/catalog?class=X&level=N ------------------------------------

  function catalog(searchParams) {
    const { cat } = eng;
    const clsName = searchParams.get('class');
    const cls = cat.classes.find((c) => c.unit === clsName || c.aptitude === clsName);
    if (!cls) throw new ApiError(400, `unknown class "${clsName}"`);
    const level = parseInt(searchParams.get('level') ?? '', 10);
    if (!(level >= 1)) throw new ApiError(400, 'level must be a positive integer');

    // Does this item's effective level follow the character, or does it keep
    // the level its row authors? That is `cat.effectiveLevel`'s own branch
    // (`dropsScale && (weapon || armour)`), and neither half is exported - so
    // it is MEASURED instead of restated: price a stand-in of the same itemType
    // at two character levels and see whether the answer moves. Reading the
    // branch through the function means a change to it cannot leave the picker
    // claiming one thing while the sheet computes another.
    const scalesByType = new Map();
    const typeScales = (typeId) => {
      let hit = scalesByType.get(typeId);
      if (hit === undefined) {
        const probe = { type: typeId, level: 1, iLevel: 10, rarity: null };
        hit = cat.effectiveLevel(probe, { charLevel: 50 })
          > cat.effectiveLevel(probe, { charLevel: 1 });
        scalesByType.set(typeId, hit);
      }
      return hit;
    };

    const weaponSkills = (item) => (item.skills ?? [])
      .filter((id) => {
        const t = eng.cdb.enumName('skill', 'type', skillRow(id)?.type);
        return t === 'WeaponSkill' || t === 'WeaponPassive';
      })
      .map((id) => ({ id, name: skillName(id), icon: skillIcon(id) }));

    const slots = {};
    for (const slot of cat.combatSlots()) {
      // Collapse the rolled candidate rows to one entry per ITEM; the rarity
      // spread comes back as its own array (gear: the single authored row).
      const seen = new Set();
      const out = [];
      for (const c of cat.candidates(slot.id, {
        aptitude: cls.aptitude, charLevel: level, rarityRoll: true,
      })) {
        const item = c.item;
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        const atlas = icons.atlasFor(item.id);
        const levelScales = typeScales(item.type);
        // 48 of the 261 rows a level-25 picker lists author no level at all
        // (the `*_R<Faction>_*` armour); those drop AT your level in either
        // branch, so their range collapses rather than being unknown.
        const authored = item.level ?? (item.iLevel != null ? item.iLevel / 10 : null);
        const from = authored ?? level;
        out.push({
          id: item.id,
          name: item.name,
          type: item.type,
          typeName: typeNameOf(item.type),
          hands: cat.handednessOf(item),
          allowsOffhand: cat.allowsOffhand(item),
          level: item.level,
          levelScales,
          crafted: cat.isCrafted(item.id),
          // Three kinds, not two. A CRAFTED row has one level - you make it, so
          // nothing rolls it. A row that scales tracks YOUR level. Everything
          // else is a DROP, and a drop takes the level of what dropped it: the
          // level-15 Necklace of Clarity is a level-17 item off a level-17 boar
          // (+39 Magic Penetration rather than +36, confirmed in game), so its
          // own level is the FLOOR of a band and the player says where in that
          // band their copy sits. The game caps the band by where the item can
          // drop - the greens cap at 17 - but that cap is nowhere in the data:
          // these rows appear in no lootTable at all, they are generated at
          // runtime. So the range is offered up to the character's level and
          // NOT narrowed to a number this side cannot see.
          levelRange: Number.isFinite(from)
            ? [from, cat.isCrafted(item.id) ? from : Math.max(from, level)]
            : null,
          faction: item.faction,
          aptitudes: item.aptitudes,
          gives: ratingGiven(cat, item, cls.aptitude),
          icon: item.raw?.gfx?.file ? icons.iconRef(item.raw.gfx) : null,
          rarities: cat.attainableRarities(item, level, slot.id).map((r) => ({
            id: r.rarity,
            ...(r.authored ? { authored: true } : {}),
            chance: r.chance,
            maxStars: cat.maxStars(item, r.rarity),
          })),
          skills: weaponSkills(item),
          acquire: atlas?.acquire ?? null,
          track: atlas?.track ?? [],
          flavor: item.raw?.texts?.flavorDesc ?? null,
        });
      }
      out.sort((a, b) => (b.level - a.level) || a.name.localeCompare(b.name));
      slots[slot.id] = out;
    }
    return { slots };
  }

  // --- POST /api/sheet ------------------------------------------------------

  function sheet(body) {
    if (!body?.loadout) throw new ApiError(400, 'body needs a loadout');
    const options = body.options ?? {};
    const engine = engineFor({
      targets: options.targets ?? 1,
      fight: options.fight ?? 200,
      lookahead: options.lookahead ?? 0,
    });
    let loadout;
    try {
      loadout = sanitizeLoadout(engine, body.loadout);
    } catch (e) { throw new ApiError(400, String(e.message ?? e)); }

    const bad = illegalReason(engine.cat, loadout);
    if (bad) return { illegal: bad };

    let foe;
    try {
      foe = engine.combat.foe(options.target ?? 'boss', loadout.level, options.targetLevel ?? null);
    } catch (e) { throw new ApiError(400, String(e.message ?? e)); }

    let ev;
    try {
      ev = engine.evaluate(loadout, {
        target: foe,
        rank: options.rank ?? 3,
        mix: options.mix ?? 0.5,
        goal: options.goal ?? 'dps',
        // Per-evaluation, so it stays out of the engine LRU key above: one
        // engine answers every health the client asks about.
        targetHealth: options.targetHealth ?? 1,
      });
    } catch (e) { throw new ApiError(400, String(e.message ?? e)); }

    return buildView({ engine, icons, loadout, ev, options });
  }

  // --- the weapon upgrade rider ---------------------------------------------
  // A weapon carries its `<Type>_Upgrade` skill once it has enough stars, and
  // the tooltip has to print the SAME number the sheet already applies - so
  // both the unlock and the rank come from engine.mjs's derivation rather than
  // a second rule invented here:
  //
  //   * unlock at stars >= GearUpgrades.SkillUnlockLevel (3), read from the
  //     constant (Weapon.getWeaponUpgradeSkill@8182 gates on it);
  //   * rank = the ROLLED RARITY's index, NOT stars-1 - updateInf@8174
  //     overwrites inf.rarity with the roll before the read, which is why a
  //     3-star EPIC dagger shows the rank-3 12% where stars-1 says 10%.
  //
  // Rank 5 is therefore unreachable (five rarities, indices 0..4) and so is
  // rank 0/1 (Common cannot be upgraded, Uncommon caps at two stars).
  const rarityIndex = new Map(eng.cdb.lines('rarity').map((r, i) => [r.id, i]));
  const skillUnlockLevel = (() => {
    const v = eng.cdb.constant('GearUpgrades');
    const row = v?.group?.find?.((x) => x.id === 'SkillUnlockLevel');
    return row?.v?.float ?? 3;
  })();

  function upgradeRider(item, { rarity, stars }) {
    const { cat, cdb } = eng;
    const upgradeId = cat.upgradeSkillFor(item);
    if (!upgradeId || !(stars >= skillUnlockLevel)) return null;
    const up = cdb.byId('skill').get(upgradeId);
    if (!up) return null;
    const rank = rarityIndex.get(rarity ?? item.rarity) ?? 0;

    // Vars resolve exactly as damage.mjs does it: every override whose minRank
    // the rank clears is applied in minRank order, so a later one wins.
    let vars = { ...(up.vars ?? {}) };
    for (const ov of (up.props?.rankOverride ?? []).slice()
      .sort((a, b) => (a.minRank ?? 0) - (b.minRank ?? 0))) {
      if ((ov.minRank ?? 0) <= rank) vars = { ...vars, ...(ov.vars ?? {}) };
    }

    // Eight of the twenty rows state a flat attribute affix per rank band; the
    // other twelve are scripted procs with nothing readable to list, and their
    // sentence is all the tooltip can honestly show.
    const rows = rank < 1 ? [] : (up.affixes ?? []).filter((a) => a.target?.attribute
      && !(a.conds?.minRank != null && rank < a.conds.minRank)
      && !(a.conds?.maxRank != null && rank > a.conds.maxRank)
      && !(a.conds?.equalRank != null && rank !== a.conds.equalRank));
    const affixes = rows.map((a) => ({
      attr: a.target.attribute,
      name: attrName(a.target.attribute),
      value: a.val ?? 0,
      display: `${(a.val ?? 0) > 0 ? '+' : ''}${a.val ?? 0} ${attrName(a.target.attribute)}`,
    }));

    // `::valN::` names the N-th affix that survived the rank filter, and its
    // value is ALREADY in the attribute's own units - a rank-3 GreatAxe reads
    // "Critical Chance increased by 3%" in game off an affix val of 3 - while
    // fillDesc's `::x%::` rule scales a fraction by 100, which is right for the
    // scripted rows' `::damage%::` (0.12 -> 12%) and wrong here. So the valN
    // tokens are resolved before fillDesc sees them; an index with no affix is
    // left alone and degrades to '?' like any other hole.
    const desc = fillDesc(cdb, String(up.texts?.desc ?? '')
      .replace(/::val(\d+)(%?)::/g, (whole, n, pct) => {
        const v = rows[parseInt(n, 10) - 1]?.val;
        return v == null ? whole : (pct ? `${v}%` : String(v));
      }), { own: vars, skillRow: up });

    const nm = up.texts?.name;
    return {
      name: (typeof nm === 'object' ? nm?.v : nm) ?? upgradeId,
      desc,
      affixes,
      unlockedAt: skillUnlockLevel,
      rank,
    };
  }

  // --- POST /api/tooltip/item ----------------------------------------------

  function tooltipItem(body) {
    const { cat, combat, plan, cdb } = eng;
    const item = cat.itemById.get(body?.item);
    if (!item) throw new ApiError(400, `unknown item "${body?.item}"`);
    const cls = cat.classes.find((c) => c.unit === body.class || c.aptitude === body.class)
      ?? cat.classes[0];
    const charLevel = body.charLevel ?? eng.ctx.consts.maxLevel;
    const rarity = body.rarity ?? item.rarity;
    if (rarity && !cat.rarityOrder.has(rarity)) throw new ApiError(400, `unknown rarity "${rarity}"`);
    const maxStars = cat.maxStars(item, rarity);
    const stars = Math.min(body.stars ?? 0, maxStars);
    const socketed = body.augments ?? [];

    // The bake prices at the item's full-value slot: a shield lists
    // Slot_Weapon2 first and taking slots[0] prices it at 40%.
    const bakeSlot = item.slots.find((s) => (cat.slotById.get(s)?.affixFactor ?? 1) === 1)
      ?? item.slots[0];
    const opts = {
      aptitude: cls.aptitude, charLevel, rarity, stars,
      flawless: false, level: body.level ?? null, socketed,
      armorReduction: cat.armorReductionFor(cls.aptitude),
    };
    const mods = { flat: new Map(), addRatio: new Map(), mulRatio: new Map() };
    cat.contribute(item, bakeSlot, opts, mods);
    const affixes = [...mods.flat].map(([attr, v]) => ({
      attr, name: attrName(attr), value: v,
      display: `${v > 0 ? '+' : ''}${v} ${attrName(attr)}`,
    }));

    const isWeapon = cat.isWeaponType(item.type);
    let weaponPower = null;
    let damageLine = null;
    if (isWeapon && item.aptitudes.length) {
      const wl = {
        class: cls.unit, level: charLevel,
        gear: { Slot_Weapon1: { item: item.id } },
        augments: {}, skills: {}, runes: {}, talents: {},
      };
      weaponPower = combat.weaponPowerFor(cat, wl, cls);
      // The swing line: first chain link's authored WeaponPower ratio times
      // (WP + the mean of the item's aptitude primaries at the trained
      // level), spread by WeaponAttack_RandomRange. Best effort by contract:
      // a fragile lookup omits the line, it never crashes the tooltip.
      try {
        const chain = plan.baseChain(item);
        const prof = combat.profile(chain.links[0], 1);
        const eff = (prof?.effects ?? []).find((e) => e.kind === 'Damage'
          && (e.scaling ?? []).some((s) => s.atb === 'WeaponPower'));
        const ratio = eff?.scaling.find((s) => s.atb === 'WeaponPower')?.ratio;
        if (ratio > 0) {
          const budgets = combat.attributeBudgets(charLevel);
          const prim = item.aptitudes
            .map((a) => budgets.get(combat.primaryAtbFor({ aptitude: a })))
            .filter((x) => x > 0);
          if (prim.length) {
            const mean = prim.reduce((s, x) => s + x, 0) / prim.length;
            const amount = ratio * (weaponPower + mean);
            const range = eng.ctx.consts.weaponAttackRandomRange ?? 0.1;
            damageLine = `≈${Math.round(amount * (1 - range))}–${Math.round(amount * (1 + range))} per swing`;
          }
        }
      } catch { damageLine = null; }
    }

    const rarityRow = cdb.byId('rarity').get(rarity);
    const atlas = icons.atlasFor(item.id);
    const slotLabelOf = (slotId) => {
      const t = itemTypeRow(slotId)?.texts;
      return (typeof t?.name === 'object' ? t.name.v : t?.name) ?? t?.slotName
        ?? (slotId ? slotId.replace(/^Slot_/, '') : null);
    };
    return {
      name: item.name,
      rarityId: rarity,
      rarityName: rarityRow?.name ?? rarity,
      color: toHex(rarityRow?.color),
      typeName: typeNameOf(item.type),
      slotLabel: slotLabelOf(body.slot ?? item.slots[0]),
      iLevel: Math.round(10 * cat.effectiveLevel(item, {
        charLevel, stars, rarity, level: body.level ?? null, socketed,
      })),
      stars,
      maxStars,
      damageLine,
      weaponPower,
      affixes,
      // Best effort by contract, like damageLine: a shape the derivation does
      // not recognise costs the rider line, never the tooltip.
      upgrade: (() => {
        try { return upgradeRider(item, { rarity, stars }); } catch { return null; }
      })(),
      gives: ratingGiven(cat, item, cls.aptitude, rarity),
      skills: isWeapon ? (item.skills ?? [])
        .filter((id) => {
          const t = cdb.enumName('skill', 'type', skillRow(id)?.type);
          return t === 'WeaponSkill' || t === 'WeaponPassive';
        })
        .map((id) => ({ name: skillName(id), icon: skillIcon(id) })) : [],
      flavor: item.raw?.texts?.flavorDesc ?? null,
      acquire: atlas?.acquire ?? null,
      track: atlas?.track ?? [],
      faction: item.faction ?? null,
    };
  }

  // --- POST /api/tooltip/skill ---------------------------------------------

  // The resting sheet a priced tooltip reads, memoised on the build. A hover
  // must not cost a fight: `evaluate` plays out `options.fight` seconds, and
  // the tooltip only wants the character sheet out of it, which does not move
  // while the user hovers along a skill bar.
  const sheetCache = new Map();
  function restingSheet(engine, loadout, options) {
    // targetHealth is in the key even though the RESTING sheet is stats and
    // stats do not move with it - a memo whose key omits an argument of the
    // call it memoises is one refactor away from being wrong, and this entry
    // already carries `mixIds` off the same evaluation.
    const key = JSON.stringify([engine.opts.fight, engine.opts.targets,
      options.target ?? 'boss', options.targetLevel ?? null,
      options.rank ?? null, options.mix ?? null, options.goal ?? null,
      options.targetHealth ?? 1, loadout]);
    const hit = sheetCache.get(key);
    if (hit) { sheetCache.delete(key); sheetCache.set(key, hit); return hit; }
    const foe = engine.combat.foe(options.target ?? 'boss', loadout.level,
      options.targetLevel ?? null);
    const rank = options.rank ?? eng.ctx.consts.weaponSkillMaxRank;
    const sheet = engine.evaluate(loadout, {
      target: foe, rank, mix: options.mix ?? 0.5, goal: options.goal ?? 'dps',
      targetHealth: options.targetHealth ?? 1,
    }).sheet;
    // Which of this build's casts and ticks are the WEAPON's, derived exactly
    // as engine.mjs derives `weaponMix.ids` and `tickScaling.mixIds` - off the
    // rotation, by the slot each one came from, with a shield excluded because
    // its type chain never reaches MainhandWeapon.
    const mixIds = new Set();
    try {
      const WEAPON_SLOTS = ['Slot_Weapon1', 'Slot_Weapon2', 'Slot_OffhandWeapon'];
      const rot = engine.plan.resolve(loadout, rank);
      const at = { rank, runes: new Set(rot.runes ?? []) };
      const fromWeapon = (slot) => typeof slot === 'string' && WEAPON_SLOTS.includes(slot)
        && engine.cat.itemById.get(loadout.gear[slot]?.item)?.type
        && engine.cat.itemById.get(loadout.gear[slot].item).type !== 'Shield';
      // Every skill the equipped weapons grant, which is what makes a proc or
      // a mark "the weapon's" rather than a talent's.
      const weaponSkills = new Set(WEAPON_SLOTS
        .map((slot) => loadout.gear[slot]?.item && engine.cat.itemById.get(loadout.gear[slot].item))
        .filter(Boolean).flatMap((it) => it.skills ?? []));
      for (const x of rot.filler ?? []) mixIds.add(x.prof.id);
      for (const x of rot.active ?? []) if (fromWeapon(x.source)) mixIds.add(x.prof.id);
      for (const d of rot.dots ?? []) if (fromWeapon(d.source)) mixIds.add(d.status);
      for (const sp of engine.plan.stackProcsOf(engine.talents.runableSkillIds(loadout), at)) {
        if (weaponSkills.has(sp.from)) mixIds.add(sp.skill);
      }
      for (const mp of engine.plan.markProcsOf(
        [...(rot.active ?? []), ...(rot.filler ?? [])].map((x) => x.prof.id), at)) {
        if ((mp.appliers ?? []).some((a) => weaponSkills.has(a))) mixIds.add(mp.status);
      }
    } catch { /* a rotation this reader cannot resolve just loses the nicety */ }
    const entry = { sheet, mixIds };
    sheetCache.set(key, entry);
    if (sheetCache.size > 16) sheetCache.delete(sheetCache.keys().next().value);
    return entry;
  }

  function tooltipSkill(body) {
    const row = skillRow(body?.skill);
    if (!row) throw new ApiError(400, `unknown skill "${body?.skill}"`);
    const options = body.options ?? {};
    // A LOADOUT PRICES THE SENTENCE. Damage is not a stored var - it is the
    // skill's steps read against the character - so `dealing ::dmg::` has no
    // answer at all in a vacuum. With a build the magnitudes are the ones the
    // game's own tooltip prints; without one they degrade to the authored
    // coefficient ("150% Strength"), never silently to a wrong number.
    let engine = eng;
    let loadout = null;
    let sheet = null;
    let mixIds = null;
    if (body.loadout) {
      engine = engineFor({
        targets: options.targets ?? 1,
        fight: options.fight ?? 200,
        lookahead: options.lookahead ?? 0,
      });
      try {
        loadout = sanitizeLoadout(engine, body.loadout);
      } catch (e) { throw new ApiError(400, String(e.message ?? e)); }
      const bad = illegalReason(engine.cat, loadout);
      if (bad) return { illegal: bad };
      // The RESTING sheet, which is what the game shows you standing still and
      // therefore what its tooltip reads - not the fight-averaged one.
      try {
        const got = restingSheet(engine, loadout, options);
        sheet = got.sheet;
        mixIds = got.mixIds;
      } catch (e) { throw new ApiError(400, String(e.message ?? e)); }
    }
    // The same default the sheet uses (options.rank ?? 3 = WeaponSkill_MaxRank):
    // mastery is assumed trained out, so a tooltip that omits the rank must not
    // quietly describe a weaker skill than the one being simulated.
    const rank = body.rank ?? options.rank ?? eng.ctx.consts.weaponSkillMaxRank;
    // A slotted rune changes both the props and the damage, so the build's own
    // choice is the default when the caller does not name one.
    const runes = new Set(body.runes
      ?? (loadout?.runes?.[row.id] ? [loadout.runes[row.id]] : []));
    // The rune-overridden props ride the profile; raw row numbers are the
    // fallback for rows the profiler does not know. Both are re-read per rank,
    // because a rank is exactly what selects between the props.rankOverride
    // entries - and they are kept APART, because `cooldown`, `charges` and
    // `duration` are columns the game reads separately from `vars`. Three rows
    // in this build author a `vars.cooldown` that has to beat the column
    // (`Spear_Eruption_Skill2` at rank 2), and folding the two together prints
    // a bare "15" where the game prints "12s" on every other row.
    const ownAt = (r) => ({
      ...(row.vars ?? {}),
      ...(engine.combat.profile(row.id, r, runes)?.vars ?? {}),
    });
    const infAt = (r) => (x) => {
      const p = engine.combat.profile(x.id, r, runes);
      return p
        ? { cooldown: p.cooldown, charges: p.charges, duration: p.duration }
        : { cooldown: x.cooldown, charges: x.props?.charges, duration: x.duration };
    };
    const prof = engine.combat.profile(row.id, rank, runes);
    // Each rank line is priced AT ITS OWN RANK: the rank moves the scaling
    // conditions and a referenced status's `props.rankOverride` as well as the
    // vars, so rank 3's sentence has to read rank 3's steps.
    const notes = [];
    const fill = (text, r) => fillDesc(engine.cdb, text, {
      own: ownAt(r), skillRow: row, rank: r, runes,
      varsFor: (x) => engine.combat.profile(x.id, r, runes)?.vars ?? x.vars ?? {},
      infFor: infAt(r),
      price: sheet
        ? createPricer(engine, { loadout, sheet, rank: r, mixIds })
        : createCoefficientPricer(engine, { rank: r }),
      notes,
    });

    // `texts.rankDescs` is the mastery ladder, and it is ALWAYS two entries on
    // the 128 rows that carry one: the base `texts.desc` is rank 1, so
    // rankDescs[0] is rank 2 and rankDescs[1] is rank 3 (WeaponSkill_MaxRank).
    // The data settles the offset rather than the naming: Daggers_Start_Skill1
    // only overrides var1 at minRank 3 and rankDescs[1] is the line that reads
    // it ("Now deals ::dmg:: ::var1:: times"), Staff_Censer_Skill1 only
    // overrides dur1 at minRank 2 and rankDescs[0] is the line that reads it.
    // Each line is filled AT ITS OWN RANK, so the ladder shows what changes.
    //
    // `flags` is the one-bit `HiddenWhenMerged` enum - set on the lines that
    // merely restate a number the base sentence already carries (the base desc
    // is re-filled at the live rank, so printing both says it twice).
    const ranks = [{
      rank: 1,
      desc: fill(row.texts?.desc, 1),
      active: rank >= 1,
      hiddenWhenMerged: false,
    }];
    for (const [i, rd] of (row.texts?.rankDescs ?? []).entries()) {
      const r = i + 2;
      ranks.push({
        rank: r,
        desc: fill(rd?.desc, r),
        active: rank >= r,
        hiddenWhenMerged: !!((rd?.flags ?? 0) & 1),
      });
    }

    // What could not be resolved, deduplicated by token. The UI can style
    // these rather than leave the reader guessing what a bare '?' meant, and
    // an empty list is the claim that every number in the sentence is real.
    const seen = new Set();
    const unresolved = notes.filter((n) => !seen.has(n.token) && seen.add(n.token));

    return {
      name: row.texts?.name ?? row.id,
      icon: skillIcon(row.id),
      desc: fill(row.texts?.desc, rank),
      cooldown: prof?.cooldown ?? row.cooldown ?? 0,
      charges: (prof?.charges ?? 1) > 1 ? prof.charges : null,
      nature: eng.cdb.enumName('skill', 'nature', row.nature) ?? null,
      rank,
      ranks,
      // `true` when the magnitudes are real numbers against the loadout that
      // was sent; `false` when they are the authored coefficients because no
      // loadout was.
      priced: !!sheet,
      rune: runes.size ? [...runes][0] : null,
      unresolved,
    };
  }

  // --- the optimizer: child process + SSE relay -----------------------------

  const jobs = new Map();
  let jobSeq = 0;
  let runningJob = null;

  function killJob(job, reason) {
    if (!job || job.done) return;
    job.done = true;
    try { job.proc.kill(); } catch { /* already gone */ }
    pushEvent(job, 'error', { error: reason });
  }

  function pushEvent(job, event, data) {
    const entry = { event, data };
    job.events.push(entry);
    if (event === 'done' || event === 'error') job.done = true;
    for (const res of job.subscribers) writeEvent(res, entry);
  }

  function writeEvent(res, { event, data }) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function optimizeStart(body) {
    if (!body?.loadout) throw new ApiError(400, 'body needs a loadout');
    // One search at a time: a second start supersedes the first.
    if (runningJob && !runningJob.done) killJob(runningJob, 'superseded by a new optimize');

    const id = 'j' + (++jobSeq);
    // process.execPath is node in dev and the Electron binary in the packaged
    // app; ELECTRON_RUN_AS_NODE makes the latter behave as plain node.
    const proc = spawn(process.execPath, [join(benchRoot, 'ui', 'optimize-worker.mjs')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      },
    });
    const job = {
      id, proc, t0: Date.now(),
      events: [], subscribers: new Set(), done: false, stderr: '',
    };
    jobs.set(id, job);
    runningJob = job;

    proc.stdin.on('error', () => { /* worker died before reading the spec */ });
    proc.stdin.end(JSON.stringify({
      benchRoot, game,
      loadout: body.loadout,
      pins: body.pins ?? {},
      options: { ...(body.options ?? {}), version },
    }) + '\n');

    let buf = '';
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === 'progress') {
          pushEvent(job, 'progress', {
            evals: msg.evals, elapsed: (Date.now() - job.t0) / 1000,
          });
        } else if (msg.type === 'done') {
          pushEvent(job, 'done', {
            envelope: msg.envelope, view: msg.view,
            score: msg.score, elapsed: msg.elapsed,
          });
        } else if (msg.type === 'error') {
          pushEvent(job, 'error', { error: msg.error });
        }
      }
    });
    proc.stderr.on('data', (c) => { job.stderr = (job.stderr + c).slice(-4000); });
    proc.on('exit', (code) => {
      if (!job.done) {
        pushEvent(job, 'error', {
          error: `optimize worker exited with code ${code}`
            + (job.stderr ? `: ${job.stderr.trim().split('\n').pop()}` : ''),
        });
      }
      if (runningJob === job) runningJob = null;
    });
    return { job: id };
  }

  function optimizeEvents(req, res, searchParams) {
    const job = jobs.get(searchParams.get('job'));
    if (!job) throw new ApiError(400, 'no such job');
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    for (const e of job.events) writeEvent(res, e);
    if (job.done) { res.end(); return; }
    job.subscribers.add(res);
    const hb = setInterval(() => res.write(': hb\n\n'), 15000);
    res.on('close', () => {
      clearInterval(hb);
      job.subscribers.delete(res);
      // The stream is the job's owner: the client walking away cancels the
      // search unless someone else is still watching.
      if (!job.done && job.subscribers.size === 0) killJob(job, 'client closed the event stream');
    });
  }

  function optimizeCancel(body) {
    const job = jobs.get(body?.job);
    if (!job) throw new ApiError(400, 'no such job');
    killJob(job, 'cancelled');
    return { ok: true };
  }

  // --- dispatch -------------------------------------------------------------

  function handle(req, res, pathname, searchParams, body) {
    if (!pathname.startsWith('/api/')) return false;
    const json = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    try {
      switch (pathname) {
        case '/api/bootstrap': json(200, bootstrap()); return true;
        case '/api/catalog': json(200, catalog(searchParams)); return true;
        case '/api/sheet': json(200, sheet(body)); return true;
        case '/api/tooltip/item': json(200, tooltipItem(body)); return true;
        case '/api/tooltip/skill': json(200, tooltipSkill(body)); return true;
        case '/api/optimize/start': json(200, optimizeStart(body)); return true;
        case '/api/optimize/events': optimizeEvents(req, res, searchParams); return true;
        case '/api/optimize/cancel': json(200, optimizeCancel(body)); return true;
        default: json(404, { error: `no such endpoint ${pathname}` }); return true;
      }
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 500;
      json(status, { error: String(e?.message ?? e) });
      return true;
    }
  }

  function close() {
    for (const job of jobs.values()) {
      if (!job.done) killJob(job, 'server closing');
    }
    icons.close?.();
  }

  return { handle, close, icons };
}
