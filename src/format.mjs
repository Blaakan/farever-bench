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

export function gearBlock(engine, loadout, { pinnedGear = new Set() } = {}) {
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
      it.faction ?? (cat.payingAptitudes(it, cls.aptitude).length > 1 ? dim(g.aptitude ?? '?') : dim('-')),
      ratingGiven(cat, it, cls.aptitude, rarity, g.aptitude) ?? dim('-'),
      pinnedGear.has(slot.id) ? bold('pinned') : (rolled ? dim('rolled') : ''),
    ]);
  }
  return table(['SLOT', 'ITEM', 'RAR', 'UPG', 'iLVL', 'FACTION', 'GIVES', ''], rows, { align: [null, null, null, null, 'r'] });
}

// Which secondary rating this piece pays out for this class - the cross of the
// item's faction with the class's own atbScaling conditions.
export function ratingGiven(cat, item, aptitude, rarity = null, chosen = null) {
  const rar = rarity ?? item.rarity;
  const aptitudes = cat.cdb.byId('aptitude');
  const aptId = cat.resolveAptitude(item, aptitude, chosen);
  if (aptId) {
    for (const e of aptitudes.get(aptId)?.atbScaling ?? []) {
      if ((e.statGroup ?? 0) !== 3) continue;
      const cd = e.conds ?? {};
      if (cd.minRarity != null && (cat.rarityOrder.get(rar) ?? -1) < (cat.rarityOrder.get(cd.minRarity) ?? 0)) continue;
      if ((cd.factions ?? []).length && !cd.factions.some((f) => f.ref === item.faction)) continue;
      return e.endAtb.replace('Rating', '');
    }
  }
  return null;
}

export function augmentBlock(engine, loadout, { pinnedAug = new Set() } = {}) {
  const { cat } = engine;
  const socks = engine.socketsOf(loadout);
  if (!socks.length) return dim('(no augment sockets - nothing equipped that hosts one)');
  const rows = [];
  for (const s of socks) {
    const id = loadout.augments[s.key];
    const aug = id ? cat.itemById.get(id) : null;
    rows.push([
      short(s.slot),
      s.type.replace(/^Augment/, ''),
      aug ? (aug.name === aug.id ? aug.id : aug.name) : dim('(none)'),
      aug ? affixSummary(aug.affixes) : '',
      pinnedAug.has(s.key) ? bold('pinned') : '',
    ]);
  }
  return table(['SLOT', 'SOCKET', 'AUGMENT', 'EFFECT', ''], rows);
}

export function affixSummary(affixes) {
  const parts = [];
  for (const a of affixes ?? []) {
    const atb = a.target?.attribute;
    if (!atb) continue;
    const v = a.val ?? 0;
    parts.push(`${v > 0 ? '+' : ''}${v} ${atb.replace('Rating', 'Rtg')}`);
  }
  return parts.join(' ');
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
    bold('ROTATION'),
    table(
      ['  SKILL', 'PER CAST', 'EVERY', 'SHARE'],
      t.lines
        .slice()
        .sort((a, b) => (b.perCast.damage + b.perCast.heal) / b.interval - (a.perCast.damage + a.perCast.heal) / a.interval)
        .map((l) => [
          '  ' + (l.name === l.id ? l.id : `${l.name}`),
          num(l.perCast.damage + l.perCast.heal + l.perCast.shield, 1),
          l.interval.toFixed(2) + 's',
          pct(l.share, 0),
        ]),
      { align: [null, 'r', 'r', 'r'] }
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
