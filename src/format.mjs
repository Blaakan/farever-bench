// ---------------------------------------------------------------------------
// format.mjs - printing. Plain text, fixed columns, no colour by default.
//
// The rule every function here follows: never show a number without what it
// was computed against. A score with no target, no rotation and no assumption
// list is exactly the kind of confident-looking output that gets a tool
// distrusted the first time somebody checks it.
// ---------------------------------------------------------------------------

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
  return [
    `${bold('farever-bench')} ${version}`,
    dim(`cdb ${m.cdbSha.slice(0, 8)}  boot ${m.bootSha ? m.bootSha.slice(0, 8) : '(absent)'}  game ${m.game}`),
  ].join('\n');
}

// The attributes worth showing. All 78 exist; these are the ones a gearing
// decision turns on, in a deliberate order rather than sheet order.
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
  for (const slot of cat.combatSlots()) {
    const g = loadout.gear[slot.id];
    if (!g?.item) {
      rows.push([short(slot.id), dim('(empty)'), '', '', '', '', pinnedGear.has(slot.id) ? 'pinned' : '']);
      continue;
    }
    const it = cat.itemById.get(g.item);
    const rarity = g.rarity ?? it.rarity;
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
      pinnedGear.has(slot.id) ? bold('pinned')
        : indifferent.has(slot.id) ? warn('no effect')
        : (rolled ? dim('rolled') : ''),
    ]);
  }
  return table(['SLOT', 'ITEM', 'RAR', 'UPG', 'iLVL', 'FACTION', 'GIVES', ''], rows, { align: [null, null, null, null, 'r'] });
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
        const tree = engine.talents.treeFor(loadout.class);
        const granted = (aug.skills ?? []).filter((sk) => tree.byId.has(sk));
        const readable = granted.filter((sk) => engine.talents.readableValue(sk, 1).readable);
        effect = readable.length
          ? dim('grants ' + readable.map((sk) => tree.byId.get(sk).name).join(', '))
          : warn('a free tier-4 talent this model cannot score - taken because free beats empty');
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
export function skillsBlock(engine, loadout, ev, { pinnedSkills = new Set() } = {}) {
  const pools = engine.plan.pools(loadout);
  if (!pools.length) return dim('(nothing equipped that offers a skill choice)');
  const skills = engine.cdb.byId('skill');
  const name = (id) => skills.get(id)?.texts?.name ?? id;
  const rows = [];
  for (const p of pools) {
    const chosen = loadout.skills?.[p.key] ?? p.options.slice(0, p.slots);
    const dropped = p.options.filter((id) => !chosen.includes(id));
    rows.push([
      p.label,
      `${chosen.length}/${p.options.length}`,
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
      ['chain', 'the weapon\'s base-attack chain is shorter than its moveSet declares'],
      ['crowd control', 'a stun, root or slow - worth nothing while the simulated foe does not act'],
      ['status', 'its payload is a status that declares nothing readable'],
      ['debuff', 'it only debuffs the target, and nothing it debuffs changes damage'],
      ['script magnitude', 'the amount is computed by a script from the hit that applied it'],
      ['script', 'everything it does lives in its hscript body'],
      ['nothing declared', 'no effect, no affix and no status anywhere in the row'],
    ];
    const byKind = new Map();
    for (const u of un) {
      const k = u.kind ?? 'script';
      if (!byKind.has(k)) byKind.set(k, []);
      byKind.get(k).push(u);
    }
    out.push('');
    out.push(warn(`not scored in this build (${un.length}), by cause:`));
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
export function talentBlock(engine, loadout, alloc, cov) {
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
      blind.has(id) && rank === 1 ? dim("gate point") : "",
      v.readable ? (affixSummary(v.affixes) || v.kind) : dim("nothing readable"),
    ];
  });

  return [
    dim(`  ${alloc.spent} of ${alloc.budget} points spent`
      + (alloc.unspent ? `, ${alloc.unspent} unspent` : "")
      + (granted.size ? `, ${granted.size} granted by a sigil` : "")),
    rows.length
      ? table(["  TIER", "BRANCH", "TALENT", "RANK", "", "GIVES"], rows)
      : dim("  (nothing in this tree declares a value this model can score)"),
    dim(`  ${cov.readable} of ${cov.spent} spent points bought a readable value. `
      + `The tree holds ${cov.totalPoints} points across\n  ${cov.total} nodes; `
      + `${cov.total - cov.totalReadable} of those nodes declare nothing at all, so points that only `
      + "open\n  a tier are spent blind and marked. See `bench talents`."),
  ].join("\n");
}
export function throughputBlock(engine, ev, { goal }) {
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
      + (t.rotationSearched
        ? dim(`\n  played both ways over a ${t.rotationSearched.lookahead}s lookahead and kept the better: `
          + `priority order ${num(t.rotationSearched.greedy, 1)}, sequenced `
          + `${num(t.rotationSearched.sequenced, 1)}`
          + (t.rotationSearched.won === 'sequenced'
            ? ` - sequencing wins by ${signedPct(t.rotationSearched.sequenced / Math.max(t.rotationSearched.greedy, 1e-9) - 1, 1)}`
            : ' - nothing here rewards ordering, so priority order stands'))
        : dim('\n  priority: highest damage per second of commitment, cooldowns and charges permitting'))
      + (t.oversubscribed
        ? '\n' + warn('  the cooldowns fill the whole clock, so the base-attack chain never runs. '
          + 'That is a legal rotation, not an error - but it means the filler is worth nothing here.')
        : '')
      // A link the weapon's own item row does not list is not a detail: the
      // combo finisher is what charges prayers and what every isFinalCombo
      // guard rolls against, so the chain's LENGTH sets those rates. Say when
      // it had to be recovered from the weapon type.
      + ((ev?.rotation?.chain?.filled ?? []).length
        ? dim(`\n  chain is ${ev.rotation.chain.links.length} links, per moveSet `
          + `${ev.rotation.chain.moveSet}; ${ev.rotation.chain.filled.length} of them `
          + `(${ev.rotation.chain.filled.map((f) => f.skill).join(', ')}) come from the weapon `
          + 'type because this weapon\'s own row omits them')
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
    dim('  READABLE counts how many of the three gate a step, suppress one, gate a stat affix or'
      + '\n  override a prop. Where it is 0, the pick is a tie broken arbitrarily - the rune may'
      + '\n  still do something in game. The pool is every skill this build KNOWS, not only the ones'
      + '\n  the model can already score, because a rune-gated step is what gives some of them their'
      + '\n  damage in the first place.'),
  ].join('\n');
}
