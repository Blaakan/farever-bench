// ---------------------------------------------------------------------------
// api.mjs - every /api/* endpoint behind the bench UI, per ui/API.md.
//
// One default engine serves bootstrap/catalog/tooltips; /api/sheet draws from
// a small LRU keyed on the engine-construction-time fight options (targets is
// construction-time only - API.md pitfall 3). The optimizer runs in a worker
// thread (ui/optimize-worker.mjs) because a search blocks the event loop for
// seconds, and its messages are relayed over SSE.
// ---------------------------------------------------------------------------

import {
  existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { randomBytes } from 'node:crypto';

import { createEngine, GOALS } from '../src/engine.mjs';
import { illegalReason, infusionIllegalReason, infusionSets } from '../src/loadout.mjs';
import { ratingGiven, affixSummary } from '../src/format.mjs';
import { acceptedBuild } from '../src/drift.mjs';
import { readSheet, reportItems, recordedPieces, SheetError, benchVersion } from '../src/charsheet.mjs';
import {
  buildSubmission, reportItems as submitItems, problemsOf, uploadLink, receiptText, parseReceipt, pendingReceipt,
  sendRefusal, SHEET_MAX_BYTES, LOG_MAX_BYTES, NOTE_MAX, SEND_TIMEOUT_MS,
  sendSubmission, deleteSubmission,
} from '../src/submit.mjs';
import { SubmissionError } from '../src/submission-public.mjs';
import {
  buildView, sanitizeLoadout, clampStars, withheldItems, withheldReason, factionName, infusionRatings,
} from './view.mjs';

// A thrown ApiError picks the status; anything else is a bug and reads 500.
// `extra` is merged into the error body beside the sentence, for the
// refusals a page can act on rather than only print (`needs: "class"` from
// /api/import and /api/submit/preview, a send's receipt).
class ApiError extends Error {
  constructor(status, message, extra = null) { super(message); this.status = status; this.extra = extra; }
}

// Every route and the one method it answers. ui/server.mjs reads this
// (`routeMethod`) BEFORE a body is read: a request in any other method is a
// 405, an OPTIONS preflight included, and a path not listed here is a 404. A
// new route is a row here and a case in `handle`; its body cap is the
// server's, by path (`bodyCapFor`: 40 MB for the two routes that take a
// file, /api/import and /api/submit/preview, 1 MB for everything else).
const ROUTES = new Map([
  ['/api/bootstrap', 'GET'],
  ['/api/catalog', 'GET'],
  ['/api/sheet', 'POST'],
  ['/api/tooltip/item', 'POST'],
  ['/api/tooltip/skill', 'POST'],
  ['/api/optimize/start', 'POST'],
  ['/api/optimize/events', 'GET'],
  ['/api/optimize/cancel', 'POST'],
  ['/api/import', 'POST'],
  ['/api/submit/preview', 'POST'],
  ['/api/submit/bundle', 'POST'],
  ['/api/submit/send', 'POST'],
  ['/api/submit/delete', 'POST'],
  ['/api/submit/receipts', 'POST'],
]);

/** The method a route answers, or null when there is no such route. */
export const routeMethod = (pathname) => ROUTES.get(pathname) ?? null;

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
// The game fills its own tooltips in `$HText.makeSkillText@21941`
// (src/const/HText.hx:1058), and what follows is a PORT of that function
// rather than a convention invented here. Every rule below was read out of the
// shipped bytecode (`node bin/hl.mjs disasm <findex>`) and each function is
// named by findex so the reading can be repeated. makeSkillText maps ONE regex
// over the text through the closure fn@22058 (HText.hx:1069), and that
// closure's own locals are the formatters and the resolver cited below -
// formatTime fn@22060, formatRange fn@22061, formatNumber fn@22062, formatVal
// fn@22063 and displayVar fn@22064. (Closures have no name the drift scanner
// can re-anchor; the HText.hx line is how to find each one again.)
//
//   ::(-?)(ref([\d]*)_)?([a-zA-Z]+)([\d]*)(%?)(#?)::     the regex, verbatim
//     -      print the value signed rather than absolute
//     refN_  read the N-th status the row references, not the row itself
//     name   the value's name; trailing DIGITS ARE AN INDEX, so `val1` is the
//            name `val` at index 0 and `dmg2` the name `dmg` at index 1
//     %      render as a percentage
//     #      multiply by the status's LIVE stack count -
//            `$HText.getStatusStackMult@21940` reads `Status.stacks` off a
//            running instance, and a builder has none, so it is 1 here and
//            the token prints one stack
//
// Resolution order, verbatim from displayVar (fn@22064, HText.hx:1145):
//   1. the WHOLE name (ops 17-178): charges, cooldown, dmgs, dur, duration,
//      name, sourceItemDesc, stacks;
//   2. `inf.vars[name+digits]` (ops 179-262), which OVERRIDES step 1 when the
//      row carries it - `Daggers_Start_Combo` authors `vars.duration` and
//      means that one;
//   3. the COMPUTED families (ops 263-472) - atbgain, dmg, heal, shield, val -
//      which are not stored anywhere. `val` is an affix off the row and needs
//      no character; the rest are damage/healing and have to be priced
//      against one.
//
// `sourceItemDesc` is the one special this cannot fill: it is the description
// of the item the LIVE skill instance came from (ops 144-159: a virtual call
// on the st.skill.BaseSkill, its `.inf`, then `$HText.item@21748` kind Desc -
// which is how a whetstone writes its own status's sentence), and a status
// row alone does not say which item applied it.
//
// The game degrades an unresolved token to the EMPTY STRING (fn@22064 op 17,
// a `res` that starts empty) and leaves the whole token in place when a
// `refN_` names a status the row does not reference (fn@22058 ops 101-102).
// Neither is useful in a builder, so a miss comes back as `MISS` and the
// caller is told which token it was - and the fill NEVER throws, because a
// template hole is not a server error.

// The last resort. Every family that can degrade to a real authored number
// does so instead of printing this - see `fillDesc`'s `price` contract.
export const MISS = '?';

const TOKEN_RE = /::(-?)(ref(\d*)_)?([a-zA-Z]+)(\d*)(%?)(#?)::/g;
// `HText.parseIdx`: no digits is index 0, `ref2`/`val2` is index 1.
const parseIdx = (d) => (d ? Math.max(0, (parseInt(d, 10) || 1) - 1) : 0);

// `Std.string` on a float. The rounding is this file's own: a ratio that
// arrives as 0.30000000000000004 is not a number the game would ever print.
const numText = (v) => String(Math.round(v * 1e6) / 1e6);

// `$HText.floatPrecision@21891` as every formatter here calls it: two decimals,
// then trailing zeros and a bare point trimmed (its third argument is false -
// ops 115-145 walk back over "0" and stop at the point).
const prec2 = (v) => String(Math.round(v * 100) / 100);
// `$HText.percentValue@21883`: x100 AT THAT PRECISION, then "%". A fraction is
// not rounded to a whole percent - the Rogue's Venom Infusion authors 0.025 a
// stack and the game prints "2.5%", where a `Math.round` printed "3%".
const percentValue = (v) => `${prec2(v * 100)}%`;

// formatTime (fn@22060) and formatRange (fn@22061) do not append a unit, they
// FILL A TEXT ROW: `text.rich_duration_seconds` ("::duration::s") and
// `text.rich_range_meters` ("::range::m") on this build. Null when the row is
// gone, and the caller reports that rather than guess the unit.
function richText(cdb, id, tag, value) {
  const t = cdb.byId('text').get(id)?.value?.text;
  return typeof t === 'string' ? t.replace(`::${tag}::`, value) : null;
}
// A `text` row can also be a GROUP of named strings - `Texts.infusion.item_effect`
// in the game's code is row `infusion`, entry `item_effect`. Null when the row
// or the entry is gone.
function groupText(cdb, id, entry) {
  const g = cdb.byId('text').get(id)?.value?.group;
  const t = Array.isArray(g) ? g.find((x) => x?.id === entry)?.value?.text : null;
  return typeof t === 'string' ? t : null;
}

/**
 * formatVal (fn@22063, HText.hx:1108).
 *
 * `isRatio` decides what a `%` means. A stored FRACTION scales by 100
 * (`vars.damage: 0.25` -> "25%", through percentValue); a value already in the
 * attribute's own units does not - a flat +5 CritChance affix reads "5%", not
 * "500%". The game makes that call by testing the affix's ref id for the
 * substring "Ratio" (fn@22064 ops 460-470), which is the same flat/ratio split
 * `upgradeRider` spells out further down this file.
 */
function formatVal(v, { allowNeg = false, isPercent = false, isRatio = true, valMult = 1 } = {}) {
  let x = v;
  if (!allowNeg && x < 0) x = -x;
  x *= valMult;
  if (!isPercent) return numText(x);
  return isRatio ? percentValue(x) : `${numText(x)}%`;
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
 * (fn@22064 ops 368-472). Pure data: it needs no character and so it resolves
 * in `/api/bootstrap` exactly as well as it does under a loadout.
 *
 * A MULTIPLIER IS PRINTED AS WHAT IT TAKES OFF. Ops 427-456 read the affix
 * row's `stack` and, for `Multiplicative` or `Min(base: 1)`, replace the value
 * with `1 - val` before formatting - a `TAttribute_MRatio` of 0.6 on
 * DamageTakenModifier is "you take 60% of what you would", and Ignore Pain's
 * sentence is "Reduces all damage taken by 40%". Printed raw it read 60%, and
 * every slow read as its remaining speed (a 0.7 `TAttribute_MRatioMin` is a
 * 30% slow, not a 70% one); a 1.3 multiplier is -0.3, which formatVal prints
 * unsigned like any other token - "Movement speed increased by 30%", not by
 * 130%. model.mjs's `buildAffixRules` already composes the two kinds this
 * way; the sentence now agrees with it.
 */
function affixText(cdb, row, idx, rank, runes, opts) {
  const rows = (row?.affixes ?? []).filter((a) => condsHold(a.conds, rank, runes));
  const a = rows[idx];
  if (!a || typeof a.val !== 'number') return null;
  const stack = cdb.byId('affix').get(a.ref)?.stack;
  const style = stack ? cdb.custom('AffixStacking', stack) : null;
  const takesOff = style?.case === 'Multiplicative'
    || (style?.case === 'Min' && style.args?.base === 1);
  return formatVal(takesOff ? 1 - a.val : a.val,
    { ...opts, isRatio: /Ratio/.test(String(a.ref ?? '')) });
}

function refRowsOf(cdb, skillRow) {
  const rows = [];
  const refs = skillRow?.texts?.refs;
  if (refs && typeof refs === 'object') {
    // `ref`, `ref2`, `ref3` are three COLUMNS, and a token's digits pick the
    // column (fn@22058 ops 80-91: index 0 reads `ref`, 1 `ref2`, 2 `ref3`) -
    // so the rows sit at their own number, not packed. Fists_WaterUppercut_P
    // authors only `ref2`, and packed densely its `::ref2_dur::` looked for a
    // second entry in a list of one and printed "Slows enemies by ? for ?".
    for (const [k, id] of Object.entries(refs)) {
      rows[(parseInt(k.replace(/\D/g, ''), 10) || 1) - 1] = cdb.byId('skill').get(id) ?? null;
    }
  }
  if (!rows.length) {
    for (const st of skillRow?.steps ?? []) {
      const ref = st.props?.status?.ref;
      if (ref) rows.push(cdb.byId('skill').get(ref) ?? null);
    }
  }
  return rows;
}

// --- [Term] links -------------------------------------------------------------
// Every text the game shows goes through `ui.$BaseUI.formatTextToFmt@16101`,
// which maps LINK_RE below (verbatim, its ops 34-42) through the closure
// fn@25953 (src/ui/BaseUI.hx:935). That closure tries one sheet after another
// with `cdb.IndexId.resolve@16854` and the FIRST HIT WINS, in this order (the
// op of each `r16 = r17.<sheet>` read):
//
//   39 gameTerm · 70 attribute · 134 affinity · 175 unit · 200 faction ·
//   212 icon · 265 item · 330 rarity · 359 itemType · 413 skill ·
//   486 statusType · 523 input · 568 gameBeat · 619 aptitude · 668 zone ·
//   682 job · 694 ach · 708 activityById
//
// and a term no sheet knows is printed as its raw id (ops 711-719). This
// walks the same order over thirteen of them, and the NAME each prints is its
// helper's `Name` case, read on this build:
//
//   gameTerm, statusType   `texts.name` through the declension picker
//                          ($HText.gameTerm@21927 / $HText.statusType@21934,
//                          ops 13-17 of each)
//   itemType               the same, off the first type up the `inherit` chain
//                          that names itself ($HText.itemType@21760 ops 4-55)
//   attribute, affinity,   `name` ($HText.attribute@21948 ops 13-15; ops 143,
//   rarity, aptitude, icon 339 and 628 of the closure; $HText.icon@21511)
//   unit, item, gameBeat   `texts.name ?? id` ($HText.unit@21919 ops 13-19,
//                          $HText.item@21748 ops 18-26, ops 576-583 here)
//   faction                `texts.name` ($HText.faction@21938 ops 13-17; the
//                          closure's ops 199-210 return it as it is)
//   skill                  `texts.name`, else the name of the row its
//                          `texts.refs.ref` points at ($HText.skill@21936 ops
//                          19-53; the automatic reference it tries after that,
//                          $HSkill.getSkillRef@21833, is not ported)
//
// The order is not cosmetic. With statusType tried before skill - which is
// what this did - `[Bleed]` read "Bleed" where the game prints the skill row's
// "Bleeding"; and with no unit, item or gameBeat step at all, an infusion's
// `[Nightling_Infusion_Tank]` ("Obedient Servant"), `[Staff_SummonDemon_Imp]`
// ("Vile Imp"), `[RefillableFlask]` ("Hess'tuss Flask") and `[AttackBlock]`
// ("Block") printed as raw ids.
//
// `faction` is walked for one text, and it is not a skill's: the item
// tooltip titles an infused piece's bonus block with
// `Texts.infusion.infusion_bonus({faction})` - "Infusion bonus ([Bee])" - and
// the link is what turns the row id into "Apix" (see `tooltipItem`). No skill
// description, rank line or rune text links a faction id on this build, so
// no sentence that was already served moves. Three faction rows author no
// name (Starter, World, Craft); the game's helper returns that nothing, this
// prints the id, and nothing links one.
//
// NOT walked: input, zone, job, ach, activity. Their helpers were not read
// and each would be a sheet nothing else here reads. No SKILL description,
// rank line or rune text on this build links an id that only one of them
// owns: the two input ids a skill text does link (`Attack`, `SignatureSkill`)
// are gameTerms first, and no input id is in a sheet walked after it - which
// matters because `input` sits in the MIDDLE of the order. (Six ITEM
// descriptions do link `job` - the craft tools, "[Blacksmith]s" on Hammer -
// and the game's job branch declines the name where this would print the
// bare id; no endpoint fills those six.) What each helper adds AROUND the
// name - a colour, the inline image an attribute, an affinity or an icon is
// drawn with - is not ported; the name is.
//
// Each sheet is read by LITERAL name, so the suite's sheet lint sees every one
// of them: a sheet this resolves names from is a sheet whose drift shows here.

// The letters after a bracket pick a grammatical form, and the table is the
// game's own - the static map `postfixToDeclension` that fn@48706
// (shiro/loc/Declensions.hx:20) fills. English rows author `v` and at most
// `plural`, so "s" is the only one that does anything today.
const DECLENSION = {
  s: 'plural', p: 'plural',
  lc: 'nominativeLc', l: 'nominativeLc',
  lcs: 'nominativeLcPlural', lcp: 'nominativeLcPlural', ls: 'nominativeLcPlural', lp: 'nominativeLcPlural',
  g: 'genitive', gp: 'genitivePlural', gs: 'genitivePlural',
  d: 'dative', dp: 'dativePlural', ds: 'dativePlural',
  a: 'accusative', ap: 'accusativePlural', as: 'accusativePlural',
  i: 'instrumental', ip: 'instrumentalPlural', is: 'instrumentalPlural',
  pr: 'prepositional', prp: 'prepositionalPlural', prs: 'prepositionalPlural',
};
// `shiro.loc.$Declensions.getDeclension@21860`: no postfix is `v`; a postfix
// the table knows is that field WHEN THE NAME AUTHORS IT and `v` otherwise;
// one it does not know throws, and the wrapper `$HText.getDeclension@21859`
// catches that and answers `v` too (its ops 4-42).
function declined(name, postfix) {
  if (!name || typeof name !== 'object') return typeof name === 'string' ? name : null;
  const form = postfix ? DECLENSION[postfix] : null;
  return (form && typeof name[form] === 'string' ? name[form] : name.v) ?? null;
}

const LINK_SHEETS = [
  [(cdb, id) => cdb.byId('gameTerm').get(id), (r, postfix) => declined(r.texts?.name, postfix)],
  [(cdb, id) => cdb.byId('attribute').get(id), (r) => r.name],
  [(cdb, id) => cdb.byId('affinity').get(id), (r) => r.name],
  [(cdb, id) => cdb.byId('unit').get(id), (r) => r.texts?.name],
  [(cdb, id) => cdb.byId('faction').get(id), (r) => r.texts?.name],
  [(cdb, id) => cdb.byId('icon').get(id), (r) => r.name],
  [(cdb, id) => cdb.byId('item').get(id), (r) => r.texts?.name],
  [(cdb, id) => cdb.byId('rarity').get(id), (r) => r.name],
  [(cdb, id) => cdb.byId('itemType').get(id), (r, postfix, cdb) => {
    let t = r;
    for (let hops = 0; t && t.texts?.name == null && hops < 16; hops++) {
      t = t.inherit ? cdb.byId('itemType').get(t.inherit) : null;
    }
    return declined(t?.texts?.name, postfix);
  }],
  [(cdb, id) => cdb.byId('skill').get(id), (r, postfix, cdb) => r.texts?.name
    ?? cdb.byId('skill').get(r.texts?.refs?.ref)?.texts?.name],
  [(cdb, id) => cdb.byId('statusType').get(id), (r, postfix) => declined(r.texts?.name, postfix)],
  [(cdb, id) => cdb.byId('gameBeat').get(id), (r) => r.texts?.name],
  [(cdb, id) => cdb.byId('aptitude').get(id), (r) => r.name],
];

/**
 * The name a `[term]` link prints, or null when no walked sheet has the id.
 * `postfix` is the letters that followed the bracket.
 */
export function resolveTerm(cdb, term, postfix = '') {
  for (const [rowOf, nameOf] of LINK_SHEETS) {
    const row = rowOf(cdb, term);
    if (!row) continue;
    const name = nameOf(row, postfix, cdb);
    // First hit wins even when the row names nothing: twenty-five attributes
    // ship an empty display name, and those read as their id rather than as a
    // hole in the sentence or as whatever a LATER sheet calls the same id.
    return typeof name === 'string' && name ? name : term;
  }
  return null;
}

// The game's link pattern, verbatim: an id of at least two characters from
// [A-Za-z0-9_] that may carry `!` (print unformatted) or `;` (no reference) -
// both are stripped before the lookup (fn@25953 ops 10-37) - an optional
// `-option`, and then ANY LETTERS THAT FOLLOW THE BRACKET. Those letters are
// part of the match, so they are consumed: a sheet that declines reads them as
// the form to print ("[Attack]s" is the gameTerm's `plural`, "Attacks"), and
// every other branch simply returns its name, which drops them - "[Shield]s"
// (an attribute) prints "Shield" and "[AttackBlock]s" (a gameBeat) "Block",
// as does a term nothing resolves ("[Summon]s" is "Summon": ops 711-719 return
// `id + (matched(2) ?? "")`, the option, and nothing else). A bracket that is
// not a link - `[1.5]`, `[.55FP]` - keeps its brackets, as it does in game.
const LINK_RE = /\[([!;A-Za-z0-9][A-Za-z0-9_]+)(-([A-Za-z0-9_]+))?\]([A-Za-z]*)/g;
export function fillLinks(cdb, text) {
  return String(text).replace(LINK_RE, (_, rawId, option, _optionName, postfix) => {
    const id = rawId.replace(/[!;]/g, '');
    return resolveTerm(cdb, id, postfix) ?? (id + (option ?? ''));
  });
}

// --- an affix as the game prints one -------------------------------------------
// `$HText.affix@21956` (reached through `$HText.affixByDesc@21954`) does not
// compose a line, it FILLS ONE: the template is the entry's own `desc` when it
// authors one and the `affix` row's `desc` otherwise (ops 4-7), and on this
// build
//
//   affix.TAttribute_Flat.desc    "::s_atb_value:: [::target::]"
//   affix.TAttribute_ARatio.desc  "::s_percent_value:: [::target::]"
//   affix.TAttribute_MRatio.desc  "::percent:: [::target::]"
//
// The value tags are `$HText.formatValue@21888`'s keys, each a number at
// floatPrecision's two decimals (`prec2` above):
//
//   value            the number                 s_value          signed
//   percent_value    x100, then "%"             s_percent_value  signed
//   percent          (v - 1) x100, then "%"     s_percent        signed, by v >= 1
//
// (`$HText.percentValue@21883`, `$HText.signedPercentValue@21885`,
// `$HText.signedValue@21887`, `$HText.percent@21881`,
// `$HText.signedPercent@21882`; the last two print a whole number once the
// change reaches 1%.) `atb_value` / `s_atb_value` choose between the first two
// families by the TARGET attribute: one flagged Percent prints as
// `percent_value` of val x0.01, any other as `value` (the closure fn@22070,
// HText.hx:1693, ops 30-63 and 64-93). So a flat +2.5 on Critical Chance reads
// "+2.5% Critical Chance" and a -0.04 ratio on Vitality "-4% Vitality" - not
// the "+2.5 CritChance" a hand-rolled line gives.
//
// `::target::` is the target's id - the first parameter of its ETargetKind
// (the closure fn@22071, HText.hx:1709, ops 83-89) - which the template's own
// brackets then make a link. The stack multiplier the function applies (ops
// 28-32) is the live stack count and is 1 here, as everywhere in this file.
// An affix row not flagged `implemented` gets the game's own suffix (ops
// 70-77; no row a skill carries on this build is one). A tag outside the six
// above is refused, not guessed: the line comes back null and the caller
// reports it.
const sign = (v, zero = 0) => (v >= zero ? '+' : '');
const pctOff = (v) => {
  const x = (v - 1) * 100;
  return `${x > -1 && x < 1 ? prec2(x) : Math.round(x)}%`;
};
const AFFIX_FORMATS = {
  value: (v) => prec2(v),
  s_value: (v) => sign(v) + prec2(v),
  percent_value: (v) => percentValue(v),
  s_percent_value: (v) => sign(v) + percentValue(v),
  percent: (v) => pctOff(v),
  s_percent: (v) => sign(v, 1) + pctOff(v),
};

export function affixLine(cdb, a) {
  const affixRow = cdb.byId('affix').get(a?.ref);
  const template = a?.desc || affixRow?.desc;
  if (!template || typeof a.val !== 'number') return null;
  const percentAttr = (id) => cdb.flagNames('attribute', 'flags',
    cdb.byId('attribute').get(id)?.flags).includes('Percent');
  let refused = false;
  const text = String(template).replace(/::([A-Za-z0-9_]+)::/g, (whole, tag) => {
    if (tag === 'target' || tag === 'target2') {
      const id = Object.values(a[tag] ?? {}).find((x) => typeof x === 'string');
      if (id) return id;
    } else if (tag === 'atb_value' || tag === 's_atb_value') {
      const pct = !!a.target?.attribute && percentAttr(a.target.attribute);
      const key = (tag === 's_atb_value' ? 's_' : '') + (pct ? 'percent_value' : 'value');
      return AFFIX_FORMATS[key](pct ? a.val * 0.01 : a.val);
    } else if (AFFIX_FORMATS[tag]) {
      return AFFIX_FORMATS[tag](a.val);
    }
    refused = true;
    return whole;
  });
  if (refused) return null;
  return fillLinks(cdb, affixRow && affixRow.implemented !== true ? `${text}(Not Implemented)` : text);
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
  // Seconds and metres, in the game's own words for them (see `richText`).
  const unit = (id, tag, v) => richText(cdb, id, tag, numText(v))
    ?? miss(`text.${id}`, 'the game data has no such text row');
  const seconds = (v) => unit('rich_duration_seconds', 'duration', v);
  const metres = (v) => unit('rich_range_meters', 'range', v);

  const filled = String(desc).replace(TOKEN_RE,
    (whole, neg, refPrefix, refDigits, key, idxDigits, pctSign, hashSign) => {
      try {
        const ref = refPrefix ? (refs[parseIdx(refDigits)] ?? null) : null;
        if (refPrefix && !ref) {
          return miss(whole, 'the row references no status at that index');
        }
        const row = ref ?? skillRow;
        const full = key + idxDigits;
        const vars = ref
          ? (varsFor ? (varsFor(ref) ?? ref.vars ?? {}) : (ref.vars ?? {}))
          : own;
        const opts = {
          allowNeg: neg === '-',
          // A bare `::chance::` is a percentage: CastleDB marks the column
          // `display: 1` and the game hardcodes the same name (fn@22064 ops
          // 185-194). All 33 such columns are ratios and exactly two of them are
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
          if (v > 0) special = seconds(v);
        } else if (full === 'charges') {
          const v = inf.charges ?? row?.props?.charges;
          if (typeof v === 'number') special = numText(v);
        } else if (full === 'dur' || full === 'duration') {
          const v = inf.duration || row?.duration;
          if (v > 0) special = seconds(v);
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
          // The four named formats displayVar dispatches on the NAME rather
          // than the whole token (fn@22064 ops 185-261), so `dur1` and
          // `time2` are seconds too: `chance` is percentValue, `dur` and
          // `time` go through formatTime, `range` through formatRange - "to
          // allies within ::range::" is "within 100m", not a bare 100. One row
          // in the build - DS_Bladeleaf_Skill1 - writes "::time:: seconds" and
          // so reads "4s seconds", which is what the game shows.
          if (key === 'chance') return percentValue(v);
          if ((key === 'dur' || key === 'time') && !opts.isPercent) {
            return seconds(v * opts.valMult);
          }
          if (key === 'range' && !opts.isPercent) return metres(v);
          return formatVal(v, opts);
        }
        if (special != null) return special;
        // The one special with nothing to read here (see the header): the
        // game fills it from the LIVE skill instance's source item, and says
        // nothing when there is none. Refused under its own reason - falling
        // through to the last miss below called it a value the row does not
        // name, which reads as a typo in the data and is not one.
        if (full === 'sourceItemDesc') {
          return miss(whole, 'the description of the item the live status came from'
            + ` - ${row?.id ?? 'the row'} alone does not name it`);
        }

        // (3) the computed families.
        const idx = parseIdx(idxDigits);
        if (key === 'val') {
          const t = affixText(cdb, row, idx, rank, runes, opts);
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
  return fillLinks(cdb, filled);
}

// --- pricing a magnitude ----------------------------------------------------
// A skill's damage is not a stored var: it is computed from the skill's steps
// against the character, which is why 154 `::dmg::` tokens used to print '?'.
//
// WHICH effect a token names comes off `$HSkill.getEffectIndex@21830`: it
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
//   dmg      predicate `affinity != null`   (HSkill.getDamageEffect@21751)
//   heal     `effect == Heal`               (HText.makeEffectDetail@21950)
//   shield   `effect == Shield`
//   atbgain  `effect == GainAtb`
//   dmgs     every Damage effect, grouped by affinity and joined with " + ",
//            SKIPPING steps played by script (`on == Code`) - the one place
//            the two walks differ (HText.makeDamageDetails@21949 + fn@22068)
//
// WHAT it prints is `$HText.skillEffectValText@21951` (HText.hx:1443):
//
//   raw    = baseVal + SUM(ratio x attribute)
//   raw   *= getDamageRatio(root)   // (1 + mastery + Fervor) x DamageModifier
//   amount = ceil(raw)              // ent.Hero.flattenAtbScaling@7829 is ceil
//   range  = WeaponAttack_RandomRange x amount, and ZERO unless the row's type
//            is Attack..Attack4 (getEffectRange@21778) - so a weapon skill, a
//            finisher and a status tick each print ONE number and only a basic
//            swing prints a band
//   print    floor(lo x mult) - ceil(hi x mult) when they differ, else
//            floor(amount x mult), where mult is DamageModifier /
//            HealGivenMultiplier / ShieldPowerMultiplier by effect kind
//
// DamageModifier therefore lands TWICE on a Damage effect - once inside
// GameObject.getDamageRatio@4577 and once as `mult`. That is the game's own arithmetic
// and not a transcription slip: both go through ent.GameObject.atbVal@4571, which
// normalises a percent-flagged attribute by 0.01, so a neutral 100 is 1.0 and
// only a build that actually carries DamageModifier can tell the difference.
//
// Notice what is NOT in that expression: no crit, no armour, no target at all.
// The tooltip is a PRE-MITIGATION number, which is why it never agrees with a
// damage meter directly - see the note on `tooltipSkill`.
//
// What ONE scaling entry is worth - the 60/40 weapon mix, the WeaponPower
// rule and the AllAttributes selector - is damage.mjs `scalingValue`, called
// from here and never copied: the tooltip is the client running the same
// getStepEffectScaling@21777 the hit is priced with.

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

  // `isWeaponBased` (BaseSkill.isWeaponBased@6164) is a set of skill TYPES with no slot
  // check, so the arsenal's skills mix exactly like the mainhand's and a class
  // skill stays pure attribute.
  const WEAPON_BASED = new Set(['Attack', 'Attack2', 'Attack3', 'Attack4',
    'AttackCombo', 'Block', 'WeaponSkill', 'WeaponSubSkill', 'WeaponPassive']);
  const BASIC_SWING = new Set(['Attack', 'Attack2', 'Attack3', 'Attack4']);

  // WeaponPower reads the weapon's flat PLUS the mean of the ITEM's aptitude
  // attributes at the attribute keep, and a weapon skill's attribute scaling
  // mixes that keep of the attribute with the item share of that attribute's
  // own budget curve. These are the inputs engine.mjs hands the fight, lifted
  // here so a tooltip cannot disagree with the sheet.
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
  // getDamageARatio@4581: Magic reads MagicMastery, Physical PhysicalMastery,
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
      a += num(sc.ratio) * combat.scalingValue(sc.atb, sheet, swingAttrs, mix);
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
 * a percentage (skillEffectValText@21951 ops 121-154, the `unit == null` branch), which
 * for a two-attribute effect multiplies 1.2 by 1.2 and prints 144%. That is a
 * number nobody can use, so this prints the SAME information the game's
 * expanded tooltips render - "120% Intellect + 120% Faith" - which is what the
 * row actually authors and is readable without a build. Only a row that
 * authors no magnitude at all falls through to `MISS`.
 */
function createCoefficientPricer(engine, { rank = 1 } = {}) {
  const { cdb, combat } = engine;
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
  // `AllAttributes` is a selector and not a stat: the game's own expanded
  // tooltip lists the attributes it stands for, each at ratio / count
  // (getStepEffectScaling@21777 ops 154-186), so "25% All Attributes" is
  // printed as four 6.25% terms rather than as a stat nobody has. Two
  // decimals, because 6.25 rounded to 6 four times no longer adds up to 25.
  const mainAttributes = combat.scaling.mainAttributes;
  const pct = (x) => String(+(x * 100).toFixed(2));
  const coeff = (e) => {
    if (!priceable(e)) return null;
    const terms = [];
    if (typeof e.baseVal === 'number' && e.baseVal !== 0) terms.push(String(e.baseVal));
    for (const sc of e.scaling ?? []) {
      if (!sc.atb || !condsHold(sc.conds, rank, null)) continue;
      if (sc.atb === 'AllAttributes' && mainAttributes.length) {
        for (const id of mainAttributes) terms.push(`${pct((sc.ratio ?? 0) / mainAttributes.length)}% ${attrName(id)}`);
        continue;
      }
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

// The two printers a view needs and view.mjs cannot import (this file imports
// it): an affix through the game's own template, and a text with its [links]
// named. The optimize worker hands buildView the same pair.
export const gameText = { affixLine, fillLinks };

// --- the api ----------------------------------------------------------------

// `submitOff`: the sentence ui/server.mjs refuses every /api/submit/ route
// with on a bind beyond loopback (null on loopback), served in bootstrap so
// the dialog can say it before anyone fills it in.
export async function createApi({ benchRoot, game = null, submitOff = null }) {
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

  // --- infusion: what a page is told about one ------------------------------
  // An infusion is a set passive learned from a pattern item and worn on
  // armour (catalog.mjs has the four rules and where each was read). The list
  // is the catalog's - every item of type InfusionPattern, keyed by the skill
  // it names - and so is the answer to "can it be learned on this build":
  // `cat.infusionSource` asks the install's own source reader what hands the
  // PATTERN out, and returns its sentence ("Gatsbee drops it on Heroic";
  // "...and Heroic is not released for Chakram's Chapel"). Nothing here judges
  // an infusion by its id.
  //
  // `obtainable` is the search's own default (optimize.mjs): an infusion is
  // offered unless it is SHOWN to be unobtainable, so one whose source could
  // not be judged - `state: "unknown"` - is offered, with its sentence.
  const infusionEntry = (id) => {
    const inf = eng.cat.infusions.get(id);
    if (!inf) return null;
    const src = eng.cat.infusionSource(id);
    return {
      id,
      name: inf.name,
      icon: skillIcon(id),
      // The faction whose pieces it lights the bonus line of - the PATTERN's
      // faction ($HInfusion.getInfusionFaction@21693), whatever the id says:
      // the three `Infusion_Nightling_*` are of faction `Demon`, "Nightlings".
      faction: inf.faction,
      factionName: factionName(eng.cdb, inf.faction),
      pattern: inf.pattern,
      source: { state: src.state, why: src.why },
      obtainable: src.state !== 'unreleased',
    };
  };
  // The ratings a bonus line can be: the rows of the aptitude the game prices
  // it from - view.mjs's `infusionRatings`, which has the reads and is the
  // list `sanitizeLoadout` holds a gear entry's `infusionStat` to.
  const infusionStats = () => infusionRatings(eng.cdb);

  // Whether this install is the build the model was accepted on; null when no
  // fingerprint is committed. Read once - the install does not change under a
  // running server - and SAID, not just served: every CLI command prints this
  // sentence under its header (format.mjs `header`), and a number on a page is
  // as much a number computed on an unaccepted build as one in a terminal. The
  // wording is format.mjs's, kept word for word so the two cannot be read as
  // two different warnings.
  const accepted = acceptedBuild(fileURLToPath(new URL('..', import.meta.url)), eng.meta);
  const notice = accepted && !accepted.same
    ? 'this install is not the build the model was accepted on '
      + `(${String(accepted.at).slice(0, 10)}) - run bench update`
    : null;

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

    // An augment with no stat line still DOES something, and the game says
    // what through the one skill the item carries. `$HText.item@21748` case
    // Desc (ops 31-86): when `skills.length == 1` the description is the
    // item's `texts.desc` run through makeSkillText against that skill (ops
    // 48-62) - so the twelve sigils' "Grants the talent ::name::." names the
    // talent - or, when the item authors no desc, the skill's own Desc text
    // (ops 64-73, `$HText.skill@21936` kind Desc), which is how the five
    // weapon formulas describe their enchant. Without this every sigil of a
    // class was the same row: one name, no effect, one acquire line.
    const augmentDesc = (a) => {
      const own = a.raw?.texts?.desc ?? null;
      const one = (a.skills ?? []).length === 1 ? skillRow(a.skills[0]) : null;
      if (!one) return own ?? '';
      return fillDesc(cdb, own ?? one.texts?.desc, {
        own: { ...(one.vars ?? {}) }, skillRow: one, rank: 1, price: coeff,
      });
    };

    const augments = {};
    for (const t of cat.augmentTypes) {
      augments[t.id] = cat.augmentCandidates(t.id).map((a) => {
        // Sigils are class-gated via usableBy; augmentCandidates does not
        // filter them (pitfall 14), so the gate is derived here.
        const gate = t.id === 'AugmentDemonSigil'
          ? (cat.classes.find((c) => cat.usableBy(a, c.aptitude))?.unit ?? null)
          : null;
        // ...and which node of that class's tree the sigil grants: its skills
        // met with the tree, the same intersection view.mjs's grantedNodes
        // makes of a loadout. Named here because the client cannot work it
        // out: all twelve rows share one name, and no sigil id contains its
        // talent's id or the other way round.
        const node = gate
          ? talents.treeFor(gate).nodes.find((n) => (a.skills ?? []).includes(n.skill))
          : null;
        return {
          id: a.id,
          name: a.name,
          icon: a.raw?.gfx?.file ? icons.iconRef(a.raw.gfx) : null,
          rarity: a.rarity,
          effect: affixSummary(a.affixes) || augmentDesc(a),
          classGate: gate,
          grants: node ? { id: node.skill, name: node.name } : null,
          acquire: icons.atlasFor(a.id)?.acquire ?? null,
        };
      });
    }

    bootstrapCache = {
      meta: {
        version,
        cdbSha: eng.meta.cdbSha,
        bootSha: eng.meta.bootSha,
        game: eng.meta.game,
        // Whether this install is the build the model was accepted on (null
        // when no fingerprint is committed), and the sentence to show when it
        // is not (null when it is).
        accepted,
        notice,
      },
      classes, rarities, attributes, slots, targets,
      goals: GOALS,
      talents: talentTrees,
      runes,
      augments,
      // Every infusion of this build, in the catalog's order, each with the
      // source reader's answer to whether anything hands its pattern out.
      // Empty on a build of the game with no Infusion system.
      infusions: [...cat.infusions.keys()].map(infusionEntry),
      constants: {
        maxLevel: ctx.consts.maxLevel,
        talentPointsAtCap: talents.defaultPointsAtCap,
        // null on a build with no Infusion system. `caps` are the piece
        // counts a set's ranks start at (Item_InfusionCaps), `minRarity` the
        // rarity a piece must at least be to carry one
        // (Item_InfusionMinRarity), `stats` the ratings a bonus line can
        // roll; the two texts are the game's own words for the list's header
        // and for the item flag that lights a bonus whatever the faction.
        infusion: cat.infusions.size ? {
          caps: cat.infusionCaps,
          minRarity: cat.infusionMinRarity,
          stats: infusionStats().map((id) => ({ id, name: attrName(id) })),
          texts: {
            header: groupText(cdb, 'infusion', 'selection_header'),
            prismatic: groupText(cdb, 'inventory_item_flags', 'Prismatic'),
          },
        } : null,
      },
      // "Send a fight": the caps src/submit.mjs holds a bundle to - the page
      // checks a file against them before reading it, and a dialog that
      // copied them would go on saying the old ones after the module moved
      // one - how long a send waits for pCloud's answer (the module's, which
      // the dialog says while it waits), and, on a bind beyond loopback, the
      // sentence every submit route is refused with (null on loopback).
      submit: {
        sheetMaxBytes: SHEET_MAX_BYTES,
        logMaxBytes: LOG_MAX_BYTES,
        noteMax: NOTE_MAX,
        sendTimeoutMs: SEND_TIMEOUT_MS,
        off: submitOff,
      },
    };
    return bootstrapCache;
  }

  // --- which rarities an item can be -----------------------------------------
  // The game rolls rarity for a WEAPON and for nothing else:
  // ent.Hero.makeLootItem@7953 ops 126-129 test `isSameType(type, "Weapon")`
  // and jump past the whole roll (130-421) when it fails, and the one rarity
  // write in it is st.item.Weapon.set_rarity@9846 at op 421 - no other item
  // class has that setter. Armour, jewellery and trinkets are exactly the
  // rarity their row authors, which is why the game ships its Epic armour as
  // separate `*_E<Faction>_*` rows rather than letting the Rare ones roll up.
  //
  // `cat.candidates` applies that test itself. `cat.attainableRarities` does
  // not - handed any item, it lists every rarity from the authored one up to
  // the slot's ceiling - so the question is asked HERE, through the catalog's
  // own `isWeaponType` (the itemType chain reaching MainhandWeapon or
  // OffhandWeapon, both of which inherit Weapon), for the picker and the
  // tooltip alike; view.mjs's sanitizeLoadout asks the same thing of a
  // loadout. Unguarded, every armour row in the picker offered "Rare 50% /
  // Epic 19%" and was painted with the best of them.
  const rarityChoices = (item, level, slotId) => (eng.cat.isWeaponType(item.type)
    ? eng.cat.attainableRarities(item, level, slotId)
    : [{ rarity: item.rarity, chance: null, authored: true }]);

  // --- GET /api/catalog?class=X&level=N ------------------------------------

  function catalog(searchParams) {
    const { cat } = eng;
    const clsName = searchParams.get('class');
    // (Asked with no class at all, this answered `unknown class "null"`.)
    if (!clsName) throw new ApiError(400, `class is required - one of ${cat.classes.map((c) => c.unit).join(', ')}`);
    const cls = cat.classes.find((c) => c.unit === clsName || c.aptitude === clsName);
    if (!cls) throw new ApiError(400, `unknown class "${clsName}" - one of ${cat.classes.map((c) => c.unit).join(', ')}`);
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

    // One catalog row. The offered rows and the withheld ones are built by the
    // same function, so a withheld row is everything a listed one is - it can
    // be shown, priced and edited - plus the reason it is not offered.
    const rowOf = (item, slot) => {
        const atlas = icons.atlasFor(item.id);
        const levelScales = typeScales(item.type);
        // A row that authors no level at all is priced AT your level in
        // either branch (`authored ?? charLevel` in cat.effectiveLevel), so
        // its range collapses rather than being unknown. Most of them are the
        // faction armour and trinkets, but not all: `InfusedTusk` is a craft
        // recipe's output, and `Head_Shop`, `Back_Shop` and
        // `Chest_C_BaseClothes` (whose acquire lines read "Starting outfit"
        // and "Base clothing") author none either - so the rule is the
        // missing level, and nothing here may call such a row a drop.
        const authored = item.level ?? (item.iLevel != null ? item.iLevel / 10 : null);
        // ...and never below the level every source of the row makes it at
        // (`cat.minInstanceLevel`, which `cat.effectiveLevel` floors the price
        // at too). The Demon Epic armour authors `level: 1` and exists only at
        // the cap - a Chaotic Gear Cache makes it there - so its band is one
        // level, not the 1..25 a slider used to offer on it.
        const floor = cat.minInstanceLevel(item);
        const from = Math.max(authored ?? level, floor ?? 0);
        const rel = cat.release(item);
        const infusable = cat.canInfuse(item);
        const origin = cat.factionOrigin(item);
        return {
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
          // The name the faction is shown under - "Apix" for `Bee`.
          factionName: factionName(eng.cdb, item.faction),
          aptitudes: item.aptitudes,
          gives: ratingGiven(cat, item, cls.aptitude),
          icon: item.raw?.gfx?.file ? icons.iconRef(item.raw.gfx) : null,
          rarities: rarityChoices(item, level, slot.id).map((r) => ({
            id: r.rarity,
            ...(r.authored ? { authored: true } : {}),
            chance: r.chance,
            maxStars: cat.maxStars(item, r.rarity),
          })),
          skills: weaponSkills(item),
          acquire: atlas?.acquire ?? null,
          track: atlas?.track ?? [],
          flavor: item.raw?.texts?.flavorDesc ?? null,
          // WHERE IT COMES FROM, as the install says rather than as a list
          // somebody typed: the catalog's source reader (sources.mjs) searched
          // the cdb, the level files and the compiled code for what hands this
          // row out, and `why` is its sentence. `acquire` above is the atlas
          // TSV's line and predates the September 30 update - none of the Epic
          // armour has one - so a client prints `acquire ?? source.why`.
          //   live        an open source exists (`why` names it)
          //   unknown     a source could not be judged; the row is still offered
          //   unreleased  nothing hands it out; the row is in `withheld`
          source: { state: rel.state, why: rel.why },
          // WHETHER IT CAN CARRY AN INFUSION ($HInfusion.canBeInfused@21689, by
          // the catalog's reader): `notInfusable` is the rule it fails, as a
          // sentence, and null when it can. For a piece that can:
          // `infusionFaction` is the faction an infusion must be OF to light
          // its bonus line without the piece being Prismatic (its faction
          // origin - st.item.Gear.isInfusionBonusActive@9766 ops 15-19), and
          // `infusionPool` the ratings that line can have rolled
          // ($HInfusion.pickInfusionBonusStat@21694: the bonus ratings the
          // piece does not already pay).
          infusable,
          notInfusable: infusable ? null : cat.whyNotInfusable(item),
          infusionFaction: infusable ? { id: origin, name: factionName(eng.cdb, origin) } : null,
          infusionPool: infusable
            ? cat.infusionBonusPool(item).map((id) => ({ stat: id, name: attrName(id) })) : [],
        };
    };

    const slots = {};
    for (const slot of cat.combatSlots()) {
      // Collapse the rolled candidate rows to one entry per ITEM; the rarity
      // spread comes back as its own array (anything but a weapon: the single
      // authored row - see `rarityChoices`).
      const seen = new Set();
      const out = [];
      for (const c of cat.candidates(slot.id, {
        aptitude: cls.aptitude, charLevel: level, rarityRoll: true,
      })) {
        const item = c.item;
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        out.push(rowOf(item, slot));
      }
      // Best first, by what the row is WORTH at this level rather than by the
      // level its row happens to author: the level it is priced at when the
      // loadout names no instance level, then its authored rarity, then its
      // authored level (the greens' only distinguishing number), then its
      // name. Sorting on `item.level` alone put every row that authors none -
      // the Rare and Epic faction sets, which is what a level-25 character
      // wears - below the level-13 greens, because a null level subtracts as
      // zero.
      //
      // WHICH END of the range that default is depends on the row, and it is
      // `cat.effectiveLevel`'s branch again: a row that scales is priced at
      // the TOP (your level), one that does not at the BOTTOM (its own) - the
      // picker's slider says "defaults to <lo>" for exactly those. Sorting
      // every row on the top filed a level-6 Uncommon necklace, whose band
      // runs up to the character's level but which is priced at 6 unless the
      // player says otherwise, above the crafted level-20 Rare one. A crafted
      // row's range is one level, so either end reads the same.
      const pricedAt = (r) => r.levelRange?.[r.levelScales ? 1 : 0] ?? 0;
      const rank = (r) => cat.rarityOrder.get(cat.itemById.get(r.id)?.rarity) ?? -1;
      out.sort((a, b) => (pricedAt(b) - pricedAt(a))
        || (rank(b) - rank(a))
        || ((b.level ?? 0) - (a.level ?? 0))
        || a.name.localeCompare(b.name));
      slots[slot.id] = out;
    }

    // WHAT THE LISTS ABOVE LEAVE OUT. `cat.candidates` withholds a row nothing
    // in this install hands out, and a row whose every copy exists above the
    // character's level - which is right, and was silent: until the catalog
    // learned to read sources the picker listed 26 Epic rows that sit only in
    // loot tables nothing points at, and offered every Epic piece to a
    // level-10 character although each of them is made at the level cap. They
    // are not dropped from the answer, they are MOVED: each comes back here,
    // per slot, as a full row plus `withheld: { kind, floor, why }` - the
    // source reader's own sentence - so a page can show what it is not
    // offering and on what evidence. A search never picks one; a person still
    // may (the CLI's rule for a pin: it always can, and is told what it is).
    const withheld = {};
    for (const [slotId, rows] of withheldItems(eng, { aptitude: cls.aptitude, level })) {
      const slot = cat.slotById.get(slotId);
      withheld[slotId] = rows.map((r) => ({
        ...rowOf(r.item, slot),
        withheld: { kind: r.kind, floor: r.floor, why: r.why },
      })).sort((a, b) => (rarityIndex.get(cat.itemById.get(b.id)?.rarity) ?? -1)
        - (rarityIndex.get(cat.itemById.get(a.id)?.rarity) ?? -1) || a.name.localeCompare(b.name));
    }
    // With a store unread the reader withholds NOTHING, and says which store
    // and why - an empty `withheld` then means "could not tell", not "all of
    // it is obtainable".
    const src = cat.sources();
    const withheldNote = !src.prefabs.read || !src.code.read
      ? `${src.prefabs.why ?? src.code.why}, so no row could be shown to be unobtainable`
      : null;
    return { slots, withheld, withheldNote };
  }

  // --- options the engine would take in silence -----------------------------
  // The scorer reads the goal as a key (`metrics(ev)[goal] ?? 0` in
  // engine.mjs's makeScorer), so a goal it does not know scores every build
  // zero instead of failing: a typo came back as a 200 from /api/sheet and,
  // from the optimizer, as a finished search over nothing whose envelope
  // recorded the typo. The goals are the engine's own list; anything else is
  // the caller's mistake and is told so before a fight is played for it. The
  // same goes for an `exclude` that is not a regex, which would otherwise
  // surface as a SyntaxError out of the worker.
  function checkOptions(options) {
    if (options.goal != null && !GOALS.includes(options.goal)) {
      throw new ApiError(400, `unknown goal "${options.goal}" - one of ${GOALS.join(', ')}`);
    }
    if (options.exclude != null) {
      try { new RegExp(options.exclude); } catch (e) {
        throw new ApiError(400, `options.exclude is not a valid regex: ${e.message}`);
      }
    }
    // The three the infusion search reads. optimize() drops an infusion id it
    // does not know from the offered list without a word, and takes any string
    // as a stat policy - so a typo was a search over fewer sets, or one that
    // lit no bonus line, with nothing to say so. Named here instead, in the
    // catalog's own vocabulary.
    if (options.infusions != null) {
      const v = options.infusions;
      const unknown = Array.isArray(v) ? v.filter((id) => !eng.cat.infusions.has(id)) : [];
      if (!(v === 'learnable' || v === 'all' || v === 'none' || (Array.isArray(v) && !unknown.length))) {
        throw new ApiError(400, 'options.infusions must be "learnable", "all", "none" or a list of infusion ids'
          + (unknown.length ? ` - not an infusion: ${unknown.map((x) => JSON.stringify(x)).join(', ')}` : '')
          + ` (known: ${[...eng.cat.infusions.keys()].join(', ') || 'none on this build'})`);
      }
    }
    if (options.infusionStat != null) {
      const stats = infusionStats();
      if (!(options.infusionStat === 'none' || options.infusionStat === 'best' || stats.includes(options.infusionStat))) {
        throw new ApiError(400, `options.infusionStat must be "none", "best" or a bonus rating (${stats.join(', ') || 'none on this build'})`
          + `, not ${JSON.stringify(options.infusionStat)}`);
      }
    }
    if (options.includeUnreleased != null && typeof options.includeUnreleased !== 'boolean') {
      throw new ApiError(400, `options.includeUnreleased must be true or false, not ${JSON.stringify(options.includeUnreleased)}`);
    }
    // THE NUMBERS THE FIGHT IS BUILT FROM. Each went from request JSON
    // straight into arithmetic: a `targetLevel` of "abc" came back as a 200
    // with `dps: null` and an empty damage table (and started a search over
    // it), -3 as a foe that mitigates almost nothing, a `targets` of "x" as
    // a sheet BELOW one target's, a `rank` of 2.5 or -1 as a number between
    // two ranks or under the first, and a `lookahead` or `mix` that is not a
    // number as the default with nothing said. The CLI refuses every one of
    // these on its own flags; the rules here are the same ones, in the
    // contract's words.
    const number = (name, ok, want) => {
      const v = options[name];
      if (v == null) return;
      if (typeof v !== 'number' || !Number.isFinite(v) || !ok(v)) {
        throw new ApiError(400, `options.${name} must be ${want}, not ${JSON.stringify(v)}`);
      }
    };
    number('targetLevel', (v) => v > 0, 'a positive number - the level the target stands at - or null for the one its name implies');
    number('targets', (v) => Number.isInteger(v) && v >= 1, 'a whole number of enemies, 1 or more');
    // (The skill tooltip's rule, which was checked there and nowhere else.)
    number('rank', (v) => Number.isInteger(v) && v >= 0, 'a whole number');
    number('lookahead', (v) => v >= 0, 'a number of seconds, 0 or more');
    number('mix', (v) => v >= 0 && v <= 1, 'a number from 0 to 1');
  }

  // --- an infusion pin without its piece ---------------------------------------
  // `pins.infusions` lists the slots whose INFUSION the search must keep as
  // the seed states it. An infusion is a field of the piece - `this.infusion`
  // and `this.infusionBonusStat` on the st.item.Gear instance
  // (st.item.Gear.isInfusionBonusActive@9766 ops 0-5) - so it can only be
  // held on a piece that is held, and the model's own callers cannot say
  // otherwise: the CLI's infusion pin is the `~` part of a gear pin, and
  // optimize()'s default for the set is `pinnedGear` itself. A slot named
  // here and not in `pins.gear` is neither case, and optimize() does not
  // check: the slot stays in its free gear list, every trial swaps the piece
  // in bare (`carried` is null for a slot in the set), and the infusion plan
  // skips the slot (`freeInfusable`) - so the slot the caller asked to keep
  // infused was the one slot the answer left bare, and a search with the pin
  // scored BELOW the same search without it. Refused instead, naming the
  // slot. A list that is not a list is refused for the same reason the
  // options are: the worker read it as "no list sent" and held every pinned
  // piece's infusion.
  function checkPins(pins) {
    if (pins?.infusions == null) return;
    if (!Array.isArray(pins.infusions) || pins.infusions.some((s) => typeof s !== 'string')) {
      throw new ApiError(400, `pins.infusions must be a list of slot ids, not ${JSON.stringify(pins.infusions)}`);
    }
    const held = new Set(Array.isArray(pins.gear) ? pins.gear : []);
    const loose = pins.infusions.filter((s) => !held.has(s));
    if (loose.length) {
      throw new ApiError(400, `pins.infusions names ${loose.join(', ')}, which pins.gear does not: an infusion is `
        + 'part of the piece that carries it, so it can only be held on a slot whose piece is held - pin the piece too, '
        + 'or leave the slot out and its infusion is the search\'s');
    }
  }

  // --- a build the game would refuse ------------------------------------------
  // Two rules, both the model's own sentences: a two-hander with something in
  // the off hand (`illegalReason`), and an infusion that is not one or sits on
  // a piece the game will not infuse (`infusionIllegalReason` -
  // $HInfusion.canBeInfused@21689). `engine.evaluate` throws on either; asked
  // here first, the answer is the `illegal` sentence a page renders in place
  // of a sheet rather than an error it can only toast.
  const illegalBuild = (cat, loadout) => illegalReason(cat, loadout) ?? infusionIllegalReason(cat, loadout);

  // --- POST /api/sheet ------------------------------------------------------

  function sheet(body) {
    if (!body?.loadout) throw new ApiError(400, 'body needs a loadout');
    const options = body.options ?? {};
    checkOptions(options);
    const engine = engineFor({
      targets: options.targets ?? 1,
      fight: options.fight ?? 200,
      lookahead: options.lookahead ?? 0,
    });
    let loadout;
    try {
      loadout = sanitizeLoadout(engine, body.loadout);
    } catch (e) { throw new ApiError(400, String(e.message ?? e)); }

    const bad = illegalBuild(engine.cat, loadout);
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

    return buildView({ engine, icons, loadout, ev, options, gameText });
  }

  // --- the weapon upgrade rider ---------------------------------------------
  // A weapon carries its `<Type>_Upgrade` skill once it has enough stars, and
  // the tooltip has to print the SAME number the sheet already applies - so
  // both the unlock and the rank come from engine.mjs's derivation rather than
  // a second rule invented here:
  //
  //   * unlock at stars >= GearUpgrades.SkillUnlockLevel (3), read from the
  //     constant (Weapon.getWeaponUpgradeSkill@9837 gates on it);
  //   * rank = the ROLLED RARITY's index, NOT stars-1 - Weapon.updateInf@9829
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
    // A level is a number or absent. A string here used to bake to
    // `iLevel: null` with an empty stat block and a 200.
    const levelOf = (v, what) => {
      if (v == null) return null;
      if (!(Number.isFinite(v) && v >= 1)) {
        throw new ApiError(400, `${what} must be a level (1 or more), not ${JSON.stringify(v)}`);
      }
      return v;
    };
    const charLevel = levelOf(body.charLevel, 'charLevel') ?? eng.ctx.consts.maxLevel;
    const instLevel = levelOf(body.level, 'level');
    if (body.rarity != null && !cat.rarityOrder.has(body.rarity)) {
      throw new ApiError(400, `unknown rarity "${body.rarity}"`);
    }
    // Only a weapon's rarity is the instance's to state (see `rarityChoices`);
    // anything else is priced at the rarity its row authors, which is the same
    // clamp sanitizeLoadout applies - so a tile's tooltip and the sheet agree.
    const rarity = cat.isWeaponType(item.type) ? (body.rarity ?? item.rarity) : item.rarity;
    const maxStars = cat.maxStars(item, rarity);
    const stars = clampStars(body.stars, maxStars);
    const socketed = body.augments ?? [];

    // The bake prices at the item's full-value slot: a shield lists
    // Slot_Weapon2 first and taking slots[0] prices it at 40%.
    const bakeSlot = item.slots.find((s) => (cat.slotById.get(s)?.affixFactor ?? 1) === 1)
      ?? item.slots[0];
    const opts = {
      aptitude: cls.aptitude, charLevel, rarity, stars,
      flawless: false, level: instLevel, socketed,
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
      // (WP + the attribute keep of the mean of the item's aptitude primaries
      // at the trained level), spread by WeaponAttack_RandomRange. The
      // primaries' BUDGETS stand in for the attributes here - an item in a
      // bag has no wearer - and the keep is damage.mjs's own, off the
      // WeaponPower row's ItemScaling flag. Best effort by contract: a
      // fragile lookup omits the line, it never crashes the tooltip.
      try {
        const chain = plan.baseChain(item);
        const prof = combat.profile(chain.links[0], 1, null, plan.wieldOf(wl));
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
            const amount = ratio * (weaponPower + combat.scaling.weaponPowerKeep * mean);
            const range = eng.ctx.consts.weaponAttackRandomRange ?? 0.1;
            damageLine = `≈${Math.round(amount * (1 - range))}–${Math.round(amount * (1 + range))} per swing`;
          }
        }
      } catch { damageLine = null; }
    }

    // --- the infusion a piece carries -----------------------------------------
    // THE GAME'S OWN BLOCK, as its item tooltip builds it (ui.TipItem.init@15947,
    // src/ui/Tooltip.hx:412-419 and :530):
    //
    //   ops 980-1013   when the instance's `infusion` is set, one line:
    //                  `Texts.infusion.item_effect({skill: infusion})` -
    //                  "Infused with [<skill id>]", and the link names the skill;
    //   ops 1014-1067  when its `infusionBonusStat` is set, a block titled
    //                  `Texts.infusion.infusion_bonus({faction:
    //                  $HItem.getFactionOrigin(item)})` - "Infusion bonus
    //                  ([<the PIECE's faction origin>])", not the infusion's;
    //   ops 1068-1124  under it, the affix line of
    //                  st.item.Gear.getInfusionBonusAffix@9767, which is an
    //                  ordinary `TAttribute_Flat` affix on the rolled rating
    //                  (its ops 34-52) printed by the affix row's template -
    //                  `affixLine` above;
    //   ops 1914-1926  the block gets the class `active` exactly when
    //                  st.item.Gear.isInfusionBonusActive@9766 holds - the bonus
    //                  is SHOWN on a piece that is not paid it, and dimmed.
    //
    // NOT ALL OF IT IS SERVED HERE. Right after the bonus block the same
    // function builds a third element (ops 1125-1174,
    // Tooltip.hx:421-422): when `infusion` is set, a `flow` of class
    // "infusion-set-info" holding one "infusion-skill-desc" component (both
    // string constants of the function) made from `Data.skill.byId.get(infusion)` and
    // kept as `this.infusionDetails` - ui.win.InfusionSkillDesc, the SET
    // LADDER ("(2) Set ... (4) Set ... (6) Set"), the component whose lines
    // /api/tooltip/skill prints for an infusion, here with the class
    // "compact" (ops 1853-1859).
    // It lights the rank of the hero LOOKING at the tooltip
    // (ui.win.InfusionSkillDesc.init@15957 ops 2-12: `myHero.getInfusionStacks(id)`),
    // not anything the item knows - and this route is asked about an item,
    // with no build to count pieces from. So the ladder is deliberately left
    // to /api/tooltip/skill, which takes the loadout and returns those lines
    // at the build's set rank; `infusion.id` below is what to ask it with.
    // A page that wants the game's whole tooltip prints the two together.
    //
    // So `infusionBonus` is present whenever a roll is stated and `active`
    // says whether the sheet pays it; a page that hid a dark line would hide
    // the one thing the player has to fix. The VALUE is the catalog's
    // (`cat.infusionBonus`, read off the same function) at this instance's
    // level, stars and sockets. Nothing of the block goes into `affixes`,
    // which stays the piece's own lines.
    //
    // A piece the game will not infuse returns no block and says why in
    // `notInfusable`; an `infusion` the catalog does not know is the caller's
    // typo and a 400. So is an `infusionStat` that is not a bonus rating -
    // the same refusal, with the same list, `sanitizeLoadout` gives a gear
    // entry (view.mjs `infusionRatings` has the reads): the line it asks for
    // is worth 0 whatever the piece, and was served as an ACTIVE "+0" with a
    // note about the piece's roll pool, which is not what is wrong with it.
    for (const [what, v] of [['infusion', body.infusion], ['infusionStat', body.infusionStat]]) {
      if (v != null && typeof v !== 'string') {
        throw new ApiError(400, `${what} must be an id, not ${JSON.stringify(v)}`);
      }
    }
    if (body.prismatic != null && typeof body.prismatic !== 'boolean') {
      throw new ApiError(400, `prismatic must be true or false, not ${JSON.stringify(body.prismatic)}`);
    }
    if (body.infusion && !cat.infusions.has(body.infusion)) {
      throw new ApiError(400, `unknown infusion "${body.infusion}"`
        + ` (known: ${[...cat.infusions.keys()].join(', ') || 'none on this build'})`);
    }
    if (body.infusionStat && !infusionStats().includes(body.infusionStat)) {
      throw new ApiError(400, `infusionStat ${JSON.stringify(body.infusionStat)} is not an infusion bonus rating - `
        + `the bonus line is one of ${infusionStats().join(', ') || 'none on this build'} (the rows of the `
        + 'InfusionBonus aptitude), and the game pays nothing for any other');
    }
    const infusable = cat.canInfuse(item);
    const origin = infusable ? cat.factionOrigin(item) : null;
    const carried = infusable ? {
      infusion: body.infusion || null, infusionStat: body.infusionStat || null, prismatic: !!body.prismatic,
    } : { infusion: null, infusionStat: null, prismatic: false };
    const levelOpts = { charLevel, stars, rarity, flawless: false, level: instLevel, socketed };
    const pool = infusable ? cat.infusionBonusPool(item) : [];
    const bonusLine = (stat, v) => affixLine(cdb, { ref: 'TAttribute_Flat', val: v, target: { attribute: stat } })
      ?? `${v > 0 ? '+' : ''}${v} ${attrName(stat)}`;
    let infusionBlock = null;
    if (carried.infusion) {
      const entry = infusionEntry(carried.infusion);
      const tmpl = groupText(cdb, 'infusion', 'item_effect');
      infusionBlock = {
        ...entry,
        text: tmpl ? fillLinks(cdb, tmpl.replace('::skill::', carried.infusion)) : null,
      };
    }
    let infusionBonus = null;
    if (carried.infusionStat) {
      const value = cat.infusionBonus(item, carried.infusionStat, levelOpts);
      const active = cat.infusionBonusActive(item, carried);
      const tmpl = groupText(cdb, 'infusion', 'infusion_bonus');
      const inf = carried.infusion ? cat.infusions.get(carried.infusion) : null;
      // What to say beside a stated roll: the two ways it pays nothing, and
      // the one where it is paid although the piece should not have rolled it.
      // The last is only ever said of a REAL bonus rating - anything else was
      // refused above - so "the game removes the ratings a piece already
      // pays" is the whole reason the rating is missing from the pool
      // ($HInfusion.pickInfusionBonusStat@21694 ops 4-25).
      const note = !carried.infusion ? 'dark - the piece is not infused, and the bonus is paid only while it is'
        : !active ? `dark - ${inf.name}'s faction is ${factionName(cdb, inf.faction)} and this piece's is `
          + `${factionName(cdb, origin)}: only a piece of the infusion's own faction, or a Prismatic one, is paid its bonus line`
          : !pool.includes(carried.infusionStat)
            ? `priced as stated - ${attrName(carried.infusionStat)} is not a rating this piece is expected to roll `
              + `(${pool.map(attrName).join(', ') || 'none'}): the game removes the ratings a piece already pays before it rolls`
            : null;
      infusionBonus = {
        title: tmpl ? fillLinks(cdb, tmpl.replace('::faction::', origin)) : null,
        stat: carried.infusionStat,
        name: attrName(carried.infusionStat),
        value,
        display: bonusLine(carried.infusionStat, value),
        active,
        prismatic: carried.prismatic,
        note,
      };
    }

    const rarityRow = cdb.byId('rarity').get(rarity);
    const atlas = icons.atlasFor(item.id);
    const rel = cat.release(item);
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
        charLevel, stars, rarity, level: instLevel, socketed,
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
      factionName: factionName(cdb, item.faction),
      // Where the row comes from, by the catalog's source reader, and - when a
      // character of `charLevel` is not offered it - why (the same test and
      // the same sentence as /api/catalog's `withheld`).
      source: { state: rel.state, why: rel.why },
      withheld: withheldReason(cat, item, charLevel),
      infusable,
      notInfusable: infusable ? null : cat.whyNotInfusable(item),
      infusion: infusionBlock,
      infusionBonus,
      // What the bonus line would be worth on THIS instance for each rating
      // it can have rolled - the number moves with the level and the stars.
      infusionPool: pool.map((stat) => ({
        stat, name: attrName(stat), value: cat.infusionBonus(item, stat, levelOpts),
      })),
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

  // --- which rank a row is described at -------------------------------------
  // FOUR SYSTEMS SHARE THE WORD. The data keeps three of them apart by the
  // row's own `type`; the fourth has none and is known by what it is:
  //
  //   mastery   a weapon skill's rank, 1..WeaponSkill_MaxRank - the `rank` a
  //             request carries, and the only one a client can sensibly send
  //             as a blanket value;
  //   talent    a `Talent` row's rank is the POINTS in that node, 1 or 2
  //             (`props.talent.maxPoints`);
  //   infusion  an `InfusionPassive` row's rank is how many set thresholds the
  //             worn pieces reach - `$HInfusion.getRankFromStacks@21691`
  //             counts the `Item_InfusionCaps` entries (2, 4, 6) that are not
  //             above the stack count;
  //   upgrade   a weapon's `<Type>_Upgrade` passive (the twenty rows
  //             `cat.upgradableTypes` names) is ranked by the RARITY the
  //             weapon rolled: st.item.Weapon.getWeaponUpgradeSkill@9837
  //             hands the skill out at `rank = inf.rarity.index` (ops 31-35)
  //             once `upgradeLevel >= GearUpgrades.SkillUnlockLevel` (ops
  //             0-8). It is the rule `upgradeRider` above already prices the
  //             item tooltip's rider by, and it was missing HERE: these rows
  //             fell through to mastery, so a Legendary sword's passive was
  //             described at the blanket rank 3 - "6% chance to attack twice"
  //             beside an item tooltip that said 7%, and a Rare one's 5% read
  //             6% too.
  //
  // A STATUS row has no type; it is read at the rank of whatever applies it,
  // which is how skills.mjs resolves a talent's statuses (`statusesOf(id,
  // {rank: nodeRank})`) - so the tooltip and the sheet agree. Reading every
  // row at the client's mastery rank asked a one-point talent's poison whether
  // it was at rank 3: its affixes are `conds.maxRank: 1`, they dropped out,
  // and the sentence came back "reducing Magic Resistance by ?".
  //
  // With a loadout the rank is the BUILD's (points held, pieces worn, the
  // rarity of the weapon held; a node not taken reads as its first point).
  // Without one, a `rank` the request names is taken in the row's own system
  // and clamped to it.
  const skillType = (row) => eng.cdb.enumName('skill', 'type', row?.type) ?? null;
  const talentMax = (row) => Math.max(1, row?.props?.talent?.maxPoints ?? 1);
  // A loud failure by design if the constant is gone: it is only asked for
  // once an InfusionPassive row exists to be described.
  const infusionCaps = () => eng.cdb.constantFloats('Item_InfusionCaps');
  // Pieces are counted off `gear[slot].infusion`, the field a gear entry
  // carries its infusion in, BY THE ENGINE'S OWN COUNTER - loadout.mjs
  // `infusionSets`, one per worn piece per infusion id, as
  // ent.Hero.refreshInfusions@7739 counts - so a tooltip's set rank and the
  // sheet's cannot come apart.
  //
  // Only a piece the game lets carry an infusion counts
  // ($HInfusion.canBeInfused@21689: the type chain reaches Armor, the row's
  // rarity is at least Item_InfusionMinRarity's, and it has a faction origin -
  // catalog.mjs `whyNotInfusable` has the three tests). This file used to
  // apply them itself while it counted. It no longer has to: a loadout with an
  // infusion on a necklace, a green helmet or a factionless hood never
  // reaches a count - `illegalBuild` answers it with the rule it breaks.
  const infusionPieces = (loadout, id) => (loadout
    ? (infusionSets(eng.cat, loadout).find((s) => s.id === id)?.pieces ?? 0) : 0);
  const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.floor(Number(v) || 0)));

  // The upgrade passives, and the rank a build holds one at: the rarity index
  // of the first weapon - in the order engine.mjs reads the three weapon
  // slots - whose type's passive this is and whose stars have unlocked it; 0
  // when no held weapon carries it. Two weapons of one type each carry their
  // own copy at their own rarity; one tooltip describes one of them.
  const upgradeRows = new Set(eng.cat.upgradableTypes.values());
  const WEAPON_SLOT_IDS = ['Slot_Weapon1', 'Slot_Weapon2', 'Slot_OffhandWeapon'];
  const upgradeRankHeld = (loadout, id) => {
    for (const slotId of WEAPON_SLOT_IDS) {
      const g = loadout?.gear?.[slotId];
      const item = g?.item ? eng.cat.itemById.get(g.item) : null;
      if (!item || eng.cat.upgradeSkillFor(item) !== id) continue;
      if (!((g.stars ?? 0) >= skillUnlockLevel)) continue;
      return rarityIndex.get(g.rarity ?? item.rarity) ?? 0;
    }
    return 0;
  };
  // The lowest rank the passive can exist at: the first rarity whose star
  // allowance (`rarity.props.gearUpgrades`) reaches the unlock - Rare, index
  // 2, on this build. Common allows no stars and Uncommon two, so ranks 0 and
  // 1 are rows nothing can hold, and so is the rank past the last rarity
  // (the ladders run to a rank 5; there are five rarities, 0..4).
  const upgradeRankFloor = Math.max(1, eng.cdb.lines('rarity')
    .findIndex((r) => (r.props?.gearUpgrades ?? 0) >= skillUnlockLevel));

  // status id -> the Talent / InfusionPassive rows that apply it, from the
  // plan's own reader of steps AND scripts (most talents put their status up
  // from a script, which `texts.refs` only ever mentions). Built once: it is a
  // property of the data, not of a fight.
  let statusOwnerIndex = null;
  function statusOwners() {
    if (statusOwnerIndex) return statusOwnerIndex;
    statusOwnerIndex = new Map();
    for (const r of eng.cdb.lines('skill')) {
      const t = skillType(r);
      const top = t === 'Talent' ? talentMax(r)
        : t === 'InfusionPassive' ? infusionCaps().length : 0;
      for (let rank = 1; rank <= top; rank++) {
        let applied = [];
        try { applied = [...(eng.plan.statusesOf(r.id, { rank }).all ?? [])]; } catch { /* unreadable row */ }
        for (const st of applied) {
          const owners = statusOwnerIndex.get(st) ?? [];
          if (!owners.includes(r.id)) owners.push(r.id);
          statusOwnerIndex.set(st, owners);
        }
      }
    }
    return statusOwnerIndex;
  }

  function rankOf(row, loadout, asked) {
    const own = (r) => {
      const t = skillType(r);
      if (t === 'Talent') {
        const pts = loadout ? (loadout.talents?.[r.id] ?? 1) : (asked ?? 1);
        return { kind: 'talent', rank: clampInt(pts, 1, talentMax(r)) };
      }
      if (t === 'InfusionPassive') {
        const caps = infusionCaps();
        const rank = loadout
          ? caps.filter((c) => c <= infusionPieces(loadout, r.id)).length
          : clampInt(asked ?? 0, 0, caps.length);
        return { kind: 'infusion', rank };
      }
      if (upgradeRows.has(r.id)) {
        // Held at the weapon's rarity, or not held (0). Described no lower
        // than the first rarity that can unlock it, which is also where a
        // request with no build starts.
        const rank = loadout
          ? upgradeRankHeld(loadout, r.id)
          : clampInt(asked ?? upgradeRankFloor, upgradeRankFloor, rarityIndex.size - 1);
        return { kind: 'upgrade', rank, floor: upgradeRankFloor };
      }
      return null;
    };
    const mine = own(row);
    if (mine) return { ...mine, from: null };
    // A status takes its applier's rank. Three statuses have more than one
    // applier in the same tree (Sunlight's is put up by three Priest nodes);
    // the one this build holds is the one that put it there, else the first.
    const appliers = statusOwners().get(row.id) ?? [];
    const held = appliers.find((id) => (loadout?.talents?.[id] ?? 0) > 0
      || infusionPieces(loadout, id) > 0);
    const owner = skillRow(held ?? appliers[0]);
    if (owner) {
      const o = own(owner);
      // A status is only ever seen once something applied it, so an infusion
      // nobody wears still describes its status at the first set rank.
      return { kind: o.kind, rank: Math.max(1, o.rank), from: owner.id };
    }
    // The same default the sheet uses (options.rank ?? 3 = WeaponSkill_MaxRank):
    // mastery is assumed trained out, so a tooltip that omits the rank must not
    // quietly describe a weaker skill than the one being simulated.
    return {
      kind: 'mastery', from: null,
      rank: Math.max(1, asked ?? eng.ctx.consts.weaponSkillMaxRank),
    };
  }

  function tooltipSkill(body) {
    const row = skillRow(body?.skill);
    if (!row) throw new ApiError(400, `unknown skill "${body?.skill}"`);
    const options = body.options ?? {};
    checkOptions(options);
    // (`options.rank` is held to the same rule by checkOptions, for every route.)
    if (body.rank != null && !(Number.isInteger(body.rank) && body.rank >= 0)) {
      throw new ApiError(400, `rank must be a whole number, not ${JSON.stringify(body.rank)}`);
    }
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
      const bad = illegalBuild(engine.cat, loadout);
      if (bad) return { illegal: bad };
      // The RESTING sheet, which is what the game shows you standing still and
      // therefore what its tooltip reads - not the fight-averaged one.
      try {
        const got = restingSheet(engine, loadout, options);
        sheet = got.sheet;
        mixIds = got.mixIds;
      } catch (e) { throw new ApiError(400, String(e.message ?? e)); }
    }
    // The rank, in the row's own system - see `rankOf`. What the build HOLDS
    // can be 0: an infusion nobody wears, an upgrade passive no held weapon
    // has unlocked. The sentence is still the first one the row can have -
    // its first set line, the first rarity that unlocks the passive - so
    // everything below describes at `rank`, which is never under that floor,
    // and only `active` and the reported rank read `held`.
    const held = rankOf(row, loadout, body.rank ?? options.rank ?? null);
    const rank = Math.max(held.floor ?? 1, held.rank);
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
    // What the character holds, for the steps that ask about the weapon
    // (`cond.weapons.isRanged` - see `profile` in damage.mjs). No build, no
    // weapon: the melee reading, which is also the game's.
    const wield = loadout ? engine.plan.wieldOf(loadout) : null;
    const ownAt = (r) => ({
      ...(row.vars ?? {}),
      ...(engine.combat.profile(row.id, r, runes, wield)?.vars ?? {}),
    });
    const infAt = (r) => (x) => {
      const p = engine.combat.profile(x.id, r, runes, wield);
      return p
        ? { cooldown: p.cooldown, charges: p.charges, duration: p.duration }
        : { cooldown: x.cooldown, charges: x.props?.charges, duration: x.duration };
    };
    const prof = engine.combat.profile(row.id, rank, runes, wield);
    // Each rank line is priced AT ITS OWN RANK: the rank moves the scaling
    // conditions and a referenced status's `props.rankOverride` as well as the
    // vars, so rank 3's sentence has to read rank 3's steps.
    const notes = [];
    const fill = (text, r) => fillDesc(engine.cdb, text, {
      own: ownAt(r), skillRow: row, rank: r, runes,
      varsFor: (x) => engine.combat.profile(x.id, r, runes, wield)?.vars ?? x.vars ?? {},
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
    //
    // The top-level sentence is filled FIRST: every fill pushes what it could
    // not resolve onto `notes`, and `unresolved` below is read off that list -
    // derived before this fill it missed a token that resolves at rank 1 and
    // not at the rank asked, and a '?' came back beside an empty list.
    const desc = fill(row.texts?.desc, rank);
    const rankDescs = row.texts?.rankDescs ?? [];

    // AN INFUSION'S LADDER IS ITS SET BONUSES, as the game's own panel prints
    // them (ui.win.InfusionSkillDesc). The title of line r is
    // `text.infusion_rank` filled with `Item_InfusionCaps[r-1]` - "(2) Set",
    // "(4) Set", "(6) Set" (InfusionSkillDesc.getRankTitle@15961 ops 0-28). Its text is the
    // row's sentence for that rank (InfusionSkillDesc.getRankText@15962 ops 1-60) followed, one
    // per line, by each affix that STARTS there (ops 79-134): shown when
    // `conds.minRank == r`, or `conds.equalRank == r`, or - with neither
    // authored - when r is 1. `==`, not `>=`: an affix is printed once, on the
    // set that turns it on. All fifteen rows author an empty rank-2 sentence
    // and a `minRank: 2` affix, so without this the "(4) Set" line - the one
    // purely numeric bonus of every infusion - was an empty string the
    // front-end dropped, under lines numbered like weapon mastery.
    const isInfusion = skillType(row) === 'InfusionPassive';
    const setLine = (r, text) => {
      const startsAt = (c) => (c?.minRank != null ? c.minRank === r
        : c?.equalRank != null ? c.equalRank === r : r === 1);
      const lines = [text];
      for (const a of row.affixes ?? []) {
        if (!startsAt(a.conds)) continue;
        const line = affixLine(engine.cdb, a);
        if (line == null) {
          // affixLine gives up for three different reasons; say which.
          const why = typeof a.val !== 'number' ? 'the entry carries no value'
            : !(a.desc || engine.cdb.byId('affix').get(a.ref)?.desc) ? 'neither the entry nor its affix row authors a template'
              : 'its template uses a tag this reader does not format';
          notes.push({ token: `affix ${a.ref}`, why });
        }
        lines.push(line ?? MISS);
      }
      const cap = infusionCaps()[r - 1];
      const template = engine.cdb.byId('text').get('infusion_rank')?.value?.text;
      if (cap != null && !template) {
        notes.push({ token: 'text.infusion_rank', why: 'the game data has no such text row' });
      }
      return {
        desc: lines.filter(Boolean).join('\n'),
        // `Std.string` of the cap, which is a float: 2 prints "2".
        title: cap != null && template ? template.replace('::rank::', numText(cap)) : null,
        pieces: cap ?? null,
      };
    };
    const lineAt = (r, text, flags) => {
      const filled = fill(text, r);
      return {
        rank: r,
        ...(isInfusion ? setLine(r, filled) : { desc: filled }),
        active: held.rank >= r,
        // Never on a set line. Seven infusions author the flag on their
        // empty rank-2 SENTENCE (the Kobold and Crimson three, and
        // Infusion_Manfish_Tank), but the line built here is that sentence
        // plus the affix that starts at the set - for those seven, the only
        // statement of the "(4) Set" bonus anywhere in the answer - and the
        // panel that prints it does not consult the flag: InfusionSkillDesc.getRankText@15962
        // takes `rankDescs[rank - 2].desc` (ops 10-49) and reads `.flags`
        // nowhere. Copied across, it told a client to hide "+2.5% Critical
        // Chance".
        hiddenWhenMerged: !isInfusion && !!((flags ?? 0) & 1),
      };
    };
    // A row with no ladder has ONE line and it is the sentence at the rank
    // being described - not at rank 1. A talent holding two points, and a
    // status worn at rank 3, used to show their rank-1 numbers here beside a
    // top-level `desc` that said otherwise.
    const ranks = rankDescs.length
      ? [lineAt(1, row.texts?.desc, 0),
        ...rankDescs.map((rd, i) => lineAt(i + 2, rd?.desc, rd?.flags))]
      : [{ rank, desc, active: held.rank >= rank, hiddenWhenMerged: false }];

    // What could not be resolved, deduplicated by token. The UI can style
    // these rather than leave the reader guessing what a bare '?' meant, and
    // an empty list is the claim that every number in the sentence is real.
    const seen = new Set();
    const unresolved = notes.filter((n) => !seen.has(n.token) && seen.add(n.token));

    return {
      name: row.texts?.name ?? row.id,
      icon: skillIcon(row.id),
      desc,
      cooldown: prof?.cooldown ?? row.cooldown ?? 0,
      charges: (prof?.charges ?? 1) > 1 ? prof.charges : null,
      nature: eng.cdb.enumName('skill', 'nature', row.nature) ?? null,
      rank: held.rank,
      // Which of the four systems `rank` and `ranks[].rank` count in, and -
      // for a status - the row whose rank it borrowed.
      rankKind: held.kind,
      rankFrom: held.from,
      ranks,
      // `true` when the magnitudes are real numbers against the loadout that
      // was sent; `false` when they are the authored coefficients because no
      // loadout was.
      priced: !!sheet,
      rune: runes.size ? [...runes][0] : null,
      unresolved,
    };
  }

  // --- the optimizer: worker thread + SSE relay -----------------------------
  //
  // A Worker, not a spawned process. Spawning process.execPath launched a
  // SECOND Electron binary in the packaged app, and on some machines it died
  // in Chromium's ICU bootstrap (exit 0x80000003, "Invalid file descriptor to
  // ICU data received") before running any of our code - see the header of
  // ui/optimize-worker.mjs. A worker needs no execPath and inherits no handle.
  //
  // Everything the UI can observe is unchanged: /api/optimize/start still
  // answers {job}, the SSE stream still carries progress/done/error, and
  // /api/optimize/cancel still ends the search - terminate() is the kill.

  const jobs = new Map();
  let jobSeq = 0;
  let runningJob = null;

  function killJob(job, reason) {
    if (!job || job.done) return;
    // Marked done BEFORE the terminate so the 'exit' it provokes reads as
    // expected rather than reporting a second, contradictory error.
    job.done = true;
    endWorker(job);
    pushEvent(job, 'error', { error: reason });
  }

  // terminate() rejects only if the thread is already gone, which is the
  // outcome being asked for.
  function endWorker(job) {
    try { job.worker.terminate().catch(() => {}); } catch { /* already gone */ }
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
    // Checked BEFORE the running search is superseded: a request that is
    // refused must not cost the user the search they already had going. That
    // means everything the worker would refuse before its first evaluation,
    // not only the options: it sanitises the loadout and resolves the target
    // before it searches, and a loadout with no level - or a target nothing
    // names - used to come back as a 200 and a job whose only event was the
    // refusal, after the search it replaced had already been killed. So both
    // are run here first, on a COPY (sanitizeLoadout mutates, and the worker
    // is sent the loadout as the client wrote it); neither reads a fight
    // option, so the default engine answers for the worker's own.
    const options = body.options ?? {};
    checkOptions(options);
    checkPins(body.pins);
    try {
      const probe = sanitizeLoadout(eng, structuredClone(body.loadout));
      eng.combat.foe(options.target ?? 'boss', probe.level, options.targetLevel ?? null);
      // ...and a seed the game would refuse outright. The search evaluates
      // its seed before anything else, and that evaluation throws on a
      // two-hander with a filled off hand, on an infusion the catalog does
      // not know and on one written on a piece that cannot carry it - the
      // refusals /api/sheet returns as `illegal`. An illegal off hand was
      // still a 200 here, a job whose one event was "loadout: ... uses both
      // hands", and the running search gone.
      const bad = illegalBuild(eng.cat, probe);
      if (bad) throw new Error(bad);
    } catch (e) { throw new ApiError(400, String(e.message ?? e)); }
    // One search at a time: a second start supersedes the first.
    if (runningJob && !runningJob.done) killJob(runningJob, 'superseded by a new optimize');

    const id = 'j' + (++jobSeq);
    // A file: URL, not a path string: the packaged bench is unpacked under a
    // temp resources directory and either that or a dev clone can contain a
    // space. The whole job travels in workerData - there is no stdin to race.
    const worker = new Worker(pathToFileURL(join(benchRoot, 'ui', 'optimize-worker.mjs')), {
      workerData: {
        benchRoot, game,
        loadout: body.loadout,
        pins: body.pins ?? {},
        options: { ...(body.options ?? {}), version },
      },
      // Captured rather than printed, as the child's was: a worker that dies
      // without a message leaves its last line as the only account of why.
      stderr: true,
    });
    const job = {
      id, worker, t0: Date.now(),
      events: [], subscribers: new Set(), done: false, stderr: '',
    };
    jobs.set(id, job);
    runningJob = job;

    // Must be drained even though nothing is expected on it: an unread worker
    // stderr fills and then blocks the thread writing to it.
    worker.stderr.on('data', (c) => { job.stderr = (job.stderr + c).slice(-4000); });

    worker.on('message', (msg) => {
      // Messages already in the port when a job was cancelled still arrive.
      if (job.done) return;
      if (msg?.type === 'progress') {
        pushEvent(job, 'progress', {
          evals: msg.evals, elapsed: (Date.now() - job.t0) / 1000,
        });
      } else if (msg?.type === 'done') {
        pushEvent(job, 'done', {
          envelope: msg.envelope, view: msg.view, search: msg.search,
          score: msg.score, elapsed: msg.elapsed,
        });
        endWorker(job);
      } else if (msg?.type === 'error') {
        pushEvent(job, 'error', { error: msg.error });
        endWorker(job);
      }
    });
    // Anything the worker's own catch cannot see - a failed module load, a
    // throw after the search returned. The message, never the stack: this
    // string is rendered as a sentence in the UI's error card.
    worker.on('error', (err) => {
      if (job.done) return;
      pushEvent(job, 'error', { error: String(err?.message ?? err) });
    });
    // The backstop, and the reason a job can never hang: however the thread
    // ends, it ends here, and a job with no answer yet gets one.
    worker.on('exit', (code) => {
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

  // --- a file the page uploaded, and the class and level beside it ----------
  // One reader for both routes that take a file (/api/import and
  // /api/submit/preview), so the two cannot come to take a file, or refuse
  // one, two ways.

  // A refused value as the sentence quotes it: short, and as JSON.
  const quoted = (v) => String(JSON.stringify(v ?? null)).slice(0, 60);

  // {name, text} or {name, base64}, as {name, data} - data the text, or the
  // bytes. Absent is null, for the caller to say what is missing in its own
  // words. `what` is the field's name in the sentences (`file`, `log`, ...).
  function parseFilePart(part, what) {
    if (part == null) return null;
    if (typeof part !== 'object' || Array.isArray(part)) {
      throw new ApiError(400, `${what} must be a file: {name, text} with the file as text, or {name, base64} with its bytes - not ${quoted(part)}`);
    }
    if (part.name != null && typeof part.name !== 'string') {
      throw new ApiError(400, `${what}.name must be the file's name, not ${quoted(part.name)}`);
    }
    const hasText = typeof part.text === 'string';
    const hasBytes = typeof part.base64 === 'string';
    if (hasText === hasBytes) {
      throw new ApiError(400, hasText
        ? `${what} carries both text and base64 - send one of them`
        : `${what} needs its content: text (the file as a string) or base64 (its bytes)`);
    }
    if (hasText) return { name: part.name ?? null, data: part.text };
    // Buffer.from skips what is not base64 without a word, which would hand
    // the reader a file nobody sent.
    const b64 = part.base64.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(b64)) throw new ApiError(400, `${what}.base64 is not base64`);
    return { name: part.name ?? null, data: Buffer.from(b64, 'base64') };
  }

  // The class and level a file that does not say them is taken to be - the
  // modkit dump names neither - read off `obj.class` and `obj.level`; each
  // null when not given. `prefix` is where they stand in the body ('' for
  // /api/import, 'sheetOptions.' for the preview). The range is readSheet's
  // to judge, in its own sentence; the TYPE is this reader's, since readSheet
  // is also handed a level it does not use (a sheet that names its own) and
  // would print an object as "[object Object]" in the note that says so. A
  // level is a whole number, or its digits as a string (what a form field
  // holds); an empty field is none.
  function parseClassLevel(obj, prefix) {
    const cls = obj?.class == null || obj.class === '' ? null : obj.class;
    if (cls != null && typeof cls !== 'string') {
      const classes = eng.cat.classes;
      throw new ApiError(400, `${prefix}class must be a class id - a unit id (${classes.map((c) => c.unit).join(', ')}) `
        + `or an aptitude id (${classes.map((c) => c.aptitude).join(', ')}) - not ${quoted(obj.class)}`);
    }
    const level = obj?.level == null || obj.level === '' ? null : obj.level;
    if (level != null && !Number.isInteger(level) && !(typeof level === 'string' && /^\s*\d+\s*$/.test(level))) {
      throw new ApiError(400, `${prefix}level must be a character level - a whole number, or left out - not ${quoted(obj.level)}`);
    }
    return { cls, level };
  }

  // --- POST /api/import -------------------------------------------------------
  // A character file the user picked or dropped on the page, read by the ONE
  // reader behind `bench import` and `--import` (src/charsheet.mjs readSheet):
  // the documented character sheet, a build the bench saved, a bare loadout,
  // or the modkit's inventory dump. The page and the CLI therefore cannot come
  // to read one file two ways, and the report the page prints is the CLI's
  // own lines (`reportItems`: each line with the kind the reader gives it),
  // not a second wording of the same fields.
  //
  // What comes back is a build the page can install as it is: readSheet
  // guarantees sanitizeLoadout removes nothing from `loadout` and neither
  // illegality asker objects, and `pins` is what the file RECORDED - a slot
  // it left out stays open to the search, a slot it wrote null stays empty.
  //
  // The only refusals are readSheet's own sentences (not JSON, none of the
  // four shapes, a newer version, a class or level that is not one) and a body
  // that does not carry a file. One of them is a question rather than a
  // verdict: the modkit dump never names the class, so that refusal carries
  // the reader's facts (classAsked), and the page asks and sends the same file
  // again.
  function importSheet(body) {
    const file = parseFilePart(body?.file, 'file');
    if (!file) throw new ApiError(400, 'body needs a file: {name, text} with the file as text, or {name, base64} with its bytes');
    const input = file.data;
    const { cls, level } = parseClassLevel(body, '');

    let r;
    try {
      r = readSheet(eng, input, { cls, level });
    } catch (e) {
      if (!(e instanceof SheetError)) throw e;
      throw new ApiError(400, e.message, classAsked(e));
    }
    const items = reportItems(r);
    return {
      format: r.format,
      version: r.version,
      name: r.name,
      unit: r.unit,
      aptitude: r.aptitude,
      level: r.level,
      rank: r.rank,
      loadout: r.loadout,
      pins: r.pins,
      // Of each piece, what the FILE stated (the loadout fills in what it
      // left open): the page sends it back with the build in the editor for
      // the pieces it still holds as imported (/api/submit/preview).
      pieces: recordedPieces(r),
      report: items.map((i) => i.text),
      reportItems: items,
      dropped: r.dropped,
      notes: r.notes,
      gaps: r.gaps,
      unknownKeys: r.unknownKeys,
      unreadable: r.unreadable,
      buildMismatch: r.buildMismatch,
      observed: r.observed,
      source: r.source,
    };
  }

  // The reader's "which class?" as data (charsheet.mjs SheetError's facts,
  // which buildSubmission passes on): `needs: "class"`, the name the file
  // carries (`character`) and the classes every weapon it lists allows
  // (`classes`). The page words its own question from them - the reader's
  // sentence names the CLI's --class - and offers the first of `classes`.
  // null for any other refusal: the reader says when it is the question.
  function classAsked(e) {
    if (e?.needs !== 'class') return null;
    return {
      needs: 'class',
      character: typeof e.character === 'string' && e.character !== '' ? e.character : null,
      classes: Array.isArray(e.classes) ? e.classes.filter((u) => typeof u === 'string') : null,
    };
  }

  // --- POST /api/submit/* -------------------------------------------------------
  // "Send a fight": a combat log and the build it was fought in, packed by
  // src/submit.mjs - the module behind `bench submit` - and uploaded to the
  // project's folder on pCloud only on the Send click. The packing, the
  // names removed, the manual route's title and every sentence are that
  // module's, so the page and the CLI cannot pack or describe one fight two
  // ways.
  //
  // THE FILES TRAVEL ONCE. The page uploads them to /preview; the bundle made
  // from them is held here, under a random previewId, and every later route
  // names it by that id and takes nothing else - no file, no path, no
  // address. What /send sends is therefore the bundle the player looked at,
  // byte for byte, and the only one who can send it is a page that READ the
  // preview's answer: the bench's own page, since the server's guard keeps
  // every other page from reading anything here (ui/server.mjs).
  //
  // THE NETWORK. /send and /delete are the only routes of this server that
  // reach the network, through src/submit.mjs's sendSubmission (the zip, to
  // the project's pCloud folder) and deleteSubmission (a request for a sent
  // fight's deletion, to the same folder). The suite holds each to its own
  // `case` below: the two handlers are called from those cases and nowhere
  // else (API.md pitfall 22 says what that reader of the source needs of
  // them).
  //
  // HELD, AND SENT ONCE. A preview is kept 30 minutes and at most 8 are kept
  // (each holds its zip, up to 25 MB). A send pCloud confirms consumes it; a
  // send that failed keeps it, so "Send again" sends the SAME bundle - same
  // id, same delete token, same bytes. pCloud keeps every upload (a second
  // one under a name it holds is renamed beside the first), so if the first
  // did arrive the folder holds two identical copies under one id, and the
  // maintainer drops one. A failure after the request left hands the page
  // the receipt as well: the fight may have arrived, and that receipt is
  // the only way to ask for its deletion.
  //
  // ONE SUBMISSION, HOWEVER MANY SENDS. A preview whose send may have
  // arrived is never dropped to make room for a newer one, and its 30
  // minutes count from the last try - "Send again" has to find it. When it
  // is gone all the same (the bench restarted), /preview builds it again
  // from a receipt (`again`), which goes to buildSubmission whole (its
  // `receipt`, as `bench submit --receipt` gives it): its id, delete token,
  // time, SHA-256, sentAt and link, so the same files make the same zip,
  // byte for byte, on the game build and bench version it was made on - and
  // anything else is refused, since one id names one bundle - and a send of
  // it puts at most an identical copy beside the first rather than a second
  // fight.
  //
  // THE RECEIPT IS KEPT BEFORE A BYTE LEAVES. A send whose answer is lost -
  // a timeout, a dropped connection, or the window closed while it waits,
  // which in the app ends this server too - may still have put the fight in
  // the folder. So /send writes the receipt into the bench's own folder (see
  // receiptFolder) before it sends, as `bench submit --send` writes its own
  // (beside the zip, or with no --zip in this same folder), and replaces it
  // with the completed one (its sentAt set) after; a folder it cannot write
  // refuses the send. /receipts lists that folder, so a receipt nobody
  // saved is in front of the player the next time the dialog opens, and
  // /delete forgets the kept copy once the request for its deletion is in
  // the folder. "Save receipt" is still where a player keeps their own: the
  // folder is the bench's cache. A receipt holds the delete token, and
  // whoever reads it can ask for the fight's deletion, so it is written for
  // this account alone - the file 0600, a folder it makes 0700 - which keeps
  // the files at rest from the other accounts on Linux and macOS, where
  // `node ui/server.mjs` is how the UI runs and a default write is readable
  // by every local account. That is all the modes do: while this server
  // runs, any program on this machine that can reach 127.0.0.1 - another
  // account's included - can ask /receipts for the kept receipts, their
  // tokens with them. One more reason the server listens on loopback only,
  // and Send a fight is off on any other --host (ui/server.mjs).
  //
  // A DELETION IS A REQUEST. An uploader can delete nothing behind the
  // link: /delete uploads <id>.withdraw.json, the receipt's id and token,
  // and the maintainer deletes the fight and the request when they next
  // read the folder. Asked through this copy's own link only - the module's
  // rule (deleteSubmission), which `bench submit --delete` asks too.
  //
  // WHAT IS NOT SENT is the module's to say (sendRefusal), the rule `bench
  // submit --send` asks, and this server keeps no rule of its own: the
  // preview says its sentence as `sendRefused`, and /send refuses it (409)
  // before anything is written or sent. Save .zip still saves the bundle,
  // as --zip does. Three things are refused:
  //
  //   - a bundle built again from a receipt whose fight arrived (`again`
  //     with its sentAt set): sent again, it would only be stored as a
  //     second copy beside the first;
  //   - a bundle built again from a receipt written for another upload link
  //     than this copy's, or when this copy has none: it is sent again where
  //     it may already be, or not at all;
  //   - a sheet of another class than the log's: sent, it would be the
  //     project's evidence for the wrong build - unless the module decided,
  //     building it, that the class given beside the file
  //     (`sheetOptions.class`, what --class is to the CLI) names the class
  //     the file names itself, which says the log's header is the one that
  //     is wrong. A modkit dump, whose only class is the one chosen for it,
  //     and the build in the editor are never vouched for.
  //
  // THE BUILD IN THE EDITOR goes as what the editor STATED: its loadout with
  // the page's pins, written by the module (buildSubmission's editor input,
  // charsheet.mjs pinnedSheet) by the rule `bench submit` writes a build
  // typed with flags by. What it is told - it wears nothing, no weapon, or
  // none of the weapons the log's character fought with, or holds what no
  // pin states - is the module's too (submit.mjs problemsOf), in the page's
  // words, as `bench submit` is told it in its own.

  const PREVIEW_TTL_MS = 30 * 60 * 1000;
  const PREVIEW_MAX = 8;
  const PREVIEW_ID_RE = /^[0-9a-f]{32}$/;
  // previewId -> { sub, link, uploadProblem, sendRefused, at, sending,
  // receipt }, where `link` is the upload link the preview was made with
  // (null for none) and `receipt` is set once a send of it failed after
  // leaving: it may have arrived, and the preview is then not dropped for a
  // newer one.
  const previews = new Map();
  // previewId -> { at, receipt }: a preview already sent, for the 409 that
  // says so (and hands the first send's receipt back to a page whose answer
  // was lost on the way).
  const sentPreviews = new Map();
  let previewSweeper = null;

  function sweepPreviews(now = Date.now()) {
    for (const [id, p] of previews) if (!p.sending && now - p.at > PREVIEW_TTL_MS) previews.delete(id);
    for (const [id, s] of sentPreviews) if (now - s.at > PREVIEW_TTL_MS) sentPreviews.delete(id);
    if (!previews.size && !sentPreviews.size && previewSweeper) { clearInterval(previewSweeper); previewSweeper = null; }
  }

  // A new preview, held. The oldest one that is neither being sent nor
  // waiting for "Send again" makes room for it - a Map iterates in the order
  // its keys were set, so the first is the oldest. The sweeper frees an
  // expired zip without waiting for the next call, and never keeps the
  // process alive.
  function holdPreview(entry) {
    sweepPreviews();
    for (const [id, p] of previews) {
      if (previews.size < PREVIEW_MAX) break;
      if (!p.sending && !p.receipt) previews.delete(id);
    }
    const id = randomBytes(16).toString('hex');
    previews.set(id, entry);
    if (!previewSweeper) {
      previewSweeper = setInterval(() => sweepPreviews(), 60 * 1000);
      previewSweeper.unref?.();
    }
    return id;
  }

  function rememberSent(id, receipt) {
    previews.delete(id);
    sentPreviews.set(id, { at: Date.now(), receipt });
    for (const key of sentPreviews.keys()) {
      if (sentPreviews.size <= 32) break;
      sentPreviews.delete(key);
    }
  }

  // The receipt, and the file the page offers as "Save receipt": the
  // module's own text, which says what the key does - and where the bench
  // keeps its own copy, when it does.
  function receiptFields(receipt) {
    const kept = keptPathOf(receipt.id);
    return {
      receipt,
      receiptText: receiptText(receipt),
      receiptName: `farever-bench-receipt-${receipt.id.slice(0, 8)}.json`,
      kept: existsSync(kept) ? kept : null,
    };
  }

  // --- the receipts the bench keeps --------------------------------------
  // One file per submission id, in the cache folder the rest of the bench
  // uses (FAREVER_BENCH_CACHE, which the app points at its own data folder
  // and the self-test at a scratch one; read when used, since both set it
  // before this server starts). It is the one thing there that cannot be
  // made again, which the dialog says beside every copy it names.
  function receiptFolder() {
    return join(process.env.FAREVER_BENCH_CACHE || join(benchRoot, '.cache'), 'submit-receipts');
  }
  const KEPT_NAME_RE = /^farever-bench-receipt-([0-9a-f]{32})\.json$/;
  function keptPathOf(id) {
    return join(receiptFolder(), `farever-bench-receipt-${id}.json`);
  }

  // The receipt kept for a submission id, or null: none, or a file that does
  // not read as one.
  function keptReceipt(id) {
    try {
      return parseReceipt(readFileSync(keptPathOf(id)));
    } catch {
      return null;
    }
  }

  // Written whole or not at all - half a receipt asks for nothing - in the
  // module's own words (receiptText).
  // For this account alone (see the header): a mode applies only to a file
  // or a folder the call creates, so a temporary file left by a crash goes
  // first rather than lending the receipt its mode.
  function writeKept(receipt) {
    const path = keptPathOf(receipt.id);
    mkdirSync(receiptFolder(), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    try { unlinkSync(tmp); } catch { /* none left over */ }
    writeFileSync(tmp, receiptText(receipt), { mode: 0o600 });
    renameSync(tmp, path);
    return path;
  }

  // Before a send: the receipt that asks for the deletion of whatever the
  // send leaves behind, on disk. A completed receipt already kept for this
  // id (a bundle built again from it) is left as it is, since it says more.
  // `wrote` is whether this made the file, so a send refused before its
  // request left, or refused by pCloud, takes it back: no fight carries its
  // id. A folder that cannot be written refuses the send (507) - with no
  // receipt kept, the deletion of a fight whose answer was lost could not be
  // asked for.
  function keepPending(held) {
    const path = keptPathOf(held.sub.id);
    const before = keptReceipt(held.sub.id);
    if (before?.sentAt) return { path, wrote: false };
    const receipt = pendingReceipt(held.sub, { link: held.link });
    try {
      writeKept(receipt);
    } catch (e) {
      throw new ApiError(507, `Nothing was sent: the bench could not keep this send's receipt as ${path} (${e?.code ?? e?.message ?? e}), `
        + 'and with no receipt kept, the deletion of a fight whose answer was lost could not be asked for - make that folder writable, '
        + 'or send the fight with bench submit --send');
    }
    return { path, wrote: before === null };
  }

  // A kept copy whose submission is gone: true when there was one to remove.
  function forgetKept(id) {
    try {
      unlinkSync(keptPathOf(id));
      return true;
    } catch {
      return false;
    }
  }

  // Every receipt the bench keeps, newest first; a file of a receipt's name
  // that does not read as that receipt is named, not dropped.
  function listKept() {
    const folder = receiptFolder();
    let names = [];
    let problem = null;
    try {
      names = readdirSync(folder);
    } catch (e) {
      if (e?.code !== 'ENOENT') problem = `${folder} could not be read (${e?.code ?? e?.message ?? e})`;
    }
    const receipts = [];
    const unreadable = [];
    for (const name of names) {
      const m = KEPT_NAME_RE.exec(name);
      if (!m) continue;
      let r = null;
      try { r = parseReceipt(readFileSync(join(folder, name))); } catch { r = null; }
      if (!r || r.id !== m[1]) { unreadable.push(name); continue; }
      receipts.push({ file: join(folder, name), ...receiptFields(r) });
    }
    const when = (x) => Date.parse(x.receipt.sentAt ?? x.receipt.createdAt ?? '') || 0;
    receipts.sort((a, b) => when(b) - when(a));
    return { folder, receipts, unreadable, problem };
  }

  // The held preview a body names, or the refusal that says why there is
  // none: a previewId of the wrong shape (400), one sent already (409, with
  // that send's receipt), one not held (404).
  function previewFor(body) {
    sweepPreviews();
    const id = body?.previewId;
    if (typeof id !== 'string' || !PREVIEW_ID_RE.test(id)) {
      throw new ApiError(400, 'previewId must be the id /api/submit/preview answered with (32 hex characters), '
        + `not ${String(JSON.stringify(id ?? null)).slice(0, 60)}`);
    }
    const sent = sentPreviews.get(id);
    if (sent) {
      throw new ApiError(409, `This preview was sent already (submission ${sent.receipt.id.slice(0, 8)}): a preview is sent once, `
        + 'and its bundle is in the project\'s folder now', receiptFields(sent.receipt));
    }
    const held = previews.get(id);
    if (!held) {
      throw new ApiError(404, 'No preview with that id is held: a preview is kept for 30 minutes and only the 8 latest are kept, '
        + 'so this one ran out, made way for a newer one, or was made before the bench restarted - the files are to be previewed again, '
        + 'and a bundle whose send was not answered is built again from its receipt as the same submission');
    }
    return { id, held };
  }

  const isPlain = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
  const named = (v) => typeof v === 'string' && v !== '';
  const asSentence = (t) => (/[.!?]$/.test(t) ? t : `${t}.`);

  // --- the build in the editor, as what the editor STATED ------------------
  // A loadout has no "not stated": a slot the editor left alone is in it
  // empty, the tree and the rune slots empty - and written whole, all of it
  // went to the project as the character's, recorded ("15 slots recorded
  // empty, no talent point spent, 0 runes") from a page that opens on an
  // empty Mage. The page's pins are what the player stated, as `bench
  // submit`'s flags are, and the module writes the build from them
  // (buildSubmission's editor input, charsheet.mjs pinnedSheet - one rule
  // for the CLI and the page): a slot, a piece's infusion, its sockets, a
  // skill pool, the tree and the rune slots are recorded when pinned, and
  // left out - not recorded, a gap the sheet report names - when not.
  //
  // The pins are checked here for their shape only, so a page that sent a
  // wrong one is told in this route's words. Absent is no pin at all.
  function editorPins(p) {
    const out = { talents: false };
    if (p != null && !isPlain(p)) {
      throw new ApiError(400, `sheet.editor.pins must be the page's pins {gear, augments, skills, runes, talents, infusions}, not ${quoted(p)}`);
    }
    for (const k of ['gear', 'augments', 'skills', 'runes', 'infusions']) {
      const v = p?.[k] ?? [];
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
        throw new ApiError(400, `sheet.editor.pins.${k} must be a list of ids, not ${quoted(p[k])}`);
      }
      out[k] = new Set(v);
    }
    if (p?.talents != null && typeof p.talents !== 'boolean') {
      throw new ApiError(400, `sheet.editor.pins.talents must be true or false, not ${quoted(p.talents)}`);
    }
    out.talents = p?.talents === true;
    return out;
  }

  // Of a pinned piece, the fields the editor STATES (pinnedSheet's
  // `pieces`). A piece the editor still holds as an import put it there goes
  // with what its FILE stated (`sheet.editor.pieces`: charsheet.mjs
  // recordedPieces, which /api/import answered with and the page sends back
  // for those pieces alone): the loadout an import fills in what the file
  // left open - a weapon's row rarity, 0 stars - and those fills are not the
  // character's. Any other piece was put there by the picker, which writes
  // the rarity always, the stars when rolled and the level when set, so a
  // field the entry lacks was not stated and goes as not recorded, never as
  // the value the bench would assume. Flawless has no control on the page:
  // stated only where the loadout carries it. The Prismatic flag is not one
  // of a picker piece's: pinnedSheet states it with a pinned infusion and
  // only then (the picker's box beside the infusion, unticked, is "not
  // Prismatic", as `~infusion` with no `!` is on the command line).
  const PIECE_FIELDS = ['level', 'rarity', 'stars', 'flawless', 'prismatic', 'infusionStat'];
  function editorPieces(loadout, given) {
    if (given != null && !isPlain(given)) {
      throw new ApiError(400, `sheet.editor.pieces must be /api/import's pieces {slot: {level, rarity, ...}}, not ${quoted(given)}`);
    }
    const out = {};
    for (const [slot, g] of Object.entries(isPlain(loadout.gear) ? loadout.gear : {})) {
      if (!isPlain(g)) continue;
      const file = given?.[slot];
      if (file != null) {
        if (!isPlain(file) || Object.entries(file).some(([k, v]) => !PIECE_FIELDS.includes(k) || typeof v !== 'boolean')) {
          throw new ApiError(400, `sheet.editor.pieces.${slot} must be {${PIECE_FIELDS.join(', ')}}, each true or false, not ${quoted(file)}`);
        }
        out[slot] = { ...file };
        continue;
      }
      out[slot] = {
        level: Number.isInteger(g.level),
        rarity: named(g.rarity),
        stars: Number.isInteger(g.stars),
        flawless: typeof g.flawless === 'boolean',
      };
    }
    return out;
  }

  function submitPreview(body) {
    if (body == null || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'body needs a sheet and a log');
    // --- the build: the editor's, or a file
    const given = body.sheet;
    if (!isPlain(given) || (given.file == null) === (given.editor == null)) {
      throw new ApiError(400, 'sheet needs one of two things: file (a character sheet: {name, text} or {name, base64}) '
        + 'or editor (the build in the editor: {loadout, pins, name, rank})');
    }
    let sheet;
    // The editor's build, as given, and its pins.
    let ed = null;
    let pins = null;
    if (given.editor != null) {
      ed = given.editor;
      if (!isPlain(ed) || !isPlain(ed.loadout)) {
        throw new ApiError(400, 'sheet.editor needs the loadout of the build in the editor, as /api/sheet takes it');
      }
      if (ed.name != null && typeof ed.name !== 'string') {
        throw new ApiError(400, `sheet.editor.name must be the character's name, not ${quoted(ed.name)}`);
      }
      if (ed.rank != null && !Number.isInteger(ed.rank)) {
        throw new ApiError(400, `sheet.editor.rank must be a whole weapon-skill rank, not ${quoted(ed.rank)}`);
      }
      pins = editorPins(ed.pins);
      // Written by the module from the pins (see above): the rule `bench
      // submit` writes a build typed with flags by.
      sheet = {
        loadout: structuredClone(ed.loadout), name: ed.name || null, rank: ed.rank ?? null,
        pins, pieces: editorPieces(ed.loadout, ed.pieces),
      };
    } else {
      sheet = parseFilePart(given.file, 'sheet.file');
    }
    // --- what a sheet that does not say is taken to be (/api/import's
    // class and level, by the same rules)
    let sheetOptions = null;
    if (body.sheetOptions != null) {
      if (!isPlain(body.sheetOptions)) throw new ApiError(400, 'sheetOptions must be {class, level}, for a sheet that does not say them');
      sheetOptions = parseClassLevel(body.sheetOptions, 'sheetOptions.');
    }
    // --- the fight
    const log = parseFilePart(body.log, 'log');
    if (log && body.log.mtimeMs != null) {
      if (!Number.isFinite(body.log.mtimeMs)) {
        throw new ApiError(400, `log.mtimeMs must be the file's time in epoch milliseconds, not ${quoted(body.log.mtimeMs)}`);
      }
      log.mtimeMs = body.log.mtimeMs;
    }
    const summary = parseFilePart(body.summary, 'summary');
    if (body.note != null && typeof body.note !== 'string') throw new ApiError(400, 'note must be text');
    if (body.keepName != null && typeof body.keepName !== 'boolean') {
      throw new ApiError(400, `keepName must be true or false, not ${quoted(body.keepName)}`);
    }
    // --- the submission this bundle is built again as, when it is one: a
    // receipt, given to the module whole (see the header). Read here only to
    // say, in this route's words, that it is none.
    let again = null;
    if (body.again != null) {
      try {
        again = parseReceipt(body.again);
      } catch (e) {
        throw new ApiError(400, `again: ${e?.message ?? e}`);
      }
    }

    // --- where Send would go: the upload link, read now and kept with the
    // preview, so the send goes where the page was told it would. A
    // FAREVER_BENCH_UPLOAD_LINK that is no upload link switches Send off,
    // and says why. The link itself is never handed to the page.
    let link = null;
    let uploadProblem = null;
    try { link = uploadLink(); } catch (e) { uploadProblem = String(e?.message ?? e); }

    let sub;
    try {
      sub = buildSubmission(eng, {
        sheet, sheetOptions, log, summary, note: body.note ?? null, keepName: body.keepName === true,
        ...(again ? { receipt: again } : {}),
      });
    } catch (e) {
      if (!(e instanceof SubmissionError)) throw e;
      // A refusal of the receipt itself (the module's `receipt` fact), named
      // by the field it came in.
      if (e.receipt === true) throw new ApiError(e.status ?? 400, `again: ${e.message}`);
      // The reader's "which class?", as /api/import asks it - with the class
      // the fight's log names (the module's `logClass` on its refusal: null
      // when the log names none or does not read), which the dialog offers
      // first.
      const asked = classAsked(e);
      if (asked) asked.logClass = typeof e.logClass === 'string' ? e.logClass : null;
      throw new ApiError(e.status ?? 400, e.message, asked);
    }

    // --- what stops Send - the module's rules and sentence, the ones
    // `bench submit --send` asks (a receipt whose fight arrived, a receipt
    // of another upload link than this copy's, a sheet of another class
    // than the log's unless the class given beside the file vouched for it).
    const refusal = sendRefusal(sub, { link });
    const sendRefused = refusal ? refusal.message : null;

    const entry = { sub, link, uploadProblem, sendRefused, at: Date.now(), sending: false, receipt: null };
    const previewId = holdPreview(entry);
    // The module's report, each line with its kind (and `warn` where the
    // module warns of it) - its problems, a stated build's included, in the
    // page's words; why Send is off (the module's first line, when the link
    // set is none) and what stops Send, first - each warned of, as every
    // problem is.
    // (After the module's own first two lines when the link set is none:
    // its Problem line and the manual route "until that link is set right".)
    const items = submitItems(sub, { link, uploadProblem });
    if (sendRefused) items.splice(uploadProblem ? 2 : 0, 0, { kind: 'refused', text: `Problem: ${asSentence(sendRefused)}`, warn: true });
    return {
      previewId,
      // The submission this bundle is - the id its receipt names, so a page
      // that lost a send's answer can find that receipt among the kept ones.
      id: sub.id,
      expiresAt: new Date(entry.at + PREVIEW_TTL_MS).toISOString(),
      upload: link !== null,
      uploadProblem,
      sendRefused,
      logClass: sub.logClass ?? null,
      // the manual route's issue title (the GitHub form opens with it)
      title: sub.issueTitle,
      files: sub.files,
      zipName: sub.zipName,
      zipBytes: sub.zipBytes,
      formUrl: sub.formUrl,
      report: items.map((i) => i.text),
      reportItems: items,
      problems: problemsOf(sub),
    };
  }

  // Save .zip: the held bundle, byte for byte, as often as the page asks.
  function submitBundle(body) {
    const { held } = previewFor(body);
    return { name: held.sub.zipName, base64: held.sub.zip.toString('base64'), bytes: held.sub.zip.length };
  }

  // An async route's answer (the optimizeEvents pattern: it writes `res`
  // itself, once).
  function reply(res, status, data) {
    if (res.headersSent || res.writableEnded) return;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  // A refusal of /send or /delete. The route's own keep their status, and so
  // do the module's, which already say what pCloud answered: a refusal of
  // its (503 the link closed or unknown, 507 the folder full, 429 this
  // address turned away, 502 anything else - `arrived: false`: nothing of
  // it was kept, and it carries no receipt), 502 for pCloud unreached or an
  // answer that is not its API's (with the receipt: the fight may have
  // arrived), 400 for what the module refuses before anything leaves. A
  // receipt the module attached travels with the sentence.
  // It never throws: the two routes that use it are not awaited by anyone,
  // and a rejection nobody handles ends a plain Node process.
  function replyError(res, e) {
    try {
      if (e instanceof ApiError) { reply(res, e.status, { error: e.message, ...(e.extra ?? {}) }); return; }
      if (e instanceof SubmissionError) {
        const s = e.status;
        const status = Number.isInteger(s) && s >= 400 && s < 600 ? s : 500;
        reply(res, status, {
          error: e.message, ...(e.arrived === false ? { arrived: false } : {}), ...(e.receipt ? receiptFields(e.receipt) : {}),
        });
        return;
      }
      reply(res, 500, { error: String(e?.message ?? e) });
    } catch (bug) {
      reply(res, 500, { error: String(bug?.message ?? bug) });
    }
  }

  // How long a send waits for pCloud, as the 409 of a second send says it.
  const sendWait = () => (SEND_TIMEOUT_MS >= 60_000 ? `${Math.round(SEND_TIMEOUT_MS / 60_000)} minutes` : `${Math.round(SEND_TIMEOUT_MS / 1000)} s`);

  // Send: the held bundle to the project's pCloud folder, on the player's
  // consent. Called from its `case` alone (see the header).
  async function submitSend(res, body) {
    let id;
    let held;
    try {
      if (body?.consent !== true) {
        throw new ApiError(400, 'Nothing was sent: a send needs consent: true, which the dialog sends once '
          + '"I understand the zip goes to the project\'s folder on pCloud, where only the maintainer can read it" is ticked');
      }
      ({ id, held } = previewFor(body));
      if (held.sending) {
        throw new ApiError(409, `This preview is being sent already - the answer goes to the send that started it, within ${sendWait()}`);
      }
      // What the module refuses to send (see the header) - asked first, as
      // sendSubmission and `bench submit --send` ask it: refused before the
      // receipt is written, so nothing carries its id and a completed
      // receipt kept for it stays as it is. The module asks the same rules
      // again before its request leaves.
      if (held.sendRefused) throw new ApiError(409, held.sendRefused);
      if (held.link === null) {
        throw new ApiError(409, held.uploadProblem
          ? `Send is off: ${held.uploadProblem}`
          : `Send is off in this copy of the bench (no upload link is set) - save the .zip and attach it to a new issue: ${held.sub.formUrl}`);
      }
    } catch (e) {
      replyError(res, e);
      return;
    }
    // The receipt on disk first (see the header); no await between the
    // `sending` test above and the flag below, so two sends cannot both pass.
    let kept;
    try {
      kept = keepPending(held);
    } catch (e) {
      replyError(res, e);
      return;
    }
    held.sending = true;
    try {
      // The bench version that built the bundle, which the module holds the
      // send to - as `bench submit --send` passes its own.
      const done = await sendSubmission(held.sub, { link: held.link, benchVersion: benchVersion() });
      // The receipt is its six fields; the name the zip went under is no
      // field of it, and travels beside it.
      const { uploadedAs, ...receipt } = done;
      // The completed receipt over the pending one; if that write fails, the
      // pending one still asks for the fight's deletion, and the page has
      // this one.
      try { writeKept(receipt); } catch { /* the pending copy stays, and still asks for it */ }
      rememberSent(id, receipt);
      reply(res, 200, {
        sent: { id: receipt.id, uploadedAs, sentAt: receipt.sentAt, zipSha256: receipt.zipSha256 },
        ...receiptFields(receipt),
      });
    } catch (e) {
      held.sending = false;
      if (e instanceof SubmissionError && e.receipt) {
        // It may have arrived: held for Send again, from now.
        held.receipt = e.receipt;
        held.at = Date.now();
      } else if (kept.wrote) {
        // Refused before the request left, or by pCloud, which then kept
        // none of it (`arrived: false`): no fight carries its id. A receipt
        // kept before an earlier send of this bundle stays - that send may
        // have arrived.
        forgetKept(held.sub.id);
      }
      replyError(res, e);
    }
  }

  // Delete: a request for a past submission's deletion, uploaded with its
  // receipt to the project's pCloud folder through this copy's own upload
  // link (a receipt of another link is the module's 400, which says how to
  // ask there). Called from its `case` alone.
  async function submitDelete(res, body) {
    let receipt;
    try {
      const given = body?.receipt;
      if (given == null || (typeof given !== 'string' && (typeof given !== 'object' || Array.isArray(given)))) {
        throw new ApiError(400, 'receipt must be the receipt a send gave you - the text of the file, or its JSON');
      }
      receipt = parseReceipt(given);
      // Not while that very submission is on its way: the send's answer
      // would write its receipt back as completed after the request forgot
      // it, and the dialog would show a fight sent whose deletion is asked.
      for (const p of previews.values()) {
        if (p.sending && p.sub.id === receipt.id) {
          throw new ApiError(409, `Submission ${receipt.id.slice(0, 8)} is being sent right now - nothing was asked: ask for its deletion `
            + `once that send is answered, within ${sendWait()}`);
        }
      }
    } catch (e) {
      replyError(res, e);
      return;
    }
    try {
      await deleteSubmission(receipt, { link: uploadLink() });
      // The request is in the folder: the kept copy has done its work.
      reply(res, 200, { ok: true, requested: true, id: receipt.id, forgotten: forgetKept(receipt.id) });
    } catch (e) {
      replyError(res, e);
    }
  }

  // The receipts the bench keeps, for the dialog's list - and whether this
  // copy sends at all (never its link: the page has no use for it).
  function submitReceipts() {
    let link = null;
    let uploadProblem = null;
    try { link = uploadLink(); } catch (e) { uploadProblem = String(e?.message ?? e); }
    return { ...listKept(), upload: link !== null, uploadProblem };
  }

  // --- dispatch -------------------------------------------------------------

  function handle(req, res, pathname, searchParams, body) {
    if (!pathname.startsWith('/api/')) return false;
    const json = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    // A `case` below with no ROUTES row would be reached with no method,
    // Origin or content-type check and no body (the server reads one only for
    // a POST row). Such a route is not answered at all: it fails closed, and
    // visibly, the first time anyone calls it.
    if (!ROUTES.has(pathname)) {
      json(404, { error: `no such endpoint ${pathname}` });
      return true;
    }
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
        case '/api/import': json(200, importSheet(body)); return true;
        case '/api/submit/preview': json(200, submitPreview(body)); return true;
        case '/api/submit/bundle': json(200, submitBundle(body)); return true;
        case '/api/submit/receipts': json(200, submitReceipts()); return true;
        // The two that reach the network: async, they answer `res` themselves
        // once pCloud has, and never reject.
        case '/api/submit/send': submitSend(res, body); return true;
        case '/api/submit/delete': submitDelete(res, body); return true;
        default: json(404, { error: `no such endpoint ${pathname}` }); return true;
      }
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 500;
      json(status, { error: String(e?.message ?? e), ...(e instanceof ApiError ? e.extra ?? {} : {}) });
      return true;
    }
  }

  function close() {
    for (const job of jobs.values()) {
      if (!job.done) killJob(job, 'server closing');
    }
    if (previewSweeper) clearInterval(previewSweeper);
    previewSweeper = null;
    previews.clear();
    sentPreviews.clear();
    icons.close?.();
  }

  return { handle, close, icons, notice, routeMethod };
}
