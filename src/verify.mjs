// ---------------------------------------------------------------------------
// verify.mjs - hold the model against the record and print the difference.
//
// Everything else in src/ computes what Farever OUGHT to do. capture.mjs reads
// what it DID. This file is the join, and it is the only place in the bench
// where the model can be told it is wrong by something other than a person.
//
// Four comparisons, ordered by how much they can be trusted:
//
//   1. PER-HIT. The model's damage-per-event against the capture's mean. Needs
//      no clock, no fight boundary and no rotation - it is the same skill
//      landing on the same target, so a disagreement here is a formula error
//      and nothing else. This is the comparison to fix first.
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
//   4. CADENCE. Mean gap between events against the model's interval. Weakest
//      of the four, because open-world play is not a fight: the player stops,
//      walks, and fights things the sim was never asked about. Read it as a
//      smell, not a verdict.
//
// And two coverage buckets, which matter more than any delta:
//
//   MISSING - the game did it and the model has no line for it. Damage the
//             bench cannot see at all. Every one of these is a coverage hole.
//   PHANTOM - the model claims it and the capture never recorded it. Either the
//             build is wrong or the model invented a source.
//
// A signed delta is always model MINUS capture, so a positive number means the
// model is claiming too much. The signs are what make the rows add up into a
// ledger instead of a list of complaints.
// ---------------------------------------------------------------------------

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
//
// Returns the per-skill rows plus the totals that let a reader see whether the
// gap is spread across everything or concentrated in a few lines.
export function compare({ modelLines = [], captureGroups = [], only = null } = {}) {
  const model = new Map();
  for (const l of modelLines) {
    if (!l?.id) continue;
    const hits = l.hits ?? 0;
    const damage = l.total?.damage ?? 0;
    // A line the fight never played is not a claim about anything.
    if (hits <= 0 && damage <= 0) continue;
    const prev = model.get(l.id);
    // The same id can appear as both an active and a triggered line; the
    // capture cannot tell those apart, so neither may we.
    if (prev) { prev.hits += hits; prev.damage += damage; }
    else model.set(l.id, { id: l.id, name: l.name ?? l.id, hits, damage, interval: l.interval ?? null });
  }

  const live = new Map();
  for (const g of captureGroups) {
    if (only && !only.has(g.key)) continue;
    live.set(g.key, g);
  }

  const modelTotal = [...model.values()].reduce((s, m) => s + m.damage, 0);
  const liveTotal = [...live.values()].reduce((s, g) => s + g.total, 0);

  const rows = [];
  for (const id of new Set([...model.keys(), ...live.keys()])) {
    const m = model.get(id);
    const c = live.get(id);

    if (!c) {
      rows.push({
        id, name: m.name, status: 'PHANTOM',
        modelHits: m.hits, modelDamage: m.damage,
        modelShare: modelTotal ? m.damage / modelTotal : 0,
        liveHits: 0, liveDamage: 0, liveShare: 0,
        perHitDelta: null, shareDelta: null, critDelta: null, verdict: 'PHANTOM',
      });
      continue;
    }
    if (!m) {
      rows.push({
        id, name: id, status: 'MISSING',
        modelHits: 0, modelDamage: 0, modelShare: 0,
        liveHits: c.hits, liveDamage: c.total,
        liveShare: liveTotal ? c.total / liveTotal : 0,
        liveMean: c.mean, liveCrit: c.critRate,
        perHitDelta: null, shareDelta: null, critDelta: null, verdict: 'MISSING',
      });
      continue;
    }

    const modelMean = m.hits ? m.damage / m.hits : null;
    const modelShare = modelTotal ? m.damage / modelTotal : 0;
    const liveShare = liveTotal ? c.total / liveTotal : 0;
    const perHitDelta = rel(modelMean, c.mean);
    // Share is already a fraction, so its delta is a difference in percentage
    // points rather than a ratio - a skill at 2% claimed as 4% is 2pp out, and
    // calling that "+100%" would rank it above things that matter more.
    const shareDelta = modelShare - liveShare;

    rows.push({
      id, name: m.name, status: 'BOTH',
      modelHits: m.hits, modelDamage: m.damage, modelMean, modelShare,
      liveHits: c.hits, liveDamage: c.total, liveMean: c.mean, liveShare,
      liveCrit: c.critRate, liveP05: c.p05, liveP95: c.p95,
      liveIntegrality: c.integrality,
      modelInterval: m.interval,
      liveGapS: c.meanGapMs === null ? null : c.meanGapMs / 1000,
      perHitDelta,
      shareDelta,
      cadenceDelta: m.interval && c.meanGapMs ? rel(m.interval, c.meanGapMs / 1000) : null,
      verdict: verdict(perHitDelta, BANDS.perHit),
      shareVerdict: Math.abs(shareDelta) <= BANDS.share.match ? 'MATCH'
        : Math.abs(shareDelta) <= BANDS.share.close ? 'CLOSE' : 'MISS',
    });
  }

  // Worst first, but coverage holes above tuning errors: an unmodelled skill is
  // a bigger problem than a mispriced one, however small its share.
  const rank = (r) => (r.status === 'MISSING' ? 3 : r.status === 'PHANTOM' ? 2 : 1);
  rows.sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(b) - rank(a);
    return (b.liveDamage || b.modelDamage) - (a.liveDamage || a.modelDamage);
  });

  const missing = rows.filter((r) => r.status === 'MISSING');
  const phantom = rows.filter((r) => r.status === 'PHANTOM');
  const both = rows.filter((r) => r.status === 'BOTH');

  return {
    rows,
    totals: {
      modelDamage: modelTotal,
      liveDamage: liveTotal,
      modelSkills: model.size,
      liveSkills: live.size,
      matched: both.length,
      missing: missing.length,
      phantom: phantom.length,
      // The share of what the game actually did that the model has any line
      // for. This is the number that belongs next to a dps figure: a model
      // explaining 78% of observed damage should never print three digits of
      // precision on the other 22%.
      coverage: liveTotal
        ? both.reduce((s, r) => s + r.liveDamage, 0) / liveTotal
        : null,
      missingDamage: missing.reduce((s, r) => s + r.liveDamage, 0),
      verdicts: {
        match: both.filter((r) => r.verdict === 'MATCH').length,
        close: both.filter((r) => r.verdict === 'CLOSE').length,
        miss: both.filter((r) => r.verdict === 'MISS').length,
      },
    },
  };
}
