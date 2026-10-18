// ---------------------------------------------------------------------------
// format.mjs - printing. Plain text, fixed columns, no colour by default.
//
// The rule every function here follows: never show a number without what it
// was computed against. A score with no target, no rotation and no assumption
// list is exactly the kind of confident-looking output that gets a tool
// distrusted the first time somebody checks it.
// ---------------------------------------------------------------------------

import { fileURLToPath } from 'node:url';
import { acceptedBuild } from './drift.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const useColour = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColour ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const dim = (s) => c('2', s);
export const bold = (s) => c('1', s);
export const warn = (s) => c('33', s);

export function table(headers, rows, { align = [] } = {}) {
  const all = [headers, ...rows].map((r) => r.map((x) => (x == null ? '' : String(x))));
  const w = headers.map((_, i) => Math.max(...all.map((r) => (r[i] ?? '').length)));
  const line = (r, hdr) => r.map((x, i) => {
    const s = x ?? '';
    const padded = align[i] === 'r' ? s.padStart(w[i]) : s.padEnd(w[i]);
    return hdr ? bold(padded) : padded;
  }).join('  ').trimEnd();
  return [line(all[0], true), ...all.slice(1).map((r) => line(r, false))].join('\n');
}

export function num(v, digits = 0) {
  if (v == null || Number.isNaN(v)) return '-';
  return v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function pct(v, digits = 1) {
  if (v == null || Number.isNaN(v)) return '-';
  return (v * 100).toFixed(digits) + '%';
}

export function signedPct(v, digits = 2) {
  if (v == null || Number.isNaN(v)) return '-';
  const s = (v * 100).toFixed(digits) + '%';
  return v > 0 ? '+' + s : s;
}

export function header(engine, version) {
  const m = engine.meta;
  const lines = [
    `${bold('farever-bench')} ${version}`,
    dim(`cdb ${m.cdbSha.slice(0, 8)}  boot ${m.bootSha ? m.bootSha.slice(0, 8) : '(absent)'}  game ${m.game}`),
  ];
  // A number computed on a build the model was not accepted on says so, on
  // every command, before the number.
  const acc = acceptedBuild(REPO_ROOT, m);
  if (acc && !acc.same) {
    lines.push(warn(`this install is not the build the model was accepted on (${String(acc.at).slice(0, 10)}) - run bench update`));
  }
  return lines.join('\n');
}

// The attributes worth showing. The sheet has 80 rows; these are the ones a
// gearing decision turns on, in a deliberate order rather than sheet order.
// `AllAttributes` is deliberately not among them: nothing grants it, a skill
// that scales on it reads the mean of the four main attributes instead (see
// `scalingValue` in damage.mjs), so its sheet value is always 0.
const SHEET_ORDER = [
  ['Primary', ['Strength', 'Dexterity', 'Intellect', 'Faith', 'Vitality']],
  ['Offence', ['WeaponPower', 'CritChanceRating', 'CritChance', 'CritDamage',
    'ArmorPenetrationRating', 'ArmorPenetration', 'SpellPenetrationRating', 'SpellPenetration',
    'FervorRating', 'Fervor', 'PhysicalMastery', 'MagicMastery', 'DamageModifier']],
  ['Defence', ['MaxHealth', 'Armor', 'MagicArmor', 'Resilience', 'MagicReduction',
    'BlockMitigation', 'DodgeChance', 'DamageTakenModifier', 'HealthRegen']],
  ['Support', ['HealGivenMultiplier', 'ShieldPowerMultiplier', 'CooldownReduction']],
];

/**
 * What stats a run was computed against, when they came from a profile rather
 * than from gear. A number with no gear behind it needs the corner printed
 * beside it or it is not comparable to anything.
 */
export function profileBlock(profile) {
  const pinned = [...profile.force]
    .map(([atb, v]) => (atb === profile.peakAtb ? bold(`${atb} ${v}`) : `${atb} ${v}`))
    .join('   ');
  const lines = [
    bold(`profile: ${profile.label}`) + dim(`  - ${profile.desc}`),
    dim('  pinned: ') + pinned,
  ];
  for (const n of profile.notes) lines.push(dim('  ! ' + n));
  return lines.join('\n');
}

export function sheetBlock(engine, ev, { level }) {
  const { attrTable, consts } = engine.ctx;
  const out = [];
  for (const [group, ids] of SHEET_ORDER) {
    const rows = [];
    for (const id of ids) {
      const a = attrTable.byId.get(id);
      if (!a) continue;
      const v = ev.sheet.get(id) ?? 0;
      if (!v && !a.isPercent) continue;
      let note = '';
      if (a.isRating) {
        // What this rating is currently buying, and what one more point buys.
        // The denominator is the level budget, so the marginal value is
        // constant at a fixed level and falls ~3.8% per level gained.
        const consumer = attrTable.attrs.find((x) => x.scaling.some((s) => s.from === id && s.op.case === 'Rating'));
        if (consumer) {
          const s = consumer.scaling.find((x) => x.from === id);
          const { min, max, target } = s.op.args;
          const step = min * Math.pow(Math.pow(max / min, 1 / (consts.earlyMaxLevel - 1)), level - 1);
          note = `-> ${consumer.id} ${((v / step) * target).toFixed(2)}pp   +1 = +${((target / step)).toFixed(4)}pp`;
        }
      }
      rows.push([id, num(v, a.isPercent || id === 'WeaponPower' ? 2 : 0), dim(note)]);
    }
    if (rows.length) {
      out.push(bold(group));
      out.push(table(['  attribute', 'value', ''], rows.map((r) => ['  ' + r[0], r[1], r[2]]), { align: [null, 'r'] }));
      out.push('');
    }
  }
  return out.join('\n');
}

export function gearBlock(engine, loadout, { pinnedGear = new Set(), indifferent = new Set() } = {}) {
  const { cat } = engine;
  const cls = cat.classes.find((x) => x.unit === loadout.class);
  const rows = [];
  // The INFUSION column exists only for a build that wears something an
  // infusion can sit on, so a naked weapon comparison prints as it always did.
  const showInfusion = cat.combatSlots().some((s) => {
    const g = loadout.gear[s.id];
    const it = g?.item ? cat.itemById.get(g.item) : null;
    return !!it && (!!g.infusion || cat.canInfuse(it));
  });
  const infusionCell = (slot, g, it, opts) => {
    if (!g.infusion) return cat.canInfuse(it) ? dim('-') : '';
    const name = cat.infusions.get(g.infusion)?.name ?? g.infusion;
    const tag = g.prismatic ? ' ' + warn('prismatic') : '';
    if (!g.infusionStat) return name + tag;
    const stat = g.infusionStat.replace(/Rating$/, '');
    const socketed = cat.socketsFor(it).map((t) => loadout.augments?.[`${slot.id}/${t}`]).filter(Boolean);
    const v = cat.infusionBonus(it, g.infusionStat, { ...opts, socketed });
    return cat.infusionBonusActive(it, g)
      ? `${name}${tag}  +${v} ${stat}`
      : `${name}${tag}  ` + dim(`(+${v} ${stat}, dark)`);
  };
  for (const slot of cat.combatSlots()) {
    const g = loadout.gear[slot.id];
    if (!g?.item) {
      rows.push([short(slot.id), dim('(empty)'), '', '', '', '', ...(showInfusion ? [''] : []), pinnedGear.has(slot.id) ? 'pinned' : '']);
      continue;
    }
    const it = cat.itemById.get(g.item);
    // A rarity of its own is a WEAPON's; anything else is its row's, whatever
    // a build file says (see catalog.instanceRarity).
    const rarity = cat.instanceRarity(it, g);
    // The SAME arithmetic the stats were computed with, or the table contradicts
    // the sheet beside it: loadout.mjs clamps the stars to what the item can
    // actually take and honours the instance level, and printing the unclamped
    // request showed three stars and 30 iLevel that no stat ever got.
    const stars = Math.min(g.stars ?? 0, cat.maxStars(it, rarity));
    const eff = cat.effectiveLevel(it, {
      charLevel: loadout.level, stars, flawless: !!g.flawless, rarity, level: g.level ?? null,
    });
    const rolled = rarity !== it.rarity;
    // Which generic this instance actually PAYS, not which one was asked for.
    const paid = cat.payingAptitudes(it, cls.aptitude, g.generic).find((a) => cat.isGeneric(a)) ?? null;
    rows.push([
      short(slot.id),
      it.name === it.id ? it.id : `${it.name}`,
      rolled ? warn(rarity) : rarity,
      stars ? '*'.repeat(stars) : '',
      num(eff * 10),
      // Craft jewellery lists several alternative aptitudes; only one of them
      // is what you actually looted, so name which one this row assumes.
      it.faction ?? (paid ? warn(paid) : dim('-')),
      ratingGiven(cat, it, cls.aptitude, rarity, g.generic) ?? dim('-'),
      ...(showInfusion ? [infusionCell(slot, g, it, {
        charLevel: loadout.level, stars, flawless: !!g.flawless, rarity, level: g.level ?? null,
      })] : []),
      pinnedGear.has(slot.id) ? bold('pinned')
        : indifferent.has(slot.id) ? warn('no effect')
        : (rolled ? dim('rolled') : ''),
    ]);
  }
  return table(['SLOT', 'ITEM', 'RAR', 'UPG', 'iLVL', 'FACTION', 'GIVES', ...(showInfusion ? ['INFUSION'] : []), ''],
    rows, { align: [null, null, null, null, 'r'] });
}

/**
 * The infusion sets a build wears: per set the pieces, the rank that count
 * reaches, what of it is in the number and what is not; then the bonus lines,
 * and - after a search - what the search was allowed to hand out.
 *
 * @param ev      an evaluation (its `infusions` is what the engine attached)
 * @param search  optimize()'s `infusion` descriptor, when a search ran
 */
export function infusionBlock(engine, loadout, ev, { search = null, verbose = false } = {}) {
  const { cat } = engine;
  if (!cat.infusions.size) return null;
  const inf = ev?.infusions ?? { sets: [], pieces: [] };
  const can = cat.combatSlots().filter((s) => {
    const g = loadout.gear[s.id];
    return g?.item && cat.canInfuse(cat.itemById.get(g.item));
  }).length;
  const caps = cat.infusionCaps;
  const out = [];
  if (!inf.sets.length) {
    out.push(dim(can
      ? `  (no piece is infused - ${can} of the pieces worn can be; a set pays at ${caps.join(' / ')} pieces of one infusion)`
      : `  (nothing worn can be infused - only ${cat.infusionMinRarity} armour with a faction can)`));
  } else {
    // SCORED is the stat rows and what the set does in the fight, each in a
    // few words on a line of its own (a set that fights says more than a cell
    // holds); what each part came to in THIS fight follows it.
    out.push(table(['  SET', 'PIECES', 'RANK', 'SCORED'], inf.sets.flatMap((s) => {
      const said = s.priced.length ? s.priced : [dim(s.attached ? 'nothing at this rank' : '-')];
      return said.map((text, i) => (i === 0
        ? ['  ' + s.name, String(s.pieces), s.attached ? `${s.rank}  ${s.title}` : dim(`-  (${s.nextCap} for the first)`), text]
        : ['', '', '', text]));
    }), { align: [null, 'r'] }));
    for (const s of inf.sets.filter((x) => (x.fought ?? []).length)) {
      out.push(dim(`  ${s.name} in this fight: ${s.fought.join('; ')}`));
    }
    const unscored = inf.sets.filter((s) => s.unpriced.length);
    if (unscored.length) {
      out.push(warn(`  ${unscored.length} set${unscored.length === 1 ? ' has' : 's have'} an effect that is not scored`)
        + (verbose ? ':' : dim(' - what is listed above is what each is worth here; --verbose for what is left out and why')));
      if (verbose) {
        for (const s of unscored) out.push(dim(`    ${s.name}: ${s.unpriced.join('; ')}${s.why ? ' - ' + s.why : ''}`));
      }
    }
  }
  // The bonus lines: what is lit, what is dark, and what nobody stated.
  const lit = inf.pieces.filter((p) => p.lit && p.value);
  const dark = inf.pieces.filter((p) => p.infusion && p.stat && !p.lit);
  const blind = inf.pieces.filter((p) => p.infusion && !p.stat);
  if (lit.length || dark.length || blind.length) {
    const bits = [];
    if (lit.length) bits.push(`${lit.length} lit bonus line${lit.length === 1 ? ' pays' : 's pay'} ${lit.reduce((n, p) => n + p.value, 0)} rating`);
    if (dark.length) bits.push(`${dark.length} dark (the infusion is another faction's and the piece is not Prismatic)`);
    if (blind.length) {
      const low = blind.reduce((n, p) => n + p.ceiling, 0);
      bits.push(`${blind.length} with no roll stated, priced at 0`
        + (low > 0 ? ` (up to ${low} rating if the faction-matched ones are lit)` : ''));
    }
    out.push(dim('  bonus stat: ' + bits.join('; ')));
  }
  if (search) {
    out.push(dim(`  searched: ${search.offered.length} of ${cat.infusions.size} infusions`
      + (search.statPolicy === 'none' ? '; an unowned piece\'s bonus roll is priced at 0 (--infusion-stat best|<rating> to ask)'
        : `; an unowned faction-matched piece is taken to have rolled ${search.statPolicy === 'best' ? 'its best rating' : search.statPolicy}`)));
    for (const w of search.withheld ?? []) {
      out.push(dim(`  withheld: ${cat.infusions.get(w.id)?.name ?? w.id} - ${w.why}`));
    }
    if ((search.withheld ?? []).length) out.push(dim('  (--infusions all offers them anyway)'));
    if (!search.offered.length) out.push(dim('  (no infusion was offered to the search)'));
  }
  return out.join('\n');
}

// Which secondary rating this piece pays out for this class - the cross of the
// item's faction with the WEARER's own atbScaling conditions. One aptitude
// pays, so a Kobold Assassin+Cleric spear reads as ArmorPen on a Rogue and as
// Crit on a Priest, not as both on either. `generic` names which of a craft
// jewel's several nameless aptitudes this instance rolled.
export function ratingGiven(cat, item, aptitude, rarity = null, generic = null) {
  const rar = rarity ?? item.rarity;
  const aptitudes = cat.cdb.byId('aptitude');
  const found = [];
  for (const aptId of cat.payingAptitudes(item, aptitude, generic)) {
    for (const e of aptitudes.get(aptId)?.atbScaling ?? []) {
      if ((e.statGroup ?? 0) !== 3) continue;
      const cd = e.conds ?? {};
      if (cd.minRarity != null && (cat.rarityOrder.get(rar) ?? -1) < (cat.rarityOrder.get(cd.minRarity) ?? 0)) continue;
      if ((cd.factions ?? []).length && !cd.factions.some((x) => x.ref === item.faction)) continue;
      const name = e.endAtb.replace('Rating', '');
      if (!found.includes(name)) found.push(name);
    }
  }
  return found.length ? found.join('+') : null;
}

export function augmentBlock(engine, loadout, { pinnedAug = new Set() } = {}) {
  const { cat } = engine;
  const socks = engine.socketsOf(loadout);
  if (!socks.length) return dim('(no augment sockets - nothing equipped that hosts one)');
  const rows = [];
  for (const s of socks) {
    const id = loadout.augments[s.key];
    const aug = id ? cat.itemById.get(id) : null;
    let label = dim('(none)');
    let effect = '';
    if (aug) {
      label = aug.name === aug.id ? aug.id : aug.name;
      effect = affixSummary(aug.affixes);
      if (s.type === 'AugmentDemonSigil') {
        // A sigil is a free tier-4 talent, and most of those talents declare no
        // affix, no effect and no status - so the objective cannot tell one
        // from another and the socket stayed empty until the search learnt to
        // prefer any sigil over none. Say which of those two this is.
        // ...and say WHICH talent, and the per-variant truth. The Warrior's
        // three variants are not one case: Infused Wound is fully readable
        // (35% of magic crits as a bleed - worth zero on an all-physical
        // build, which the score already said by tying), Surge of Violence is
        // a next-cast register the fight does not carry, and Second Wind is
        // not a tree node at all.
        const tree = engine.talents.treeFor(loadout.class);
        const granted = (aug.skills ?? []).filter((sk) => tree.byId.has(sk));
        const nonTree = (aug.skills ?? []).filter((sk) => !tree.byId.has(sk));
        if (granted.length) {
          effect = granted.map((sk) => {
            const rv = engine.talents.readableValue(sk, 1);
            const name = tree.byId.get(sk).name;
            if (rv.readable) return dim(`grants ${name} - ${rv.kind}`);
            // `readableValue` looks for an affix, an effect or a status. A node
            // whose whole payload is a MECHANIC has none of those and is still
            // scored - Surge of Violence arms a next-cast register - so asking
            // that one function alone printed "nothing this model can read"
            // beside a talent the fight was already playing.
            if (engine.plan.empowermentIds(1).has(sk)) {
              return dim(`grants ${name} - ${engine.plan.empowermentLabel(sk) ?? 'a next-cast register'}`);
            }
            return warn(`grants ${name} - nothing this model can read; taken because free beats empty`);
          }).join(', ');
        } else if (nonTree.length) {
          effect = dim(`grants ${nonTree.join(', ')} - a skill, not a tree node`);
        } else {
          effect = warn('a free tier-4 talent this model cannot score - taken because free beats empty');
        }
      }
    } else {
      // An empty socket has two very different meanings, and conflating them is
      // how a tool misleads: "nothing here beats nothing" versus "I cannot put a
      // number on any of these". Say which.
      // An augment is scoreable if it carries a stat affix, or if a skill it
      // grants resolves to a self-buff status - which is exactly how a weapon
      // enchant comes to be worth anything.
      const options = cat.augmentCandidates(s.type);
      const scoreable = options.filter((o) => (o.affixes ?? []).some((a) => a.target?.attribute)
        || (o.skills ?? []).some((sk) => engine.plan.selfBuffsOf(sk).length));
      if (options.length && !scoreable.length) {
        label = warn('(none - not scoreable)');
        effect = dim(`all ${options.length} options grant a skill or talent, which this model does not score`);
      }
    }
    rows.push([
      short(s.slot),
      s.type.replace(/^Augment/, ''),
      label,
      effect,
      pinnedAug.has(s.key) ? bold('pinned') : '',
    ]);
  }
  return table(['SLOT', 'SOCKET', 'AUGMENT', 'EFFECT', ''], rows);
}

// A ratio affix is a fraction, not a flat amount. Crusaders Resolve is
// TAttribute_ARatio 0.08 Armor - eight percent - and printing "+0.08 Armor"
// makes a real bonus look like a rounding error.
export function affixSummary(affixes) {
  const parts = [];
  for (const a of affixes ?? []) {
    const atb = a.target?.attribute;
    if (!atb) continue;
    const v = a.val ?? 0;
    const name = atb.replace("Rating", "Rtg");
    if (a.ref === "TAttribute_ARatio" || a.ref === "TAttribute_MRatio" || a.ref === "TAttribute_MRatioMin") {
      parts.push(`${v > 0 ? "+" : ""}${(v * 100).toFixed(v * 100 % 1 ? 1 : 0)}% ${name}`);
    } else {
      parts.push(`${v > 0 ? "+" : ""}${v} ${name}`);
    }
  }
  return parts.join(" ");
}


// Which of the skills on offer this build actually slotted. A weapon hands you
// three and you keep two, so this block is as much a part of the answer as the
// gear table is.
export function skillsBlock(engine, loadout, ev, { pinnedSkills = new Set(), verbose = true } = {}) {
  const pools = engine.plan.pools(loadout);
  if (!pools.length) return dim('(nothing equipped that offers a skill choice)');
  const skills = engine.cdb.byId('skill');
  const name = (id) => skills.get(id)?.texts?.name ?? id;
  const rows = [];
  for (const p of pools) {
    const chosen = loadout.skills?.[p.key] ?? p.options.slice(0, p.slots);
    const dropped = p.options.filter((id) => !chosen.includes(id));
    // A pool that may slot the same option twice is counted against its SLOTS,
    // not its option list: a Mage filling three conduit slots from two conduits
    // is full, and "3/2" reads like an overflow rather than a finished bar.
    const denom = p.repeats ? p.slots : p.options.length;
    rows.push([
      p.label,
      `${chosen.length}/${denom}`,
      chosen.map((id) => bold(name(id))).join(', '),
      // A main-hand passive is granted rather than chosen, so it is not in the
      // pool - but leaving it off the line makes a three-skill weapon read
      // "2/2" and look like the model lost one.
      [dropped.length ? 'not taken: ' + dropped.map(name).join(', ') : '',
        (p.alsoGranted ?? []).length ? 'always on: ' + p.alsoGranted.map(name).join(', ') : '',
      ].filter(Boolean).map(dim).join('   '),
      pinnedSkills.has(p.key) ? bold('pinned') : '',
    ]);
  }
  const out = [table(['POOL', 'SLOTS', 'TAKEN', '', ''], rows)];

  // Anything real that the model knows it is not scoring, named - and grouped
  // by WHY, because "contributes zero" is true of a teleport and of missing
  // damage alike and useful about neither. A reader needs to know which of
  // these is a gap and which is the right answer.
  const un = ev?.throughput?.unmodelled ?? [];
  if (un.length) {
    const KINDS = [
      // NOT "so zero is correct". A rune turns a teleport into a resource
      // generator or a damage amplifier, and the search picks the rune - so the
      // claim is only ever about the build in front of you.
      ['utility', 'movement only, with the rune you slotted - nothing here to score'],
      ['rune', 'there is a rune choice here this model cannot rank - the options are below'],
      ['resource', 'gated by a pool nothing in this build declares readable income for'],
      ['no rate', 'the amount is in the data; nothing says how often it lands'],
      // The guard reader looked at the script and REFUSED, which is a different
      // statement from never having looked.
      ['conditional', 'it procs, but only while something this reader cannot evaluate holds'],
      ['buff refused', 'the skill is scored, but a status it grants is gated on live state this reader cannot evaluate'],
      ['gated off', 'its script gates it on a rank or a talent this build does not have'],
      // NOT a gap, and it is here precisely because it is not: read, answered,
      // and correctly zero for the fight you described. Same species as the
      // crowd-control line below - the input decides it, so the input is named.
      ['off at this target health', 'read and correctly worth zero at the health you stated - --target-health moves it'],
      // Sibling of the health line: an owner-wide rider that is read and
      // worth nothing against a target immune to crowd control.
      ['off against this target', 'read and correctly worth zero against this target - a stunnable one moves it'],
      // ...and the same for a clause that asks how many enemies a cast hit.
      ['off at this target count', 'read and correctly worth zero at the number of targets you stated - --targets moves it'],
      // ...and the third of the family: read, and zero because of what the
      // BUILD holds - a rider with no crowd control to ride, a register
      // nothing arms, a clause behind a rank the weapon has not reached.
      // These were filed under `conditional`, whose blurb says the reader
      // cannot evaluate something; it had evaluated it, and the answer was no.
      ['off in this build', 'read and correctly worth zero in this build - what would switch it on is under each'],
      // ...and a press the FIGHT left out: slotted, in the rotation, and not
      // pressed because the fight played with it and without it and was
      // better without. The numbers it was left out on are the whole content.
      ['not pressed', 'slotted, and left unpressed: the fight was played with it and without it - the numbers are under each'],
      ['crowd control', 'a stun, root or slow - worth nothing while the simulated foe does not act'],
      ['foe is passive', 'it fires on a block or on being hit, and the simulated foe never attacks'],
      // ...and the half-and-half case, which used to be filed under the line
      // above and was therefore only half true of it.
      ['half of it fires', 'it hooks damage you DEAL as well as damage you take - so "the foe is '
        + 'passive" is only half the reason it is worth nothing here'],
      ['status', 'its payload is a status that declares nothing readable'],
      ['debuff', 'it only debuffs the target, and nothing it debuffs changes damage'],
      ['script magnitude', 'the amount is computed by a script from the hit that applied it'],
      // A status the script hands to somebody else on your side - an ally it
      // names by leaving you out, a summon. Not a magnitude the reader failed
      // at. (It used to add "this fight has one hero and nobody beside
      // them", which is false of a build whose own totem or bees are the
      // recipients.)
      ['lands on an ally', 'its script hands it to an ally or a summon, not to you or to your target'],
      ['script', 'everything it does lives in its hscript body'],
      ['nothing declared', 'no effect, no affix and no status anywhere in the row'],
    ];
    // The kinds whose per-row reason is printed under the row - see the note
    // where it is used.
    const WHY_SHOWN = new Set(['off at this target health', 'half of it fires',
      'off against this target', 'off at this target count', 'off in this build', 'not pressed']);
    const byKind = new Map();
    for (const u of un) {
      const k = u.kind ?? 'script';
      if (!byKind.has(k)) byKind.set(k, []);
      byKind.get(k).push(u);
    }
    out.push('');
    // The COUNT always shows - a build with things the model cannot price is
    // something a reader has to know. The causes and the per-skill reasons are
    // the explanation, and that is what `--verbose` is for.
    out.push(warn(`not scored in this build (${un.length})`
      + (verbose ? ', by cause:' : dim(' - --verbose for what and why'))));
    // The one thing said in the short form too: a line of this build that is
    // priced on an INPUT nothing in the data gives and a flag states - how
    // many of a passive's drops are walked into. It can be what puts the
    // weapon on the build, so it is not left for --verbose to mention.
    for (const u of un) {
      if (u.input?.says) out.push(warn('priced on an input: ') + u.input.says);
    }
    if (!verbose) return out.join('\n');
    for (const [kind, blurb] of KINDS) {
      const list = byKind.get(kind);
      if (!list?.length) continue;
      out.push('  ' + bold(kind) + dim(`  ${blurb}`));
      for (const u of list.slice(0, 8)) {
        const label = u.name && u.name !== u.id ? `${u.name} (${u.id})` : u.id;
        out.push('    ' + label);
        // A rune the model cannot rank is a decision the user still has to
        // make, so the promise is printed rather than summarised away - and it
        // is printed whether or not one is slotted, because the search leaves
        // the socket empty precisely when it cannot tell the options apart.
        for (const r of u.runePromises ?? []) {
          out.push('      ' + (r.slotted ? warn('slotted ') : dim('offers  ')) + dim(`${r.name}: ${r.desc}`));
        }
        // Same exception, for the same reason. The blurb explains a KIND, and
        // for this one the kind is not the useful half: the user needs the
        // threshold and the flag that reaches it, per rider, or "correctly
        // worth zero" reads as "this rune is worthless".
        // ...and the same exception again, for the same reason: the blurb says
        // a script is half live, and the half a reader needs is WHICH half.
        // The other two "read and zero" kinds take it too: which target
        // flag, which missing stun, which rank is the whole content of the
        // line, and the passive's name alone reads as "this does nothing".
        if (WHY_SHOWN.has(kind) && u.why) {
          out.push('      ' + dim(u.why));
        }
      }
      if (list.length > 8) out.push(dim(`    ... and ${list.length - 8} more`));
      byKind.delete(kind);
    }
    for (const [kind, list] of byKind) {
      out.push('  ' + bold(kind));
      for (const u of list) out.push('    ' + u.id + dim('  ' + u.why));
    }
  }
  return out.join('\n');
}

// The allocated tree, with the honest part attached: which points bought
// something the model can read, and which were spent only to open a tier.
export function talentBlock(engine, loadout, alloc, cov, { verbose = true } = {}) {
  const T = engine.talents;
  const tree = T.treeFor(loadout.class);
  const granted = new Set(alloc.granted ?? []);
  const blind = new Set(alloc.blind ?? []);

  const rows = Object.entries(loadout.talents ?? {}).map(([id, rank]) => {
    const n = tree.byId.get(id);
    const v = T.readableValue(id, rank);
    const cap = v.maxPoints;
    return [
      "  " + (n?.tier ?? "-"),
      n?.branch ?? "-",
      n?.name ?? id,
      granted.has(id) ? warn("from sigil") : cap > 1 ? `${rank}/${cap}` : "",
      // At any rank: a node holding two such points is two gate points, and
      // it used to print neither (Life Current 2/2, with no word beside it).
      // The search hands back the ones nothing stands on (optimize.mjs), so
      // what is tagged here is a point the allocation needs to be legal.
      blind.has(id) ? dim(rank > 1 ? "gate points" : "gate point") : "",
      // `readableValue` looks for an affix, an effect or a status. A node whose
      // whole payload is a MECHANIC has none of those and is still scored, so
      // asking it alone printed "nothing readable" beside a talent the fight
      // was already playing.
      v.readable ? (affixSummary(v.affixes) || v.kind)
        : engine.plan.empowermentIds(1).has(id) ? dim(engine.plan.empowermentLabel(id) ?? "a next-cast register")
          : dim("nothing readable"),
    ];
  });

  return [
    dim(`  ${alloc.spent} of ${alloc.budget} points spent`
      + (alloc.unspent ? `, ${alloc.unspent} unspent` : "")
      + (granted.size ? `, ${granted.size} granted by a sigil` : "")),
    rows.length
      ? table(["  TIER", "BRANCH", "TALENT", "RANK", "", "GIVES"], rows)
      : dim("  (nothing in this tree declares a value this model can score)"),
    verbose
      ? dim(`  ${cov.readable} of ${cov.spent} spent points bought a readable value. `
        + `The tree holds ${cov.totalPoints} points across\n  ${cov.total} nodes; `
        + `${cov.total - cov.totalReadable} of those nodes declare nothing at all, so points that only `
        + "open\n  a tier are spent blind and marked. See `bench talents`.")
      : null,
  ].filter((x) => x != null).join("\n");
}
/**
 * What the build DEALS, and where it came from. Overall first, then one row per
 * ability in decreasing damage.
 *
 * The column adds up to the overall, which took exposing a real `total` on each
 * line: `perCast x fight/interval` is not a substitute, because for the chain
 * `interval` is the cycle time while the chain only runs for its share of the
 * clock - reconstructing it that way read 30% over, and a reader adding the
 * column up was right to find it did not close.
 *
 * A pool feed belongs in the sum. It is not a SUBSET of the lines above it - it
 * is a share of their crits, paid out again on its own schedule - so leaving it
 * out is what would make the column short.
 */
export function damageBlock(ev, { verbose = false } = {}) {
  const t = ev.throughput;
  const fight = t.fight || 1;
  const rows = t.lines
    .map((l) => ({ l, dmg: l.total?.damage ?? 0 }))
    .filter((x) => x.dmg > 0)
    .sort((a, b) => b.dmg - a.dmg);
  const total = rows.reduce((s, x) => s + x.dmg, 0);
  // A skill and the dot it leaves behind share a name - Bonethrow's cast and
  // Bonethrow's bleed are two rows - so the kind is appended where the name
  // alone would print twice.
  const seen = new Map();
  for (const x of rows) seen.set(x.l.name, (seen.get(x.l.name) ?? 0) + 1);
  const label = (l) => (seen.get(l.name) > 1 ? `${l.name} (${l.kind})` : l.name);
  return [
    bold('DAMAGE'),
    table(
      ['  ', 'DPS', 'DAMAGE', 'SHARE', 'HITS'],
      [
        ['  overall', num(t.dps, 1), num(total, 0), '',
          num(rows.reduce((s, x) => s + (x.l.hits ?? 0), 0), 0)],
        ...rows.map((x) => [
          '  ' + label(x.l),
          num(x.dmg / fight, 1),
          num(x.dmg, 0),
          total > 0 ? pct(x.dmg / total, 1) : '',
          // HITS is damage EVENTS, not casts: a multi-hit skill lands several
          // per cast, a cleave one per target, and a dot one per tick. That is
          // what a damage meter counts and what the instrumented capture logs a
          // row for, which is what makes the two comparable.
          num(x.l.hits ?? 0, 0),
        ]),
      ],
      { align: [null, 'r', 'r', 'r', 'r'] }
    ),
  ].join('\n');
}

export function throughputBlock(engine, ev, { goal, authored = null }) {
  const t = ev.throughput;
  const s = ev.survivability;
  const spread = t.fights > 1 && t.dpsSd > 0
    ? dim(`mean of ${t.fights} fights, sd ${num(t.dpsSd, 1)} (${pct(t.dpsSd / Math.max(t.dps, 1e-9), 1)})`)
    : dim(`one ${t.fight}s fight, procs at their expected rate`);
  const lines = [
    table(
      ['METRIC', 'VALUE', ''],
      [
        ['damage / s', num(t.dps, 1), goal === 'dps' ? bold('<- goal') : ''],
        ['healing / s', num(t.hps, 1), goal === 'hps' ? bold('<- goal') : ''],
        ['shielding / s', num(t.sps, 1), goal === 'sps' ? bold('<- goal') : ''],
        ['effective HP', num(s.ehp, 0), goal === 'ehp' ? bold('<- goal') : ''],
        ['  physical / magical', `${num(s.ehpPhysical, 0)} / ${num(s.ehpMagical, 0)}`, dim(`reduction ${pct(s.physReduction)} / ${pct(s.magicReduction)}`)],
        ['time on cooldowns', pct(t.busy), dim(`${pct(t.fillerShare)} swinging, ${pct(t.idle)} idle`)],
        ['fight', `${t.fight}s`, spread],
      ],
      { align: [null, 'r'] }
    ),
    '',
    bold('ROTATION') + dim(`   attacks ${t.attackRate.toFixed(2)}/s, combos ${t.comboRate.toFixed(2)}/s`)
      // An AUTHORED list was played (--rotation-file, or the rotation a
      // build was saved with): say whose, where this line used to print
      // "priority: highest damage per second of commitment" over a fight
      // that had followed somebody's list instead.
      + (authored ? dim(`\n  ${authored}`)
        : t.rotationSearched?.lookahead > 0
        ? dim(`\n  played both ways over a ${t.rotationSearched.lookahead}s lookahead and kept the better: `
          + `priority order ${num(t.rotationSearched.greedy, 1)}, sequenced `
          + `${num(t.rotationSearched.sequenced, 1)}`
          + (t.rotationSearched.won === 'sequenced'
            ? ` - sequencing wins by ${signedPct(t.rotationSearched.sequenced / Math.max(t.rotationSearched.greedy, 1e-9) - 1, 1)}`
            // (Not "nothing here rewards ordering" over an order that was
            // just moved for a press that lands on you - the lines below.)
            : (t.rotationSearched.landers?.of ?? []).some((l) => l.placed !== 'rank')
              ? ' - the rollout does not beat it, so priority order stands, with the press below placed in it'
              : ' - nothing here rewards ordering, so priority order stands'))
        : dim('\n  priority: highest damage per second of commitment, cooldowns and charges permitting'))
      // A press that lands on you, for a status that waits for a landing,
      // was played more than one way (sim.mjs `simulate`): every order
      // played is printed with what it came to, and the one kept is marked.
      + (() => {
        const L = t.rotationSearched?.landers;
        if (!L?.played?.length) return '';
        const nameOf = new Map(L.of.map((l) => [l.id, l.name]));
        const said = { tail: 'last in the order', out: 'never pressed' };
        const way = (p) => Object.entries(p).map(([id, at]) => `${nameOf.get(id) ?? id} ${said[at] ?? at}`).join(' and ')
          || 'the order as ranked';
        const one = L.of.length === 1;
        return dim(`\n  ${L.of.map((l) => l.name).join(' and ')} land${one ? 's' : ''} on you for a status that waits for a `
          + `landing, so ${L.exhaustive ? `every order that places ${one ? 'it' : 'them'} was` : 'some of the orders that place them were'} played:`
          + L.played.map((w) => `\n    ${num(w.total, 1)}  ${way(w.placing)}${w.kept ? '  <- kept' : ''}`).join(''));
      })()
      + (t.oversubscribed
        ? '\n' + warn('  the cooldowns fill the whole clock, so the base-attack chain never runs. '
          + 'That is a legal rotation, not an error - but it means the filler is worth nothing here.')
        : ''),
    table(
      ['  SKILL', 'KIND', 'PER CAST', 'EVERY', 'SHARE', ''],
      t.lines
        .slice()
        .sort((a, b) => (b.perCast.damage + b.perCast.heal) / b.interval - (a.perCast.damage + a.perCast.heal) / a.interval)
        .map((l) => [
          '  ' + (l.name === l.id ? l.id : `${l.name}`),
          l.kind === 'triggered' ? warn(l.kind) : l.kind === 'over time' ? warn(l.kind) : dim(l.kind),
          num(l.perCast.damage + l.perCast.heal + l.perCast.shield, 1),
          Number.isFinite(l.interval) ? l.interval.toFixed(2) + 's' : '-',
          l.kind === 'active' || l.kind === 'filler' ? pct(l.share, 0) : '',
          l.why ? dim(l.why) : '',
        ]),
      { align: [null, null, 'r', 'r', 'r'] }
    ),
    dim('  PER CAST is one cast for a skill and one swing-cycle for the chain; for a status it is'
      + '\n  everything it ticked over the whole fight, and EVERY is the fight length.'),
  ];
  return lines.join('\n');
}

export function auditBlock(engine) {
  const rows = engine.audit.map((a) => ['  ' + a.severity, a.what, dim(a.why)]);
  return [
    warn(`ASSUMPTIONS AND GAPS (${engine.audit.length}) - read these before trusting a number`),
    table(['  KIND', 'WHAT', 'WHY'], rows),
  ].join('\n');
}

export function short(slotId) {
  return slotId.replace(/^Slot_/, '');
}

// Which rune the search slotted on each skill, and how many of the three the
// model can actually tell apart. A rune the tool picked but cannot value is a
// coin flip, and saying so is worth more than presenting it as advice.
export function runeBlock(engine, loadout, ev) {
  const T = engine.talents;
  const pools = T.runePools(loadout);
  if (!pools.length) return dim('  (no equipped skill offers a rune choice)');
  const what = (r) => [
    r.gatesSteps.steps ? `${r.gatesSteps.steps} gated step(s)` : null,
    r.gatesSteps.excluded ? `${r.gatesSteps.excluded} suppressed step(s)` : null,
    r.gatesAffixes ? `${r.gatesAffixes} gated affix(es)` : null,
    r.overrides.length ? `overrides ${r.overrides.join(', ')}` : null,
    // What the SCRIPT readers get out of it - a cost change, a resource, a
    // damage multiplier - which the data-path counts above know nothing about.
    // Without this the column said "nothing this model can read" beside three
    // runes the model was demonstrably reading.
    ...(r.scripted ?? []),
  ].filter(Boolean).join('; ');
  const rows = [];
  for (const p of pools) {
    const chosen = loadout.runes?.[p.skill] ?? null;
    const readable = p.options.filter((r) => r.readable);
    const pick = p.options.find((r) => r.id === chosen);
    rows.push([
      '  ' + p.name,
      pick ? bold(pick.name) : dim('(none)'),
      `${readable.length}/${p.options.length}`,
      pick ? (pick.readable ? dim(what(pick)) : warn('nothing this model can read')) : dim(''),
    ]);
  }
  return [
    bold('RUNES'),
    table(['  SKILL', 'SLOTTED', 'READABLE', 'WHAT IT CHANGES'], rows),
    dim('  READABLE counts how many of the three gate a step, suppress one, gate a stat affix,'
      + '\n  override a prop, or change something the script readers take (a cost, a resource, a'
      + '\n  rider, a status). Where it is 0, the pick is a tie broken arbitrarily - the rune may'
      + '\n  still do something in game. The pool is every skill this build KNOWS, not only the ones'
      + '\n  the model can already score, because a rune-gated step is what gives some of them their'
      + '\n  damage in the first place.'),
  ].join('\n');
}
