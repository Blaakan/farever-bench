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
    const eff = cat.effectiveLevel(it, { charLevel: loadout.level, stars: g.stars ?? 0, flawless: !!g.flawless, rarity });
    const rolled = rarity !== it.rarity;
    rows.push([
      short(slot.id),
      it.name === it.id ? it.id : `${it.name}`,
      rolled ? warn(rarity) : rarity,
      g.stars ? '*'.repeat(g.stars) : '',
      num(eff * 10),
      // Craft jewellery lists several alternative aptitudes; only one of them
      // is what you actually looted, so name which one this row assumes.
      it.faction ?? dim('-'),
      ratingGiven(cat, it, cls.aptitude, rarity) ?? dim('-'),
      pinnedGear.has(slot.id) ? bold('pinned')
        : indifferent.has(slot.id) ? warn('no effect')
        : (rolled ? dim('rolled') : ''),
    ]);
  }
  return table(['SLOT', 'ITEM', 'RAR', 'UPG', 'iLVL', 'FACTION', 'GIVES', ''], rows, { align: [null, null, null, null, 'r'] });
}

// Which secondary rating this piece pays out for this class - the cross of the
// item's faction with the class's own atbScaling conditions.
// EVERY paying aptitude contributes, so a dual-aptitude item can grant two
// different ratings out of one faction: a Kobold Assassin+Cleric spear reads as
// ArmorPen through Assassin and Crit through Cleric, and grants +39 of both.
// Returning only the first would hide half of what the item does.
export function ratingGiven(cat, item, aptitude, rarity = null) {
  const rar = rarity ?? item.rarity;
  const aptitudes = cat.cdb.byId('aptitude');
  const found = [];
  for (const aptId of cat.payingAptitudes(item, aptitude)) {
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
    } else {
      // An empty socket has two very different meanings, and conflating them is
      // how a tool misleads: "nothing here beats nothing" versus "I cannot put a
      // number on any of these". Say which.
      // An augment is scoreable if it carries a stat affix, or if a skill it
      // grants resolves to a self-buff status - which is exactly how a weapon
      // enchant comes to be worth anything. A talent that merely declares a
      // damage effect does NOT count: without a trigger rate the model cannot
      // value it, and the DemonSigil talents do not even declare that much.
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
      dropped.length ? dim('not taken: ' + dropped.map(name).join(', ')) : '',
      pinnedSkills.has(p.key) ? bold('pinned') : '',
    ]);
  }
  const out = [table(['POOL', 'SLOTS', 'TAKEN', '', ''], rows)];

  // Anything real that the model knows it is not scoring, named.
  const un = ev?.throughput?.unmodelled ?? [];
  if (un.length) {
    out.push('');
    out.push(warn(`not modelled in this build (${un.length}) - these contribute zero:`));
    for (const u of un.slice(0, 10)) out.push('  ' + u.id.padEnd(34) + dim(u.why));
    if (un.length > 10) out.push(dim(`  ... and ${un.length - 10} more`));
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
  const lines = [
    table(
      ['METRIC', 'VALUE', ''],
      [
        ['damage / s', num(t.dps, 1), goal === 'dps' ? bold('<- goal') : ''],
        ['healing / s', num(t.hps, 1), goal === 'hps' ? bold('<- goal') : ''],
        ['shielding / s', num(t.sps, 1), goal === 'sps' ? bold('<- goal') : ''],
        ['effective HP', num(s.ehp, 0), goal === 'ehp' ? bold('<- goal') : ''],
        ['  physical / magical', `${num(s.ehpPhysical, 0)} / ${num(s.ehpMagical, 0)}`, dim(`reduction ${pct(s.physReduction)} / ${pct(s.magicReduction)}`)],
        ['rotation occupancy', pct(t.busy), dim(`${pct(t.idle)} left for the base-attack chain`)],
      ],
      { align: [null, 'r'] }
    ),
    '',
    bold('ROTATION') + dim(`   attacks ${t.attackRate.toFixed(2)}/s, combos ${t.comboRate.toFixed(2)}/s`)
      + (t.oversubscribed
        ? '\n' + warn('  cooldowns alone exceed the clock, so every one is scaled to fit and nothing is left '
          + 'for the base-attack chain. A real rotation would drop the weakest skill instead.')
        : ''),
    table(
      ['  SKILL', 'KIND', 'PER CAST', 'EVERY', 'SHARE', ''],
      t.lines
        .slice()
        .sort((a, b) => (b.perCast.damage + b.perCast.heal) / b.interval - (a.perCast.damage + a.perCast.heal) / a.interval)
        .map((l) => [
          '  ' + (l.name === l.id ? l.id : `${l.name}`),
          l.kind === 'triggered' ? warn(l.kind) : dim(l.kind),
          num(l.perCast.damage + l.perCast.heal + l.perCast.shield, 1),
          Number.isFinite(l.interval) ? l.interval.toFixed(2) + 's' : '-',
          l.kind === 'triggered' ? '' : pct(l.share, 0),
          l.why ? dim(l.why) : '',
        ]),
      { align: [null, null, 'r', 'r', 'r'] }
    ),
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
  const pools = T.runePools(ev.rotation);
  if (!pools.length) return dim('  (no equipped skill offers a rune choice)');
  const rows = [];
  for (const p of pools) {
    const chosen = loadout.runes?.[p.skill] ?? null;
    const readable = p.options.filter((r) => r.gatesSteps.steps > 0 || r.overrides.length);
    const pick = p.options.find((r) => r.id === chosen);
    rows.push([
      '  ' + p.name,
      pick ? bold(pick.name) : dim('(none)'),
      `${readable.length}/${p.options.length}`,
      pick && (pick.gatesSteps.steps > 0 || pick.overrides.length)
        ? dim([pick.gatesSteps.steps ? `${pick.gatesSteps.steps} gated step(s)` : null,
          pick.overrides.length ? `overrides ${pick.overrides.join(', ')}` : null].filter(Boolean).join('; '))
        : warn('nothing this model can read'),
    ]);
  }
  return [
    bold('RUNES'),
    table(['  SKILL', 'SLOTTED', 'READABLE', 'WHAT IT CHANGES'], rows),
    dim('  READABLE counts how many of the three gate a step or override a prop. Where it is 0,'
      + '\n  the pick is a tie broken arbitrarily - the rune may still do something in game.'),
  ].join('\n');
}
