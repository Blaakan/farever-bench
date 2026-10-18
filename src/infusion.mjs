// ---------------------------------------------------------------------------
// infusion.mjs - attach a build's infusion sets, and say what of each is in
// the number.
//
// An infusion is a set passive (skill type InfusionPassive) carried on armour;
// catalog.mjs holds who can carry one and loadout.mjs counts the sets. This
// module answers the third question: once a set reaches a rank, what does the
// passive DO to the build, and how much of that can this model price.
//
// Every one of the fifteen rows on build 25782799 has the same shape:
//
//   rank 1  a scripted effect (texts.desc), no stat
//   rank 2  the same effect + one or two attribute rows behind
//           `conds.minRank: 2` (+2.5 CritChance, +2.5% Armor, ...)
//   rank 3  the same + a scripted branch behind `rank >= 3`
//
// THE RANK HERE IS THE SET'S OWN - the count of equipped pieces carrying the
// infusion against Item_InfusionCaps ($HInfusion.getRankFromStacks@21691),
// which the game's own tooltips title "(2) Set", "(4) Set", "(6) Set". It has
// nothing to do with `--rank`, which is weapon mastery: a row's `minRank` and
// its script's `rank >= 3` are answered with the set's number and no other.
// That is why the attach lives here, beside the engine, and not in the
// rotation: `resolve()` and some twenty readers behind it take ONE rank for
// the whole build, and a set passive pushed through them at `--rank 3` would
// light every `rank >= 3` branch at two pieces.
//
// What is priced, and from what:
//
//   * the rank-gated attribute rows, always. A skill's own affixes are
//     permanent (BaseSkill.permaAffixes@6188 / BaseSkill.setRunning@6132 - see the
//     engine's affix pass), so they are on the standing sheet too.
//   * a self status the script applies on an event THE FIGHT RAISES - the
//     existing status reader already says which event (`trigger.on`), and the
//     engine's own self-buff pass prices it exactly as it prices a weapon
//     passive's (Honorable Defender's Vitality stacks, on the combo finisher).
//   * WHAT THE SCRIPT DOES IN THE FIGHT, where the hook it is written in and
//     the guard in front of it name an event the fight raises. The passive is
//     never cast and never enters the rotation; instead `read()` builds FIGHT
//     PARTS at the set's rank - a status that ticks on the foe, a debuff an
//     event stacks on it, a step played while a status the script holds up is
//     worn, a cast a counter arms - in the shapes the fight already plays, and
//     the engine hands the fight a VIEW of the rotation with them appended.
//     Each part's profile is `combat.profile(<row>, <set rank>)`, so its
//     amounts, its vars and its own script riders are the set's and the
//     weapon's rank never reaches it. See `sitesOf` / `judge` for the reading
//     and `fightOf` for the shapes.
//
// What is REFUSED, by name: everything else the script does - a hook that
// waits on something this fight never does (a foe dying, you being hit, an
// object walked onto), a guard that asks about state it does not hold, a
// shape no part is built for. Those are listed per infusion, at the set's
// rank - so a two-piece set never mentions its `rank >= 3` branch - with the
// amounts as the row authors them and the reason the reader stopped.
// ---------------------------------------------------------------------------

// Comments out, whitespace kept, so nothing switched off is read.
const blank = (s) => s.replace(/[^\n]/g, ' ');
const stripComments = (src) => String(src ?? '')
  .replace(/\/\*[\s\S]*?\*\//g, blank)
  .replace(/\/\/[^\n]*/g, blank);

// The index just past the bracket that closes the one at `open`.
function matchClose(text, open, a, b) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === a) depth++;
    else if (c === b && --depth === 0) return i + 1;
  }
  return text.length;
}

// One statement starting at `from`: a `{ block }`, an `if (..) S [else S]`,
// a `for`/`while (..) S`, or everything up to its `;`. An `if` is taken WITH
// its branches - `if (a) { .. } else { .. }` used as someone's else-branch is
// one statement, not everything up to the next semicolon after it.
function statementEnd(text, from) {
  let i = from;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] === '{') return matchClose(text, i, '{', '}');
  const kw = /^(if|for|while)\s*\(/.exec(text.slice(i, i + 16));
  if (kw) {
    let j = statementEnd(text, matchClose(text, text.indexOf('(', i), '(', ')'));
    if (kw[1] === 'if') {
      const e = /^\s*else\b/.exec(text.slice(j));
      if (e) j = statementEnd(text, j + e[0].length);
    }
    return j;
  }
  let depth = 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') { if (depth === 0) return i; depth--; }
    else if (c === ';' && depth === 0) return i + 1;
  }
  return text.length;
}

const RANK_TEST = /^\s*rank\s*(>=|<=|==|!=|>|<)\s*(\d+)\s*$/;
const rankHolds = (op, n, r) => (op === '>=' ? r >= n : op === '<=' ? r <= n : op === '==' ? r === n
  : op === '!=' ? r !== n : op === '>' ? r > n : r < n);

/**
 * The script as it reads AT ONE RANK: every branch a `rank` comparison
 * switches off is blanked out.
 *
 * Three shapes, which are all the fifteen infusion scripts use:
 *
 *   if (rank >= 3 && <more>) A else B     a conjunction with a rank test that
 *                                         FAILS: A is dead, B stays
 *   if (rank >= 3) { A }                  the test alone, and it HOLDS: A
 *                                         stays, an else is dead
 *   if (rank < 3) return;                 the test alone, HOLDS, and the branch
 *                                         leaves: the rest of that function is
 *                                         dead
 *
 * A condition with an `||` in it is left alone - the rank does not decide it.
 */
export function scriptAtRank(script, rank) {
  let text = stripComments(script);
  const re = /\bif\s*\(/g;
  let m;
  while ((m = re.exec(text))) {
    const open = m.index + m[0].length - 1;
    const condEnd = matchClose(text, open, '(', ')');
    const cond = text.slice(open + 1, condEnd - 1);
    if (!/\brank\b/.test(cond) || cond.includes('||')) continue;
    const parts = cond.split('&&');
    const tests = parts.map((p) => RANK_TEST.exec(p)).filter(Boolean);
    if (!tests.length) continue;
    const thenEnd = statementEnd(text, condEnd);
    const after = /^\s*else\b/.exec(text.slice(thenEnd));
    const elseStart = after ? thenEnd + after[0].length : -1;
    const elseEnd = after ? statementEnd(text, elseStart) : -1;
    const fails = tests.some((t) => !rankHolds(t[1], Number(t[2]), rank));
    const kill = (a, b) => { text = text.slice(0, a) + blank(text.slice(a, b)) + text.slice(b); };
    if (fails) {
      // The condition goes with the branch: `rank >= 3 && !hasStatus(owner,
      // Skill.X)` names X only for the rank that can reach it.
      kill(open, thenEnd);
    } else if (tests.length === parts.length) {
      // The whole condition is rank tests and they hold.
      if (after) kill(elseStart, elseEnd);
      if (/^\s*\{?\s*return\b[^;]*;?\s*\}?\s*$/.test(text.slice(condEnd, thenEnd))) {
        // Leaves the function: dead to the brace that closes it.
        let depth = 0;
        let end = text.length;
        for (let i = thenEnd; i < text.length; i++) {
          if (text[i] === '{') depth++;
          else if (text[i] === '}') { if (depth === 0) { end = i; break; } depth--; }
        }
        kill(thenEnd, end);
      }
    }
  }
  return text;
}

// --- a script, as its call sites and what stands in front of each ----------
//
// The fight parts below are read off WHERE a call sits: the hook it is
// written in, and the conjunction of conditions on the path to it. That needs
// a little more structure than a regex over the text, because the scripts
// write the same guard three ways -
//
//   if (A && B) call();                       a condition
//   if (!A || B) return;  ...  call();        an early return (so A && !B)
//   if (A) x(); else if (B) call();           an else-branch (so !A && B)
//
// - and hand a call to a local function (`throwBomb`) or a delayed closure
// (`wait(0, () -> { .. })`) without changing what guards it.

// Split on a separator at bracket depth 0.
function splitTop(text, sep) {
  const out = [];
  let depth = 0, last = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (depth === 0 && text.startsWith(sep, i)) { out.push(text.slice(last, i)); last = i + sep.length; i += sep.length - 1; }
  }
  out.push(text.slice(last));
  return out;
}
// Whitespace out, and any pair of parentheses that wraps the whole thing.
function bare(text) {
  let s = text.replace(/\s+/g, '');
  while (s.startsWith('(') && matchClose(s, 0, '(', ')') === s.length) s = s.slice(1, -1);
  return s;
}
/**
 * A condition as a conjunction of atoms: `{neg, text}` for a plain test and
 * `{or: [<conjunction>, ..]}` for alternatives. `neg` asks for the condition
 * NOT to hold - De Morgan carried down, so `!(A || B)` is the two atoms !A, !B.
 */
export function atomsOf(cond, neg = false) {
  const s = bare(cond);
  if (!s) return [];
  const ands = splitTop(s, '&&');
  const ors = splitTop(s, '||');
  if (!neg) {
    if (ors.length > 1) return [{ or: ors.map((o) => atomsOf(o, false)) }];
    if (ands.length > 1) return ands.flatMap((a) => atomsOf(a, false));
  } else {
    if (ors.length > 1) return ors.flatMap((o) => atomsOf(o, true));
    if (ands.length > 1) return [{ or: ands.map((a) => atomsOf(a, true)) }];
  }
  if (s[0] === '!' && s[1] !== '=') return atomsOf(s.slice(1), !neg);
  return [{ neg, text: s }];
}

const KEYWORDS = new Set(['if', 'for', 'while', 'function', 'switch', 'return', 'catch', 'new']);
/**
 * Every call in a script: `{call, recv, args[], conds[], hook, params[], loop,
 * delayed, inCond, via[]}`. `conds` are the atoms on the path from the hook's
 * first line to the call; a call written inside an `if`'s own condition
 * (`if (consumeStatus(owner, X) > 0)`) is a site too, under the conditions
 * around that `if`. `via` names the local functions the walk went through.
 * Top-level functions named `on<Hook>` are the entry points.
 */
export function sitesOf(text) {
  const fns = new Map();
  for (const m of text.matchAll(/\bfunction\s+(\w+)\s*\(([^)]*)\)\s*\{/g)) {
    const open = m.index + m[0].length - 1;
    fns.set(m[1], {
      params: m[2].split(',').map((p) => p.trim()).filter(Boolean),
      body: text.slice(open + 1, matchClose(text, open, '{', '}') - 1),
    });
  }
  const sites = [];
  const callsIn = (stmt, conds, ctx, inCond = false) => {
    // A closure with a block body is walked as statements of its own, under
    // the same conditions, and blanked here so its calls are not seen twice.
    let rest = stmt;
    for (let m; (m = /->\s*\{/.exec(rest));) {
      const open = m.index + m[0].length - 1;
      const close = matchClose(rest, open, '{', '}');
      walk(rest.slice(open + 1, close - 1), conds, { ...ctx, delayed: true });
      rest = rest.slice(0, m.index) + blank(rest.slice(m.index, close)) + rest.slice(close);
    }
    for (const m of rest.matchAll(/(?:([A-Za-z_][\w.]*)\.)?\b([A-Za-z_]\w*)\s*\(/g)) {
      if (KEYWORDS.has(m[2])) continue;
      const open = m.index + m[0].length - 1;
      const inner = rest.slice(open + 1, matchClose(rest, open, '(', ')') - 1);
      sites.push({
        call: m[2], recv: m[1] ?? null, args: inner.trim() ? splitTop(inner, ',').map((a) => a.trim()) : [],
        conds, hook: ctx.hook, params: ctx.params, loop: ctx.loop ?? null,
        delayed: !!ctx.delayed, inCond, via: ctx.via,
      });
      // One hop into a function of the script's own: its body runs under
      // whatever guarded the call.
      if (!m[1] && fns.has(m[2]) && !/^on[A-Z]/.test(m[2]) && ctx.via.length < 2 && !ctx.via.includes(m[2])) {
        walk(fns.get(m[2]).body, conds, { ...ctx, via: [...ctx.via, m[2]] });
      }
    }
  };
  const isReturn = (s) => /^\s*\{?\s*return\b[^;{}]*;?\s*\}?\s*$/.test(s);
  function walk(body, conds0, ctx) {
    let conds = conds0;
    let i = 0;
    while (i < body.length) {
      while (i < body.length && /[\s;]/.test(body[i])) i++;
      if (i >= body.length) break;
      const head = body.slice(i, i + 16);
      const kw = /^(if|for|while)\s*\(/.exec(head);
      if (kw) {
        const open = body.indexOf('(', i);
        const condEnd = matchClose(body, open, '(', ')');
        const cond = body.slice(open + 1, condEnd - 1);
        const thenEnd = statementEnd(body, condEnd);
        const thenText = body.slice(condEnd, thenEnd);
        if (kw[1] !== 'if') {
          walk(thenText.trim().startsWith('{') ? thenText.trim().slice(1, -1) : thenText, conds, { ...ctx, loop: cond.trim() });
          i = thenEnd;
          continue;
        }
        callsIn(cond, conds, ctx, true);
        const e = /^\s*else\b/.exec(body.slice(thenEnd));
        const elseStart = e ? thenEnd + e[0].length : -1;
        const elseEnd = e ? statementEnd(body, elseStart) : -1;
        const unwrap = (s) => (s.trim().startsWith('{') ? s.trim().slice(1, -1) : s);
        if (!e && isReturn(thenText)) {
          // Leaves the function: what follows runs only when it did NOT hold.
          conds = [...conds, ...atomsOf(cond, true)];
        } else {
          walk(unwrap(thenText), [...conds, ...atomsOf(cond)], ctx);
          if (e) walk(unwrap(body.slice(elseStart, elseEnd)), [...conds, ...atomsOf(cond, true)], ctx);
        }
        i = e ? elseEnd : thenEnd;
        continue;
      }
      if (/^return\b/.test(head)) break;
      if (body[i] === '{') {
        const end = matchClose(body, i, '{', '}');
        walk(body.slice(i + 1, end - 1), conds, ctx);
        i = end;
        continue;
      }
      const end = statementEnd(body, i);
      callsIn(body.slice(i, end), conds, ctx);
      i = Math.max(end, i + 1);
    }
  }
  for (const [name, f] of fns) {
    if (/^on[A-Z]/.test(name)) walk(f.body, [], { hook: name, params: f.params, via: [] });
  }
  return sites;
}

export function buildInfusionPlan(cdb, cat, combat, plan) {
  const skills = cdb.byId('skill');
  const natures = cdb.enumValues('skill', 'nature');
  const isStatusRow = (id) => natures[skills.get(id)?.nature ?? -1] === 'Status';
  if (!natures.includes('Status')) throw new Error('skill.nature has no Status case - the game changed shape');
  const nameOf = (id) => skills.get(id)?.texts?.name ?? null;
  const label = (id) => (nameOf(id) ? `${nameOf(id)} (${id})` : id);
  const NO_RUNES = new Set();
  // How a step comes to run - its `on` column, by name. A Code or Trigger step
  // waits for a script (`playStep(Steps.X)`); every other runs on an event of
  // its own row.
  const stepOnNames = cdb.enumValues('skill@steps', 'on');
  const SCRIPT_PLAYED = new Set(['Code', 'Trigger']);
  for (const n of SCRIPT_PLAYED) {
    if (!stepOnNames.includes(n)) throw new Error(`skill.steps.on has no ${n} case - the game changed shape`);
  }
  const capTitle = (rank) => `(${cat.infusionCaps[rank - 1] ?? '?'}) Set`;

  // What the hook waits for, where that is a fact about THIS fight model
  // rather than about the game: the simulated foe never attacks and never
  // dies. Anything else is named and left at "no reader raises it".
  //
  // Each entry answers from the hook's own body as it reads at the set's rank,
  // because a hook's NAME does not always say what it waits for. onGameBeat is
  // handed one of the seven rows of the `gameBeat` sheet, and only two of them
  // are a hit landing on you:
  //   AttackBlock     st.skill.ScriptHitData.blockHit@6312 ops 63-77 emits it
  //                   to the hit's TARGET once the hit is blocked
  //   BlockWellTimed  st.skill.Block.onReceiveDamageEval@26730 ops 5-18, to
  //                   the unit whose block caught the hit in its window
  // Those are the only two callers of ent.Unit.emitGameBeat@4924 this client
  // has (the hook is an RPC; what the server raises of its own is not here).
  // A script that tests one of the other five (Critical, Missed, DamageDodge,
  // Backstabbed, InvulnerableHit), or none, is not known to be waiting on the
  // foe at all - calling that "a block" would be reading the hook's name.
  const BLOCK_BEATS = new Set(['AttackBlock', 'BlockWellTimed']);
  const HOOK_NEVER = [
    [/^onKill$/, () => 'a foe dying, and this fight kills nothing'],
    [/^onReceive(Damage|DamageEval|Hit)$/, () => 'you being hit, and the simulated foe never attacks'],
    [/^onGameBeat$/, (body) => {
      const beats = [...new Set([...body.matchAll(/\bGameBeat\.([A-Za-z0-9_]+)/g)].map((m) => m[1]))];
      return beats.length && beats.every((b) => BLOCK_BEATS.has(b))
        ? `a hit you block (${beats.map((b) => `GameBeat.${b}`).join(' / ')}), and the simulated foe never attacks` : null;
    }],
    // A heal of yours landing, behind `healthRatio < 1` on who it lands on:
    // the only one this fight heals is you, and you are never hurt.
    [/^onInflictHeal(Eval)?$/, (body) => (/healthRatio\s*<\s*1\b/.test(body)
      ? 'a heal of yours landing on someone below full health, and nobody in this fight is hurt' : null)],
    // An object the skill dropped on the ground, when someone touches it. The
    // one event the scripts ask it for is Pickup, and nobody in this fight
    // walks anywhere: how often a ball is picked up is not a fact of the data.
    [/^onSkillObjectEvent$/, (body) => {
      const evs = [...new Set([...body.matchAll(/\bSkillObjectEvent\.([A-Za-z0-9_]+)/g)].map((m) => m[1]))];
      return evs.length === 1 && evs[0] === 'Pickup'
        ? 'an object it dropped being walked onto (SkillObjectEvent.Pickup), and nothing in the data says how often that is' : null;
    }],
  ];
  // The body of one hook in a script: from its `function name(` to the brace
  // that closes it.
  const hookBody = (text, hook) => {
    const m = new RegExp(`function\\s+${hook}\\s*\\(`).exec(text);
    if (!m) return '';
    const open = text.indexOf('{', m.index);
    return open < 0 ? '' : text.slice(open, matchClose(text, open, '{', '}'));
  };

  const fmtAffix = (a) => {
    const kind = cat.ctx.affix.kindOf(a.ref);
    const v = a.val ?? 0;
    const n = kind === 'flat' ? `${v >= 0 ? '+' : ''}${v}` : `${v >= 0 ? '+' : ''}${+(v * 100).toFixed(2)}%`;
    return `${n} ${a.target.attribute}`;
  };
  const fmtEffect = (e) => {
    const amount = [
      e.baseVal ? String(e.baseVal) : null,
      ...(e.scaling ?? []).map((s) => `${s.ratio} x ${s.atb}`),
    ].filter(Boolean).join(' + ');
    return `${e.kind}${amount ? ' ' + amount : ''}`;
  };

  // --- what a call site's hook and guard come to, in this fight --------------
  //
  // THE EVENTS a set passive's script can ride, each read off the hook the
  // call is written in and what the guard says about the thing the hook was
  // handed. The left column is the game's; the right is where this fight
  // raises it (sim.mjs `foeEvent` / `applyDots`).
  //
  //   onInflictStatusEval(s)   `s.target.isEnemy(owner)`      status-apply
  //       ent.GameObject.addStacks@4637 ops 23-77 run the hook on every skill
  //       and status of the status's instigator, on EVERY application - before
  //       the cap (ops 130-144), so a re-application at full stacks counts.
  //       `s.status.kind != Skill.X` leaves X's own applications out;
  //       `s.status.kind == Skill.X` is X's applications and no other's.
  //   onTryAddStatus(s, t)     `isCrowdControl(s)`            cc-apply
  //       SkillScript.isCrowdControl@6938 is hasStatusFlag@21820(inf, 1), the
  //       CrowdControl flag. The hook's DISPATCHER is not in this client
  //       (GameObject.addStatus@4636 is a server-only stub): that it runs on
  //       the attempt, landed or not, is the hook's name and the one tooltip
  //       that describes it ("even if the target is immune", Domination's).
  //   onApplyKnockback(t)                                     knockback
  //       dispatcher not in the client either (ent.Unit.applyKnock@4949 is a
  //       stub; the client half, rpcApplyKnock__impl@4952, only moves the
  //       body). Counted once per effect of a cast that authors
  //       `sideEffects.knockBack` with a force; an entry that authors none
  //       is tallied apart and said beside the build (`settle`).
  //   onSkillProc / onUseSkill(ctx)   `ctx.isWeaponSkill`     weapon-skill
  //                                   `ctx.isClassSkill`      class-skill
  //                                   `ctx.isSkill`           skill
  //                                   `ctx.isFinalCombo`      combo
  //       BaseSkill.isWeaponSkill@6161 (type 7 or 8), BaseSkill.isClassSkill@6158
  //       (type 9), BaseSkillAccess.get_isSkill@5193 (either, or a signature).
  //       Once per USE, before the cast's hits exist.
  //   onInflictDamage(dmg)     `dmg.isWeaponSkill`            weapon-skill-hit
  //                            `isBaseAttack || isFinalCombo` attack-or-combo
  //                            `dmg.critical`                 a critical one
  //       Once per damage instance the owner lands: the hook is handed one
  //       st.skill.DamageResult. On a result `isBaseAttack` is the STEP's -
  //       SkillStep.isBaseAttack@6027, the step's own BaseAttack flag or its
  //       skill being type 0-4 (BaseSkill.isBaseAttack@6153, finisher
  //       included) - and `isFinalCombo` is the skill's BaseSkill.isFinalAttack@6154; so
  //       the pair is the damage instances of the chain and its finisher
  //       (Infusion_Crimson_Support.onInflictDamage@45101 ops 9-21). One row
  //       outside the chain flags a step BaseAttack - a status of the Water
  //       daggers - and its hits are not counted here.
  //
  // A guard atom this does not know makes the site UNREAD, with the atom
  // quoted; a hook with no row here is an event the fight does not raise.
  const PRESS_FLAG = {
    isWeaponSkill: 'weaponSkill', isClassSkill: 'classSkill', isSkill: 'skill',
    isFinalCombo: 'combo', isFinalAttack: 'combo', isComboAttack: 'combo',
    isBaseAttack: 'attack', isBasicAttack: 'attack', critical: 'crit', isCrit: 'crit',
  };
  function judge(site, env) {
    const { rank, vars, alias } = env;
    const out = {
      chance: 1, flags: new Set(), needs: [], unknown: [], dead: false,
      statusNot: null, statusIs: null, ownStep: null, afterStep: null,
    };
    const ref = (name) => (skills.has(name) ? name : alias.get(name) ?? null);
    const rankAtom = (a) => {
      const m = /^rank(>=|<=|==|!=|>|<)(\d+)$/.exec(a.text ?? '');
      return m ? rankHolds(m[1], Number(m[2]), rank) !== a.neg : null;
    };
    // One plain atom: true when it was understood.
    const one = (a) => {
      const t = a.text;
      let m;
      const r = rankAtom(a);
      if (r != null) { if (!r) out.dead = true; return true; }
      if ((m = /^\w+\.(isWeaponSkill|isClassSkill|isSkill|isFinalCombo|isFinalAttack|isComboAttack|isBaseAttack|isBasicAttack|critical|isCrit)$/.exec(t))) {
        out.flags.add((a.neg ? '!' : '') + PRESS_FLAG[m[1]]);
        return true;
      }
      // `x.skillId == skill.kind` is "my own damage"; its negation is true of
      // everything else the owner lands, which is what the event already is.
      if ((m = /^\w+\.skillId(==|!=)(?:skill\.kind|kind)$/.exec(t))) {
        if ((m[1] === '==') !== a.neg) out.flags.add('own');
        return true;
      }
      // "not that other row's" narrows nothing here; "only that other row's"
      // is a question about someone else's hits.
      if ((m = /^\w+\.skillId(==|!=)Skill\.\w+$/.exec(t))) return (m[1] === '==') === a.neg;
      if ((m = /^\w+\.stepId(==|!=)Steps\.(\w+)$/.exec(t))) {
        if ((m[1] === '==') !== a.neg) out.ownStep = m[2];
        return true;
      }
      if (/^\w+\.target\.isEnemy\(owner\)$/.test(t)) { if (a.neg) return false; out.flags.add('foe'); return true; }
      if ((m = /^\w+\.status\.kind(==|!=)(?:Skill\.)?(\w+)$/.exec(t))) {
        const x = ref(m[2]);
        if (!x) return false;
        if ((m[1] === '==') !== a.neg) out.statusIs = x; else out.statusNot = x;
        return true;
      }
      if (/^isCrowdControl\(\w+\)$/.test(t)) { if (a.neg) return false; out.flags.add('cc'); return true; }
      if ((m = /^checkProba\(vars\.(\w+)\)$/.exec(t))) {
        const v = vars?.[m[1]];
        if (!(typeof v === 'number' && v >= 0 && v <= 1)) return false;
        out.chance *= a.neg ? 1 - v : v;
        return true;
      }
      if ((m = /^hasStatus\(owner,(?:Skill\.)?(\w+)\)$/.exec(t))) {
        const x = ref(m[1]);
        if (!x) return false;
        out.needs.push({ kind: a.neg ? 'selfLacks' : 'selfHas', status: x });
        return true;
      }
      if ((m = /^consumeStatus\(owner,(?:Skill\.)?(\w+)\)>0$/.exec(t))) {
        const x = ref(m[1]);
        if (!x || a.neg) return false;
        out.needs.push({ kind: 'selfConsumes', status: x });
        return true;
      }
      if ((m = /^getStatusCount\(\w+\.target,(?:Skill\.)?(\w+)\)>=(\d+)$/.exec(t))) {
        const x = ref(m[1]);
        if (!x) return false;
        out.needs.push({ kind: a.neg ? 'foeBelow' : 'foeAtLeast', status: x, n: Number(m[2]) });
        return true;
      }
      // `!ctx.skill.isPassive()`: a press is not a passive.
      if (/^\w+\.skill\.isPassive\(\)$/.test(t)) return a.neg;
      // `area.step.kind == Steps.S`, in a hook an AREA raises: "the area of
      // my own S step". Where nothing plays S at this rank the branch is off
      // (a two-piece set throws no golden bomblet, so nothing lands for its
      // fragments to be thrown from); where something does, the site rides
      // that step's landing, and `hitCount == 0` beside it asks whether it
      // hit anything.
      if ((m = /^\w+\.step\.kind(==|!=)Steps\.(\w+)$/.exec(t))) {
        if ((m[1] === '==') === a.neg) return false;
        out.afterStep = m[2];
        if (env.playedSteps && !env.playedSteps.has(m[2])) out.dead = true;
        return true;
      }
      if (t === 'hitCount==0') return a.neg;
      return false;
    };
    const say = (a) => (a.or ? a.or.map((c) => c.map(say).join(' && ')).join(' || ') : (a.neg ? '!' : '') + a.text);
    for (const a of site.conds) {
      if (!a.or) { if (!one(a)) out.unknown.push(say(a)); continue; }
      // Alternatives. A rank test decides some of them outright: one that
      // cannot hold drops its alternative, one that holds alone settles the
      // whole atom. What is left is read when it is ONE alternative, or the
      // one pair the events know - a base attack or the finisher.
      let settled = false;
      const alive = [];
      for (const conj of a.or) {
        if (conj.some((x) => !x.or && rankAtom(x) === false)) continue;
        const rest = conj.filter((x) => x.or || rankAtom(x) == null);
        if (!rest.length) { settled = true; break; }
        alive.push(rest);
      }
      if (settled) continue;
      if (!alive.length) { out.dead = true; continue; }
      if (alive.length === 1) {
        for (const x of alive[0]) if (x.or || !one(x)) out.unknown.push(say(x));
        continue;
      }
      const kinds = alive.map((c) => (c.length === 1 && !c[0].or && !c[0].neg
        ? PRESS_FLAG[/^\w+\.(\w+)$/.exec(c[0].text)?.[1]] : null));
      if (alive.length === 2 && kinds.includes('attack') && kinds.includes('combo')) {
        out.flags.add('attack'); out.flags.add('combo');
      } else out.unknown.push(say({ or: alive }));
    }
    return out;
  }
  const PRESS_EVENT = { weaponSkill: 'weapon-skill', classSkill: 'class-skill', skill: 'skill', combo: 'combo', attack: 'attack' };
  // The event a judged site rides: {on, only?, except?, perHit?, critGated?},
  // or {no: <why the fight does not raise it>} (null when the hook itself is
  // simply not one of these).
  function eventOf(site, j) {
    const f = j.flags;
    const h = site.hook;
    // "not a weapon skill" beside "a class skill" says nothing more - the
    // types are disjoint; alone, it is a kind of press nothing counts.
    const refused = [...f].filter((x) => x.startsWith('!'));
    const named = ['weaponSkill', 'classSkill', 'skill', 'combo', 'attack'].filter((k) => f.has(k));
    if (refused.length && !named.length) return { no: `it asks for anything that is not ${refused.map((x) => x.slice(1)).join(', ')}, which the fight does not count` };
    if (h === 'onInflictStatusEval') {
      if (j.statusIs) return { on: 'status-apply', only: j.statusIs };
      if (f.has('foe')) return { on: 'status-apply', except: j.statusNot };
      return { no: null };
    }
    if (h === 'onTryAddStatus') {
      return f.has('cc') ? { on: 'cc-apply' }
        : { no: 'it rides every status you try to apply, crowd control or not, which the fight does not count' };
    }
    if (h === 'onApplyKnockback') return { on: 'knockback' };
    const critGated = f.has('crit');
    if (h === 'onSkillProc' || h === 'onUseSkill') {
      if (f.has('attack') && f.has('combo')) return { on: 'attack-or-combo', critGated };
      return named.length ? { on: PRESS_EVENT[named[0]], critGated } : { no: `${h} with no kind of skill named` };
    }
    if (h === 'onInflictDamage') {
      if (f.has('own')) return { no: 'it rides its own damage only' };
      if (f.has('weaponSkill')) return { on: 'weapon-skill-hit', perHit: true, critGated };
      if (f.has('attack') && f.has('combo')) return { on: 'attack-or-combo', perHit: true, critGated };
      if (f.has('combo')) return { on: 'combo', perHit: true, critGated };
      if (f.has('attack')) return { on: 'attack', perHit: true, critGated };
      if (critGated) return { on: 'crit', perHit: true, critGated };
      return { no: 'it rides every damage instance you deal, which the fight has no event for' };
    }
    if (j.afterStep) {
      return { no: `it is played from where its own ${j.afterStep} step landed${site.loop ? ', several at once around it' : ''} - `
        + 'and where those land is not in the data' };
    }
    return { no: null };
  }
  const EVENT_WORDS = {
    'status-apply': 'every status you land on the foe',
    'cc-apply': 'every crowd control you try to apply',
    knockback: 'every knockback one of your hits applies',
    'weapon-skill': 'every weapon skill you use',
    'weapon-skill-hit': 'every damage instance of a weapon skill',
    'class-skill': 'every class skill you use',
    skill: 'every skill you use',
    combo: 'the combo finisher',
    attack: 'a base attack',
    'attack-or-combo': 'a base attack or a combo finisher',
    crit: 'a critical strike of yours',
  };
  // What the fight reads off a status the FOE wears (`targetState` in
  // damage.mjs): its armour pools and what it takes. A row on anything else -
  // what the foe deals, how fast it moves - prices nothing here.
  const FOE_ATTRS = new Set(['Armor', 'MagicArmor', 'DamageTakenModifier']);
  const stepTypeNames = cdb.enumValues('skill@steps', 'type');
  // skill.flags, by name: the bit a row carries when using it does not stop
  // the skill already running. A build with no such case has no such skill.
  const NON_INTERRUPTING = cdb.enumValues('skill', 'flags').indexOf('NonInterupting');
  const rawStep = (rowId, stepId) => (skills.get(rowId)?.steps ?? []).find((x) => x.id === stepId) ?? null;
  // A status row's lifetime at a rank: `duration`, restated by any
  // props.rankOverride the rank clears (updateSkillInf@21787).
  const lifeAt = (sid, rank) => {
    const r = skills.get(sid);
    let life = Number(r?.duration) > 0 ? Number(r.duration) : 0;
    for (const ov of r?.props?.rankOverride ?? []) {
      if ((ov.minRank ?? 0) <= rank && Number(ov.props?.duration) > 0) life = Number(ov.props.duration);
    }
    return life;
  };
  // A step the script plays, as a line of its own: the passive's profile at
  // the SET's rank carrying only that step's effects. It is not a cast - no
  // clock, no cooldown, no cost.
  const stepProf = (prof, step) => ({
    // Named for the step as well: a set can play several, and two lines both
    // called by the passive's name cannot be told apart in a table.
    ...prof, id: `${prof.id}#${step.stepId}`, name: `${prof.name} (${step.stepId} step)`, effects: step.effects,
    occupancy: 0, cooldown: 0, charges: 1, costs: [], isFiller: false, isCombo: false, scripted: [],
  });
  const carries = (effects) => (effects ?? []).some((e) => ['Damage', 'Heal', 'Shield'].includes(e.kind)
    && (e.baseVal || (e.scaling ?? []).length));

  /**
   * The FIGHT PARTS of one infusion at one set rank - see the header.
   *
   *   dots[]         a status that ticks, put up by an event
   *   foeDebuffs[]   a status the foe wears that an event stacks
   *   triggered[]    a step the script plays on an event, as a rider
   *   eventProcs[]   a cast of its own a counter of status applications arms
   *   alternating[]  two self statuses a timer swaps (each up its share)
   *
   * `pricedStatuses` / `pricedSteps` are what left the refusal list, `labels`
   * says each part in a few words, `notes` keeps WHY a site was not read -
   * keyed by the status or `#step` it would have priced - and `rankOf` maps
   * every row whose profile enters the fight to the rank it was read at.
   */
  function fightOf(id, rank, st, prof, live) {
    const out = {
      dots: [], foeDebuffs: [], triggered: [], eventProcs: [], alternating: [],
      pricedStatuses: new Set(), pricedSteps: new Set(), pricedSkills: new Set(),
      labels: [], notes: new Map(), also: [], rankOf: new Map(), readHooks: new Set(), liveHooks: new Set(),
    };
    const name = prof?.name ?? id;
    const alias = new Map([...live.matchAll(/\b(?:var|final)\s+(\w+)\s*=\s*Skill\.(\w+)\s*;/g)].map((m) => [m[1], m[2]]));
    const ref = (arg) => {
      const m = /^(?:Skill\.)?(\w+)$/.exec(arg ?? '');
      return m ? (skills.has(m[1]) ? m[1] : alias.get(m[1]) ?? null) : null;
    };
    const env = { rank, vars: prof?.vars ?? {}, alias, playedSteps: null };
    const rawSites = sitesOf(live);
    const stepPlayed = (s) => (['playStep', 'playAreaStepFromPt', 'chainStep'].includes(s.call)
      ? /^Steps\.(\w+)$/.exec(s.args[0] ?? '')?.[1] ?? null : null);
    // Which steps anything plays at this rank, before a guard that asks
    // "the area of my own S step" is judged against it (see `judge`).
    env.playedSteps = new Set(rawSites.filter((s) => { const j = judge(s, env); return !j.dead && j.afterStep == null; })
      .map(stepPlayed).filter(Boolean));
    const sites = rawSites.map((s) => {
      const j = judge(s, env);
      return { ...s, j, ev: j.dead ? null : eventOf(s, j) };
    }).filter((s) => !s.j.dead);
    // The hooks that DO something at this rank: a call that is not merely
    // asked in a condition, or a write to something that outlives the hook (a
    // field of the hit, a counter of the script's own - not a `var`). One
    // whose whole body sits behind a rank the set has not reached, or behind
    // a step nothing plays, is neither read nor unread - it is off.
    for (const m of live.matchAll(/function\s+(on[A-Za-z0-9_]*)\s*\(/g)) {
      const writes = hookBody(live, m[1]).replace(/\bvar\s+\w+\s*=[^;]*;/g, ' ');
      if (sites.some((s) => s.hook === m[1] && !s.inCond)
        || /[^=!<>+\-*]=[^=]|[+\-*]=/.test(writes)) out.liveHooks.add(m[1]);
    }
    // Why a site is not read, in one clause.
    const never = (hook) => HOOK_NEVER.find(([re]) => re.test(hook))?.[1](hookBody(live, hook)) ?? null;
    const whyNot = (s) => (never(s.hook) ? `it waits for ${never(s.hook)}`
      : s.j.unknown.length
        ? `its guard asks \`${s.j.unknown.join(' && ')}\`, which this fight cannot answer`
        : s.ev?.no ?? `it is written in ${s.hook}, an event this fight does not raise`);
    const note = (key, why) => { if (!out.notes.has(key)) out.notes.set(key, why); };
    const say = (kind, rowId, text) => out.labels.push({ kind, id: rowId, text });
    const readable = (s) => !s.j.unknown.length && s.ev?.on;
    const isFoe = (s, arg) => /^\w+\.target$/.test(arg ?? '') || (arg === 'target' && s.params.includes('target'));
    const isSelf = (arg) => arg === 'owner' || arg === 'ownerHero';
    const press = new Set(['weapon-skill', 'class-skill']);

    // 1. A STATUS AN EVENT PUTS ON THE FOE. Collected per status first: the
    //    same one can ride two events (Wet rides a control and a knock).
    const onFoe = new Map();   // status -> [site]
    for (const s of sites) {
      if (s.call !== 'addStatus' || s.inCond || !isFoe(s, s.args[0])) continue;
      const x = ref(s.args[1]);
      if (!x) continue;
      // A third argument is a count the script computed, not one application.
      if (s.args.length > 2) { note(x, 'its script hands it a count of its own, which this reader does not follow'); continue; }
      if (!readable(s)) { note(x, whyNot(s)); continue; }
      if (s.j.needs.some((n) => n.kind !== 'foeBelow' || n.status !== x)) {
        note(x, 'its guard asks about a status this fight does not hold for it');
        continue;
      }
      if (!onFoe.has(x)) onFoe.set(x, []);
      onFoe.get(x).push(s);
    }
    // ...and the idiom that SPENDS one: at n stacks the next application is
    // consumed instead and a step of the passive's own is played -
    //   if (getStatusCount(dmg.target, X) >= n) { consumeStatus(dmg.target, X, ..); playStep(Steps.S, dmg.target); }
    //   else addStatus(dmg.target, X);
    const consumers = new Map();   // status -> { at, steps[] }
    for (const s of sites) {
      if (s.call !== 'consumeStatus' || s.inCond || !isFoe(s, s.args[0]) || !readable(s)) continue;
      const x = ref(s.args[1]);
      const need = s.j.needs.find((n) => n.kind === 'foeAtLeast' && n.status === x);
      if (!x || !need || s.j.needs.length !== 1) continue;
      const steps = sites.filter((p) => p.call === 'playStep' && p.conds === s.conds && readable(p))
        .map((p) => /^Steps\.(\w+)$/.exec(p.args[0] ?? '')?.[1]).filter(Boolean);
      consumers.set(x, { at: need.n, steps, on: s.ev.on });
    }
    const linkedKey = (stepId) => `${id}#${stepId}`;
    for (const [x, at] of onFoe) {
      const events = [...new Set(at.map((s) => s.ev.on))];
      const words = events.map((e) => EVENT_WORDS[e] ?? e).join(' and ');
      const chance = Math.min(...at.map((s) => s.j.chance));
      const except = at[0].ev.except ?? null;
      const dot = (st.dots ?? []).find((d) => d.status === x && d.to !== 'Self');
      if (dot) {
        // The fight's dot channels, by the names it raises them under.
        const chan = events.length === 1 ? { 'status-apply': 'status-apply', 'weapon-skill-hit': 'weapon-skill',
          'attack-or-combo': 'attack-or-combo', attack: 'attack', combo: 'combo' }[events[0]] : null;
        if (!chan || (chan === 'status-apply' && except !== x) || dot.pool || dot.uncappedStacks) {
          note(x, chan ? 'its shape is one this reader does not put on the clock (a pool, an uncapped stack, or '
            + 'a status-application rider that does not leave its own applications out)'
            : `it rides ${words}, which the fight raises but has no status-tick channel for`);
          continue;
        }
        out.dots.push({
          ...dot, on: chan, chance, source: 'infusion', from: id, fromName: name, trigger: null,
          why: `applied on ${words}${chance < 1 ? `, ${Math.round(chance * 100)}% of the time` : ''}`,
        });
        out.pricedStatuses.add(x);
        out.rankOf.set(x, rank);
        for (const s of at) out.readHooks.add(s.hook);
        say('status', x, `${label(x)} on the foe: ${dot.stacks > 1 ? `stacking to ${dot.stacks}, ` : ''}applied on ${words}`);
        continue;
      }
      const deb = (st.onTarget ?? []).find((d) => d.status === x && !d.scriptTaken);
      const rows = (deb?.affixes ?? []).filter((a) => FOE_ATTRS.has(a.target?.attribute));
      if (!deb || !rows.length || rows.length !== deb.affixes.length || chance < 1
        || events.some((e) => !['cc-apply', 'knockback', 'weapon-skill-hit'].includes(e))) {
        note(x, !deb || !rows.length
          ? `it rides ${words}, and what it carries is not something this fight reads off the foe`
          : rows.length !== deb.affixes.length
            ? 'one of its rows is on an attribute this fight does not read off the foe'
            : `it rides ${words}${chance < 1 ? ' on a roll' : ''}, a shape the fight has no stacking debuff for`);
        continue;
      }
      const cons = consumers.get(x) ?? null;
      const cap = deb.stacks ?? 1;
      out.foeDebuffs.push({
        status: x, name: nameOf(x) ?? x, from: id, fromName: name, source: 'infusion',
        affixes: rows, cap, duration: lifeAt(x, rank) || deb.duration || 0, on: events,
        ...(cons && events.includes(cons.on) ? { consumeAt: cons.at, consumePlays: linkedKey(cons.steps[0] ?? '') } : {}),
        why: `one stack on ${words}`,
      });
      out.pricedStatuses.add(x);
      for (const s of at) out.readHooks.add(s.hook);
      say('status', x, `${label(x)} on the foe: ${rows.map(fmtAffix).join(', ')} a stack, up to `
        + `${cons ? Math.min(cap, cons.at) : cap}, one stack on ${words}`
        + (cons ? ` (at ${cons.at} the next one spends them)` : ''));
      // The step the consumer plays, and the status that step leaves on what
      // stands in it (an effect flagged StatusLinkedToArea - worn for as long
      // as the area lasts, and the simulated foe does not walk out).
      for (const stepId of cons && events.includes(cons.on) ? cons.steps.slice(0, 1) : []) {
        const step = (prof?.scripted ?? []).find((sc) => sc.stepId === stepId);
        const raw = rawStep(id, stepId);
        if (!step || !carries(step.effects) || stepTypeNames[raw?.type ?? -1] === 'Summon') continue;
        out.triggered.push({
          prof: stepProf(prof, step), source: 'infusion',
          rule: {
            kind: 'linked', key: linkedKey(stepId), chance: 1,
            why: `${name}'s ${stepId} step, played when ${words} finds ${cons.at} stacks of ${nameOf(x) ?? x} on the foe `
              + 'and spends them - the whole of what it deals over its life, priced when it is dropped',
          },
        });
        out.pricedSteps.add(stepId);
        out.rankOf.set(`${id}#${stepId}`, rank);
        say('step', stepId, `its ${stepId} step, each time ${cons.at} stacks of ${nameOf(x) ?? x} are spent`);
        const span = (() => {
          const d = raw?.duration;
          const v = typeof d === 'string' ? env.vars[d] : d;
          return typeof v === 'number' && v > 0 ? v : 0;
        })();
        for (const e of raw?.effects ?? []) {
          // `statusesOf` files a status a script-played step declares under
          // the guard in front of that step's play - here the stack count,
          // which is the consume idiom this reader has just answered - so the
          // entry is taken from where that guard sent it (`unreadable`, for
          // "only while getStatusCount() holds") as well as from the foe's
          // list. The rows are the status's own either way. Only that one
          // refusal is looked through: the status has to be THIS step's
          // effect, refused for the guard on its play and nothing else.
          const leaves = e.status && skills.has(e.status)
            ? (st.onTarget ?? []).find((d) => d.status === e.status)
              ?? (st.unreadable ?? []).find((d) => d.status === e.status && d.to === 'Target' && !!d.trigger?.unread
                && (st.applied ?? []).some((a) => a.status === e.status && a.site?.route === 'effect' && a.site.stepId === stepId))
            : null;
          const lrows = (leaves?.affixes ?? []).filter((a) => FOE_ATTRS.has(a.target?.attribute));
          if (!leaves || !lrows.length || lrows.length !== leaves.affixes.length || !(span > 0)) continue;
          out.foeDebuffs.push({
            status: e.status, name: nameOf(e.status) ?? e.status, from: id, fromName: name, source: 'infusion',
            affixes: lrows, cap: 1, duration: span, on: ['linked:' + linkedKey(stepId)],
            why: `worn while the ${stepId} step's area lasts (${span}s)`,
          });
          out.pricedStatuses.add(e.status);
          say('status', e.status, `${label(e.status)} on the foe for the ${span}s the ${stepId} area lasts: ${lrows.map(fmtAffix).join(', ')}`);
        }
      }
    }

    // 2. A STATUS THE SCRIPT HOLDS ON YOU AS A SWITCH, and the steps it plays
    //    while the switch is on. The switch is opened by one kind of press
    //    and closed by another (`consumeStatus(owner, X) > 0` in that press's
    //    branch); a step played behind `hasStatus(owner, X)` rides the window,
    //    and one played behind the consume itself fires on the press that
    //    closes it, if it was still open.
    const windows = new Map();   // status -> { on, closeOn, duration }
    for (const s of sites) {
      if (s.call !== 'addStatus' || s.inCond || !isSelf(s.args[0]) || s.args.length > 2) continue;
      const w = ref(s.args[1]);
      if (!w || !readable(s) || !press.has(s.ev.on) || s.j.chance < 1) continue;
      if (s.j.needs.some((n) => n.kind !== 'selfConsumes')) continue;
      const life = lifeAt(w, rank);
      if (!(life > 0)) continue;
      const cur = windows.get(w);
      if (cur && cur.on !== s.ev.on) { windows.set(w, { bad: true }); continue; }
      windows.set(w, { on: s.ev.on, closeOn: null, duration: life, hooks: new Set([s.hook]) });
    }
    for (const s of sites) {
      if (s.call !== 'consumeStatus' && s.call !== 'removeStatus') continue;
      const w = isSelf(s.args[0]) ? ref(s.args[1]) : null;
      const win = w ? windows.get(w) : null;
      if (!win || win.bad) continue;
      // A removal the reader cannot place could close the window at any time.
      if (s.j.unknown.length || !s.ev?.on || !press.has(s.ev.on) || (win.closeOn && win.closeOn !== s.ev.on)) { win.bad = true; continue; }
      win.closeOn = s.ev.on;
      win.hooks.add(s.hook);
    }
    const kindOf = { 'attack-or-combo': 'per-attack-or-combo', attack: 'per-attack', combo: 'per-combo',
      'weapon-skill': 'per-weapon-skill', 'class-skill': 'per-class-skill', skill: 'per-skill' };
    for (const s of sites) {
      if (!['playStep', 'playAreaStepFromPt', 'chainStep'].includes(s.call) || s.inCond) continue;
      const stepId = /^Steps\.(\w+)$/.exec(s.args[0] ?? '')?.[1];
      if (!stepId || out.pricedSteps.has(stepId)) continue;
      const key = '#' + stepId;
      // A chain hops between the units it is handed - allies, in every row
      // that calls it - and this fight has one of you.
      if (s.call === 'chainStep') {
        note(key, readable(s) ? 'it is a chain between the allies around you, and this fight has none' : whyNot(s));
        continue;
      }
      const step = (prof?.scripted ?? []).find((sc) => sc.stepId === stepId);
      const raw = rawStep(id, stepId);
      // A Summon step is not a hit of the passive's: what it summons has a
      // row of its own (named below), and an effect row the step also
      // declares is not something a summon is known to deliver.
      if (!step || !carries(step.effects) || stepTypeNames[raw?.type ?? -1] === 'Summon') {
        if (!readable(s)) note(key, whyNot(s));
        // A step that deals nothing of its own (an object dropped on the
        // ground) played on an event the fight raises: read, and worth
        // nothing by itself.
        else if (raw && stepTypeNames[raw.type ?? -1] !== 'Summon') out.readHooks.add(s.hook);
        continue;
      }
      if (!readable(s)) { note(key, whyNot(s)); continue; }
      if (s.loop) { note(key, `its script plays it in a loop (\`${s.loop.replace(/\s+/g, ' ')}\`), and where the copies land is not in the data`); continue; }
      const held = s.j.needs.filter((n) => n.kind === 'selfHas' || n.kind === 'selfConsumes');
      const lacks = s.j.needs.filter((n) => n.kind === 'selfLacks');
      const other = s.j.needs.filter((n) => !['selfHas', 'selfConsumes', 'selfLacks'].includes(n.kind));
      let rule = null;
      if (other.length || held.length > 1) {
        note(key, 'its guard asks about a status this fight does not hold for it');
        continue;
      }
      if (held.length === 1) {
        const w = held[0].status;
        const win = windows.get(w);
        // "...and NOT the other one": answered only when the press that opens
        // this window is the one that takes the other off.
        const implied = lacks.every((n) => windows.get(n.status) && !windows.get(n.status).bad
          && windows.get(n.status).closeOn === win?.on);
        if (!win || win.bad || !implied || !kindOf[s.ev.on]
          || (held[0].kind === 'selfConsumes' && win.closeOn !== s.ev.on)) {
          note(key, `it is played only while ${label(w)} is on you, and this reader cannot place when that is`);
          continue;
        }
        const wname = nameOf(w) ?? w;
        const span = `the ${win.duration}s ${wname} lasts after ${EVENT_WORDS[win.on]}`
          + (win.closeOn ? `, or until ${EVENT_WORDS[win.closeOn].replace('every ', 'the next ')}` : '');
        rule = {
          kind: kindOf[s.ev.on], chance: s.j.chance, critGated: !!s.ev.critGated, perHit: !!s.ev.perHit,
          window: { key: w, on: win.on, closeOn: win.closeOn, duration: win.duration },
          why: held[0].kind === 'selfConsumes'
            ? `${name}'s ${stepId} step, played when ${EVENT_WORDS[s.ev.on].replace('every ', 'a ')} finds ${wname} still on you (${span})`
            : `${name}'s ${stepId} step, played on ${s.ev.perHit ? 'every damage instance of ' : ''}${EVENT_WORDS[s.ev.on]} for ${span}`,
        };
        say('step', stepId, held[0].kind === 'selfConsumes'
          ? `its ${stepId} step when ${EVENT_WORDS[s.ev.on].replace('every ', 'a ')} finds ${label(w)} on you`
          : `its ${stepId} step on ${EVENT_WORDS[s.ev.on]} while ${label(w)} is on you`);
        out.pricedStatuses.add(w);
        for (const h of win.hooks) out.readHooks.add(h);
      } else if (lacks.length) {
        note(key, 'its guard asks about a status this fight does not hold for it');
        continue;
      } else if (s.ev.on === 'crit') {
        // A roll on every critical damage instance the owner lands. The fight
        // has no per-instance event, so it rides the swing and finisher
        // clock at the sheet's crit chance - the FLOOR the status reader
        // already takes for an unpredicated onInflictDamage roll: a weapon
        // skill's hits and a tick that crits raise the hook too.
        rule = {
          kind: 'per-attack-or-combo', chance: s.j.chance, critGated: true, perHit: true,
          why: `${name}'s ${stepId} step, thrown on a critical strike${s.j.chance < 1 ? `, ${Math.round(s.j.chance * 100)}% of the time` : ''}`
            + ' - counted on the damage instances of base attacks and finishers only, a floor (a weapon skill\'s '
            + 'critical hits throw one too)',
        };
        say('step', stepId, `its ${stepId} step on ${s.j.chance < 1 ? `${Math.round(s.j.chance * 100)}% of ` : ''}your critical base attacks and finishers (a floor)`);
      } else if (kindOf[s.ev.on]) {
        rule = {
          kind: kindOf[s.ev.on], chance: s.j.chance, critGated: !!s.ev.critGated, perHit: !!s.ev.perHit,
          why: `${name}'s ${stepId} step, played on ${EVENT_WORDS[s.ev.on]}${s.j.chance < 1 ? `, ${Math.round(s.j.chance * 100)}% of the time` : ''}`,
        };
        say('step', stepId, `its ${stepId} step on ${EVENT_WORDS[s.ev.on]}`);
      } else {
        note(key, `it rides ${EVENT_WORDS[s.ev.on] ?? s.ev.on}, which the fight raises but has no rider for`);
        continue;
      }
      // An area played ON YOU reaches the foe only if it stands inside: this
      // fight has no positions, and takes it to - said on the line, because a
      // ranged build may be further off than the area is wide.
      const range = step.effects.find((e) => e.kind === 'Damage' && e.area)?.area?.range ?? null;
      if (isSelf(s.args[1]) && range != null) {
        rule.why += ` - an area of ${range} around you, and the foe is taken to stand in it`;
      }
      // An area the script throws AT A POINT lands where it was thrown; the
      // foe standing there is hit whatever the row's main-target rule says.
      const atPoint = s.call === 'playAreaStepFromPt';
      out.triggered.push({
        prof: atPoint ? { ...stepProf(prof, step), effects: step.effects.map((e) => ({ ...e, atPosition: true })) } : stepProf(prof, step),
        source: 'infusion', rule,
      });
      out.pricedSteps.add(stepId);
      out.readHooks.add(s.hook);
      out.rankOf.set(`${id}#${stepId}`, rank);
    }

    // ...and a step that IS priced from one site may be played from another
    //    the reader stopped at. That makes the line a floor, and it is said.
    for (const s of sites) {
      if (!['playStep', 'playAreaStepFromPt'].includes(s.call) || s.inCond) continue;
      const stepId = /^Steps\.(\w+)$/.exec(s.args[0] ?? '')?.[1];
      if (!stepId || !out.pricedSteps.has(stepId) || (readable(s) && !s.loop)) continue;
      const text = `its ${stepId} step is also played from ${s.hook}${s.via.length ? ` (through ${s.via.join(' > ')})` : ''}`
        + `${s.loop ? ' in a loop' : ''}, and those are not counted: `
        + (readable(s) ? 'where the copies land is not in the data' : whyNot(s));
      if (!out.also.includes(text)) out.also.push(text);
    }

    // 3. A STATUS THAT TICKS ON YOU, put up by a press (a heal over time on
    //    every skill you use). Same channel the foe-worn ones take.
    for (const s of sites) {
      if (s.call !== 'addStatus' || s.inCond || !isSelf(s.args[0]) || s.args.length > 2) continue;
      const x = ref(s.args[1]);
      const dot = x ? (st.dots ?? []).find((d) => d.status === x && d.to === 'Self') : null;
      if (!dot || out.pricedStatuses.has(x)) continue;
      if (!readable(s) || s.j.needs.length || dot.pool || dot.uncappedStacks) { if (!readable(s)) note(x, whyNot(s)); continue; }
      const chan = { skill: 'skill', 'weapon-skill': 'weapon-skill', combo: 'combo', attack: 'attack', 'attack-or-combo': 'attack-or-combo' }[s.ev.on];
      if (!chan) { note(x, `it rides ${EVENT_WORDS[s.ev.on] ?? s.ev.on}, which the fight has no status-tick channel for`); continue; }
      out.dots.push({
        ...dot, on: chan, chance: s.j.chance, source: 'infusion', from: id, fromName: name, trigger: null,
        why: `applied on ${EVENT_WORDS[s.ev.on]}`,
      });
      out.pricedStatuses.add(x);
      out.rankOf.set(x, rank);
      out.readHooks.add(s.hook);
      say('status', x, `${label(x)} on you: ${dot.stacks > 1 ? `stacking to ${dot.stacks}, ` : ''}applied on ${EVENT_WORDS[s.ev.on]}`);
    }

    // ...and a status the script puts on YOU that none of the shapes above
    //    took. Where the site cannot be read the reason goes with the status;
    //    where it can, the event is known and what the status carries is not
    //    something this fight prices (what the foe deals, what you take). One
    //    of several handed out at random is said to be that.
    for (const s of sites) {
      if (s.call !== 'addStatus' || s.inCond) continue;
      const pick = /^pickRandom\((\w+)\)$/.exec((s.args[1] ?? '').replace(/\s+/g, ''));
      const pool = pick
        ? [...(new RegExp('\\b' + pick[1] + '\\s*=\\s*\\[([^\\]]*)\\]').exec(live)?.[1] ?? '').matchAll(/Skill\.(\w+)/g)]
          .map((m) => m[1]).filter((x) => skills.has(x)) : [];
      for (const x of pool) {
        note(x, `one of ${pool.length} the script hands out at random; `
          + (readable(s) ? 'this reader does not average a random pick' : whyNot(s)));
      }
      const x = isSelf(s.args[0]) ? ref(s.args[1]) : null;
      if (!x || out.pricedStatuses.has(x)) continue;
      // One whose rows the engine's own buff pass takes (`st.self`) is not
      // this pass's to describe: priced or held back, it is said there.
      if ((st.self ?? []).some((b) => b.status === x)) { if (readable(s)) out.readHooks.add(s.hook); continue; }
      if (!readable(s)) { note(x, whyNot(s)); continue; }
      note(x, `it is put on you on ${EVENT_WORDS[s.ev.on] ?? s.ev.on}, and nothing it carries is something this fight prices`);
      out.readHooks.add(s.hook);
    }

    // 4. A COUNTER THAT ARMS A CAST. The script adds a counter status on an
    //    event; the counter's own script, at its cap, hands over a second
    //    status and stops; that status puts a skill on a slot of the bar
    //    (props.status.skillOverride). Pressing that slot uses the OVERRIDE
    //    skill - its own object, with its own cooldown, cost and
    //    checkEnabled, and not the skill the slot held:
    //    client.UnitController.updateSkillInput@13207 ops 29-36 swap `sk` for
    //    ent.Hero.getSkillOverride@7980 (first status whose
    //    Status.getSkillOverride@15847 names the slot -> the hero's own skill
    //    of that id), and ops 54-71 check and request THAT one by kind.
    //
    //    Priced only where the counted event is one the fight holds: the
    //    applications of a status this same passive puts on the foe.
    for (const s of sites) {
      if (s.call !== 'addStatus' || s.inCond || !isSelf(s.args[0]) || s.args.length > 2) continue;
      const c = ref(s.args[1]);
      const crow = c ? skills.get(c) : null;
      const cap = crow?.props?.status?.maxStacks ?? 0;
      const arm = /functiononStacksChange\(\)\{if\((?:stacks==maxStacks|hasStatusMaxStacked\(owner,kind\))\)\{addStatus\(owner,Skill\.(\w+)\);stop\(\);\}\}/
        .exec(stripComments(crow?.script).replace(/\s+/g, ''))?.[1];
      const over = arm ? (skills.get(arm)?.props?.status?.skillOverride ?? []).find((o) => o?.skill && skills.has(o.skill)) : null;
      if (!(cap > 1) || !over) continue;
      const u = over.skill;
      if (!readable(s) || s.j.needs.some((n) => n.kind !== 'selfLacks' || n.status !== arm)) {
        note(u, readable(s) ? 'its counter is fed behind a guard this fight does not hold' : `its counter is fed where ${whyNot(s)}`);
        continue;
      }
      const counted = s.ev.on === 'status-apply' ? s.ev.only : null;
      const fd = counted ? out.foeDebuffs.find((d) => d.status === counted) : null;
      const uprof = combat.profile(u, rank, NO_RUNES);
      if (!fd || !uprof || !carries(uprof.effects)) {
        note(u, counted && !fd ? `its counter counts applications of ${label(counted)}, which this reader could not put on the foe`
          : `its counter climbs on ${EVENT_WORDS[s.ev.on] ?? s.ev.on}, which the fight does not count for it`);
        continue;
      }
      // WHAT THE PRESS COSTS. Priced after the fight, off the count, with no
      // clock of its own - which is only right for a skill whose use does not
      // stop what you are doing: ent.GameObject.doUseSkill@4651 ops 0-10 call
      // stopActiveSkill unless the pressed row is flagged NonInterupting (or
      // is the one already running), and since build 25959898 ops 20-32 skip
      // set_goState(Skill) for that flag too, so the running skill also stays
      // the hero's active one. One that does take the clock would need
      // a press in the rotation, and is named instead.
      if (!(((skills.get(u)?.flags ?? 0) >> NON_INTERRUPTING) & 1)) {
        note(u, `its counter can be counted (${cap} applications of ${fd.name}), but its cast takes the clock like any press, and the fight has no press for a skill a status puts on the bar`);
        continue;
      }
      // What a cast of it puts back into its own counter: the events of its
      // own effects that apply the counted status.
      const selfFeeds = (fd.on.includes('knockback') ? uprof.effects.filter((e) => e.knockBack).length : 0)
        + (fd.on.includes('cc-apply') ? plan.crowdControlOf(u, { rank, runes: NO_RUNES }).filter((cc) => !cc.unpriced).length : 0);
      out.eventProcs.push({
        prof: { ...uprof, cooldown: 0, costs: [] }, from: id, source: 'infusion', countsStatus: counted, cap, selfFeeds,
        why: `one per ${cap} applications of ${fd.name} (the counter ${label(c)} arms it on the ${over.slot} slot for `
          + `${lifeAt(arm, rank) || '?'}s; pressing that slot uses this skill, not the one it holds, and does not `
          + 'stop the skill you are in, so it is priced with no clock of its own - at rest, without what is up when it lands)',
      });
      out.pricedStatuses.add(c).add(arm);
      out.pricedSkills.add(u);
      out.readHooks.add(s.hook);
      out.rankOf.set(u, rank);
      say('skill', u, `${label(u)}, one cast per ${cap} applications of ${fd.name}`);
    }

    // 5. TWO STATUSES A TIMER SWAPS. `onRegUpdate` runs every tick; behind
    //    `time.now < next` -> return and `next = time.now + vars.K`, two
    //    branches each take one status off and put the other on. One is up
    //    at any time, never both: the first for [0, K), the second for
    //    [K, 2K), and so on from the moment combat starts.
    {
      const m = /if\(time\.now<(\w+)\)return;\1=time\.now\+vars\.(\w+);if\((\w+)==0\)\{removeStatus\(owner,Skill\.(\w+)\);addStatus\(owner,Skill\.(\w+)\);\3=1;\}else\{removeStatus\(owner,Skill\.\5\);addStatus\(owner,Skill\.\4\);\3=0;\}/
        .exec(hookBody(live, 'onRegUpdate').replace(/\s+/g, ''));
      const period = m ? env.vars[m[2]] : null;
      if (m && typeof period === 'number' && period > 0) {
        for (const [sid, first] of [[m[5], true], [m[4], false]]) {
          const b = (st.self ?? []).find((x) => x.status === sid);
          if (!b || !b.affixes?.length) continue;
          out.alternating.push({ ...b, alternates: { period, first } });
          out.pricedStatuses.add(sid);
        }
        if (out.alternating.length) {
          out.readHooks.add('onRegUpdate');
          say('status', out.alternating[0].status, `${out.alternating.map((b) => `${b.affixes.map(fmtAffix).join(', ')} (${b.status})`).join(' and ')}, `
            + `swapped every ${period}s in combat - one at a time, each up its share of the fight`);
        }
      }
    }
    return out;
  }

  const cache = new Map();
  /**
   * One infusion at one set rank: what it grants, what of that is priced, and
   * each thing that is not, by name.
   */
  function read(id, rank) {
    const key = id + '@' + rank;
    if (cache.has(key)) return cache.get(key);
    const row = skills.get(id);
    const prof = combat.profile(id, rank, NO_RUNES);
    // `profile()` has already applied conds.minRank / maxRank / equalRank at
    // the rank it was asked for - this is the one place that asks with the
    // SET's rank.
    const affixes = (prof?.affixes ?? []).filter((a) => a.target?.attribute && !a.mod?.dynVal);
    const st = plan.statusesOf(id, { rank, runes: NO_RUNES });
    const live = scriptAtRank(row?.script, rank);
    const declared = [...new Set([...live.matchAll(/function\s+(on[A-Za-z0-9_]*)\s*\(/g)].map((m) => m[1]))];

    // A self status on an event the fight raises. `on: 'cast'` is the status
    // reader's default for a hook it has no event for, and a set passive is
    // never cast - so that one has no clock, whatever the row's numbers say.
    //
    // ONE PLACE downstream still speaks the build's weapon rank: the engine's
    // buff pass asks the applier's COOLDOWN with it, to tell a window from a
    // standing buff. That is harmless only for a host with no cooldown at any
    // rank, which is checked here rather than assumed. Fourteen of the fifteen
    // rows on build 25782799 have none; Gift Beyond Realities
    // (Infusion_Nightling_DPS) authors `cooldown: 1` - the lockout its script
    // spends with consumeCooldown() - and files no self status the fight could
    // ride, so nothing is lost to the guard today. A row it does stop has the
    // status named with THIS reason, not the script's generic one.
    const maxRank = Math.max(cat.infusionCaps.length, cat.ctx.consts.weaponSkillMaxRank ?? 0);
    const cooldowns = Array.from({ length: maxRank }, (_, i) => combat.profile(id, i + 1, NO_RUNES)?.cooldown ?? 0);
    const cooldownFree = cooldowns.every((c) => !(c > 0));
    const ridable = st.self.filter((b) => b.trigger && b.trigger.on !== 'cast' && !b.trigger.unread);
    const buffs = cooldownFree ? ridable : [];
    // ...and what the script does IN the fight, as parts the fight plays.
    const fight = fightOf(id, rank, st, prof, live);
    // The hooks that DO something at this rank (see `liveHooks`): one whose
    // whole body sits behind a rank the set has not reached is not something
    // left unread.
    const hooks = declared.filter((h) => fight.liveHooks.has(h));
    const pricedStatuses = new Set([...buffs.map((b) => b.status), ...fight.pricedStatuses]);
    // What the guard held back, and why - keyed by status for the list below.
    const heldBack = new Map(cooldownFree ? [] : ridable.map((b) => [b.status,
      `not priced: ${b.trigger.why}, but the row has a cooldown (${[...new Set(cooldowns.filter((c) => c > 0))].join(' / ')} s) and `
      + 'the buff pass would read it at the weapon\'s rank, not the set\'s']));

    // Everything the script, AS IT READS AT THIS RANK, names: the statuses it
    // applies, the steps it plays, and - through the statuses' own rows - the
    // follow-up skill a proc status puts on the bar (props.status.skillOverride)
    // or the row itself lists (props.subskills).
    //
    // A status's own script is read at the SAME rank: `rank` inside a status
    // is its applier's (the model's standing rule for every weapon passive
    // whose status carries a `rank >= 3` branch), so Blood Oath's summon and
    // Hive Venom's eruption appear at six pieces and not before.
    const named = new Set();
    const seenScript = new Set();
    // `<row>#<step>` for every step a script PLAYS at this rank - the first
    // argument of playStep / playAreaStepFromPt / chainStep. A bare
    // `Steps.X` in a comparison (`dmg.stepId == Steps.GoldenBomblet`) is a
    // question about a step, not a play of it.
    const played = new Set();
    // Hand one row over: the row, the skill a proc status puts on the bar, and
    // whatever its own script names at this rank. False when it was already
    // in hand (or is not a row at all).
    const nameRow = (sid) => {
      if (sid === id || !skills.has(sid) || named.has(sid)) return false;
      named.add(sid);
      const sub = skills.get(sid);
      for (const over of sub?.props?.status?.skillOverride ?? []) {
        if (over?.skill && skills.has(over.skill)) named.add(over.skill);
      }
      if (sub?.script && !seenScript.has(sid)) { seenScript.add(sid); collect(scriptAtRank(sub.script, rank), sid); }
      return true;
    };
    const collect = (text, host) => {
      for (const m of text.matchAll(/\b\w*[sS]tep\w*\s*\(\s*Steps\.([A-Za-z0-9_]+)/g)) played.add(`${host}#${m[1]}`);
      // ...and not a row it only COMPARES against: `hit.skillId != Skill.X`
      // asks whether something is X, it does not hand X over.
      for (const m of text.matchAll(/(?<![=!]=\s*)\bSkill\.([A-Za-z0-9_]+)/g)) nameRow(m[1]);
    };
    collect(live, id);
    const subskills = new Set((row?.props?.subskills ?? []).map((x) => x.skill).filter(Boolean));
    // At the top rank every skill the row lists under props.subskills is named
    // even when no script line reaches it - a castable nobody mentions is
    // still something the set hands over.
    if (rank >= cat.infusionCaps.length) for (const sid of subskills) if (skills.has(sid)) named.add(sid);

    // ...AND WHAT A ROW HANDS OVER WITH NO SCRIPT LINE AT ALL. Three columns do
    // it as plain data, and a reader that only follows `Skill.X` never meets
    // what is behind them:
    //
    //   step.props.status.ref    the step applies that status - Stench's loop
    //                            puts Infusion_Kobold_Tank_Debuff on every foe
    //                            in range
    //   step.effects[].status    an effect of the step does - Fermentation's
    //                            Cheese step leaves Fermented behind
    //   step.props.summon.unit   the step summons that unit, and the unit's own
    //                            `skills[]` are what it hits with - Blood Oath's
    //                            Obedient Servant, Gift Beyond Realities'
    //                            Nightlord Aspirant
    //
    // A step is followed when it RUNS at this rank, and the step's own `on`
    // column says how it comes to run: a Code or Trigger step only when a
    // script plays it (the two `on` values `profile()` treats as event-played
    // rather than part of the cast), every other with its row - on the row's
    // Start, Refresh, Finish, ProjectileHit and so on. Followed to a fixed
    // point, because a status reached this way has steps and a script of its
    // own.
    const units = cdb.byId('unit');
    const unitName = (u) => units.get(u)?.texts?.name ?? u;
    const scriptPlayed = (st) => SCRIPT_PLAYED.has(stepOnNames[st.on ?? -1]);
    const stepRuns = (hostId, st) => (scriptPlayed(st) ? !!st.id && played.has(`${hostId}#${st.id}`) : true);
    const statusLinks = (st) => [...new Set([st.props?.status?.ref, ...(st.effects ?? []).map((e) => e.status)]
      .filter((ref) => ref && ref !== id && skills.has(ref)))];
    const summonSkills = new Map();   // skill id -> the unit that carries it
    for (let grew = true; grew;) {
      grew = false;
      for (const hostId of [id, ...named]) {
        for (const st of skills.get(hostId)?.steps ?? []) {
          if (!stepRuns(hostId, st)) continue;
          for (const ref of statusLinks(st)) if (nameRow(ref)) grew = true;
          const unit = st.props?.summon?.unit ?? null;
          for (const s of (unit ? units.get(unit)?.skills : null) ?? []) {
            const sid = s.skill ?? s.ref;
            if (!sid || !skills.has(sid) || summonSkills.has(sid)) continue;
            summonSkills.set(sid, unit);
            nameRow(sid);
            grew = true;
          }
        }
      }
    }

    // What each of those carries, AS ITS ROW AUTHORS IT - quoted, not priced.
    // An effect with no amount on the row is one a script fills in
    // (`setDynVal`), and is said to be that rather than printed bare.
    const amounts = (effects, every = null) => (effects ?? [])
      .filter((e) => ['Damage', 'Heal', 'Shield'].includes(e.kind))
      .map((e) => (e.baseVal || (e.scaling ?? []).length ? fmtEffect(e)
        : `${e.kind} of an amount ${e.hasDynVal ? 'a script sets' : 'the row does not author'}`)
        + (every && e.ticks > 1 ? ` every ${every} s` : ''));
    // One step's effects out of a profile. `profile()` keeps a script-played
    // step's apart in `scripted`, except on a looping status, where it folds
    // them into `effects` - so both are looked in, by the step's id.
    const effectsOf = (prof, st) => [
      ...(st.id != null ? prof?.scripted?.find((x) => x.stepId === st.id)?.effects ?? [] : []),
      ...(prof?.effects ?? []).filter((e) => (e.stepId ?? null) === (st.id ?? null)),
    ];
    // What a group of steps does, as phrases: the amounts (one lookup - the
    // steps of a group share their id, and unnamed steps share none), the
    // statuses they apply, and the unit a Summon step names, by its own name.
    //
    // A SUMMON step's own effect rows are said apart. The step makes a unit;
    // an effect row beside it (Gift Beyond Realities' Summon step carries a
    // Heal 0.5 x AllAttributes its tooltip never mentions, a copy of Chain
    // Heal's) is not something a summon is known to deliver, and quoting it
    // as what the step does would be crediting the row for sitting there.
    const stepsDo = (prof, steps, every = null) => {
      const summons = steps.some((st) => stepTypeNames[st.type ?? -1] === 'Summon');
      const own = amounts(effectsOf(prof, steps[0]), every);
      return [
        ...(summons ? [] : own),
        ...new Set(steps.flatMap((st) => statusLinks(st).map((ref) => `applies ${label(ref)}`))),
        ...new Set(steps.map((st) => st.props?.summon?.unit).filter(Boolean).map((u) => `summons ${unitName(u)}`)),
        ...(summons && own.length
          ? [`the step also declares ${own.join(', ')}, and whether a Summon step delivers an effect row is not read`] : []),
      ];
    };
    // The steps of a row a script plays at this rank, each with what it does.
    const stepText = (hostId) => {
      const out = [];
      const prof = combat.profile(hostId, rank, NO_RUNES);
      for (const st of skills.get(hostId)?.steps ?? []) {
        if (!scriptPlayed(st) || !stepRuns(hostId, st)) continue;
        const what = stepsDo(prof, [st]);
        if (what.length) out.push({ stepId: st.id, text: `${st.id} step (${what.join(', ')})` });
      }
      return out;
    };
    // ...and the steps that run WITH the row, grouped by id - the unnamed ones
    // as one group, because an effect of theirs carries no step to tell them
    // apart by. Each: {id, on, what[]}.
    const ownSteps = (hostId) => {
      const prof = combat.profile(hostId, rank, NO_RUNES);
      const every = prof?.isStatusTick ? prof.periodic?.tick : null;
      const groups = new Map();
      for (const st of skills.get(hostId)?.steps ?? []) {
        if (scriptPlayed(st)) continue;
        const k = st.id ?? null;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(st);
      }
      return [...groups].map(([k, steps]) => ({
        id: k, on: [...new Set(steps.map((st) => stepOnNames[st.on ?? -1] ?? null).filter(Boolean))],
        what: stepsDo(prof, steps, every),
      })).filter((g) => g.what.length);
    };
    // A row in full: its name, then in brackets what it carries without a
    // script asking - a status's attribute rows (the rows `profile()` kept at
    // this rank, each PER STACK where the status stacks; one whose value a
    // script computes has no amount to quote) and what the steps that run
    // with the row do - then the steps its script plays.
    const rowText = (sid) => {
      const prof = combat.profile(sid, rank, NO_RUNES);
      const stacks = skills.get(sid)?.props?.status?.maxStacks ?? 1;
      const rows = isStatusRow(sid)
        ? (prof?.affixes ?? []).filter((a) => a.target?.attribute && !a.mod?.dynVal)
          .map((a) => fmtAffix(a) + (stacks > 1 ? ` per stack, up to ${stacks}` : '')) : [];
      const carries = [...rows, ...ownSteps(sid).flatMap((g) => g.what)];
      const steps = stepText(sid);
      return label(sid)
        + (carries.length ? ` [${carries.join(', ')}]` : '')
        + (steps.length ? `, which plays its ${steps.map((x) => x.text).join(' and its ')}` : '');
    };

    // Where the fight reader stopped at a site, the reason goes with the thing
    // the site would have priced.
    const because = (key) => (fight.notes.has(key) ? ` - ${fight.notes.get(key)}` : '');
    const unpriced = [];
    for (const sid of named) {
      if (fight.pricedSkills.has(sid)) continue;
      if (pricedStatuses.has(sid)) {
        // A status that IS in the fight can still play steps of its own that
        // are not: Hive Venom's ticks are scored, the eruption its script
        // plays from them at full stacks is another thing.
        const steps = fight.pricedStatuses.has(sid) ? stepText(sid) : [];
        if (steps.length) {
          const skips = (skills.get(sid)?.steps ?? []).some((x) => steps.some((y) => y.stepId === x.id)
            && x.props?.area?.ignoreMainTarget);
          unpriced.push({
            kind: 'step', id: `${sid}#${steps.map((x) => x.stepId).join('+')}`,
            text: `what ${label(sid)}'s own script plays: its ${steps.map((x) => x.text).join(' and its ')}`
              + (skips ? ' - an area that skips the target it was played on, so against one target it lands on nobody' : ''),
          });
        }
        continue;
      }
      if (isStatusRow(sid)) {
        unpriced.push({
          kind: 'status', id: sid,
          text: `the status ${rowText(sid)}${heldBack.has(sid) ? ` (${heldBack.get(sid)})` : ''}${because(sid)}`,
        });
      } else if (summonSkills.has(sid)) {
        unpriced.push({ kind: 'skill', id: sid, text: `the summoned ${unitName(summonSkills.get(sid))}'s skill ${rowText(sid)}` });
      } else if (subskills.has(sid)) {
        unpriced.push({ kind: 'skill', id: sid, text: `the skill it unlocks, ${rowText(sid)}${because(sid)}` });
      } else {
        // Neither a status nor a listed subskill: a row a script hands over
        // some other way. Named for what is known of it - that it is named.
        unpriced.push({ kind: 'skill', id: sid, text: `the skill ${rowText(sid)}, which a script of the set names` });
      }
    }
    // A status the cooldown guard stopped is named even when no script line
    // spells it `Skill.X` - the status reader can find one another way.
    for (const [sid, held] of heldBack) {
      if (!named.has(sid)) unpriced.push({ kind: 'status', id: sid, text: `the status ${rowText(sid)} (${held})` });
    }
    for (const x of stepText(id)) {
      if (fight.pricedSteps.has(x.stepId)) continue;
      unpriced.push({ kind: 'step', id: x.stepId, text: `its ${x.text}${because('#' + x.stepId)}` });
    }
    for (const text of fight.also) unpriced.push({ kind: 'step', id: null, text });
    // The passive's OWN steps that wait for no script. Whether a set passive
    // ever reaches its Start is not read - nothing casts it - so they are
    // quoted with the event the row authors them on and claimed to do nothing
    // more.
    for (const g of ownSteps(id)) {
      const playedToo = g.id != null && played.has(`${id}#${g.id}`);
      unpriced.push({
        kind: 'step', id: g.id,
        text: `its ${g.id ?? 'unnamed'} step (${g.what.join(', ')}), authored on the passive's own ${g.on.join(' / ') || 'event'}`
          + (playedToo ? '' : ' and played by no script'),
      });
    }
    // A hook with nothing nameable under it - a threat multiplier, a summon,
    // a chain heal's bounce - is still something the row does.
    //
    // The sentence is about the hooks NOTHING was read from: one a fight part
    // came out of, or whose writes the profile's own rider reader took
    // (`runeDamage`, the step-scoped literals), is not "on no clock".
    const readHooks = new Set(fight.readHooks);
    if ((prof?.runeDamage ?? []).some((rd) => rd.stepId && fight.pricedSteps.has(rd.stepId))) readHooks.add('onInflictDamageEval');
    for (const b of buffs) if (b.trigger?.hook) readHooks.add(b.trigger.hook);
    //
    // An EVAL hook (onInflictDamageEval, onInflictHealEval ...) is not an
    // event at all: it rewrites a hit that something else raised. One whose
    // every write is behind `stepId == Steps.X` for a step nothing plays at
    // this rank is off; otherwise it is said for what it writes.
    const left = hooks.filter((h) => !readHooks.has(h));
    const evalWrites = (h) => {
      const body = hookBody(live, h);
      const steps = [...body.matchAll(/\bstepId\s*==\s*Steps\.(\w+)/g)].map((m) => m[1]);
      if (steps.length && steps.every((s2) => !played.has(`${id}#${s2}`))) return null;
      return [...new Set([...body.matchAll(/\b\w+\.(\w+)\s*(?:[+\-*]=|=(?!=))/g)].map((m) => m[1]))];
    };
    const parts = [];
    const waits = [], clock = [];
    for (const h of left) {
      const nv = HOOK_NEVER.find(([re]) => re.test(h))?.[1](hookBody(live, h)) ?? null;
      if (nv) { waits.push(nv); continue; }
      if (/Eval$/.test(h)) {
        const w = evalWrites(h);
        if (w?.length) parts.push(`its ${h} writes ${w.join(', ')} on a hit, which nothing here reads for it`);
        else if (w) clock.push(h);
        continue;
      }
      clock.push(h);
    }
    if (waits.length) parts.unshift(`it waits for ${[...new Set(waits)].join(' and ')}`);
    if (clock.length) parts.push(`no reader in this model puts a set passive's ${clock.join(' / ')} on the fight's clock`);
    const why = parts.length ? parts.join('; ') : null;

    const res = {
      id, name: row?.texts?.name ?? id, rank, title: capTitle(rank),
      affixes, buffs, unpriced, hooks, why, fight,
      // In the number beyond the stat rows, each in a few words: `priced` as
      // {kind, id, text} the way `unpriced` is, `labels` the texts alone, and
      // `pricedIds` every status and skill row a fight part accounts for.
      priced: fight.labels, labels: fight.labels.map((l) => l.text),
      pricedIds: new Set([...fight.pricedStatuses, ...fight.pricedSkills]),
      // Every row of the set: its own, and each status or skill row it
      // reaches - scored, refused or held back alike. A census of the set
      // (which attribute its amounts scale on) walks this, so a row does not
      // leave the count the day its effect is priced.
      family: new Set([id, ...named, ...heldBack.keys(), ...pricedStatuses, ...fight.pricedSkills]),
      scriptedUnpriced: unpriced.length > 0 || parts.length > 0,
    };
    cache.set(key, res);
    return res;
  }

  /**
   * Everything a loadout's infusions contribute.
   *
   * @returns {
   *   sets[]     one per distinct infusion: {id, name, faction, pieces, slots,
   *              rank, nextCap, attached, affixes[], priced[], unpriced[], source}
   *   pieces[]   one per infused piece: {slot, item, infusion, stat, value,
   *              lit, prismatic, pool[], note}
   *   affixes[]  the rank-gated rows of every attached set (for the sheet)
   *   buffs[]    self statuses the engine's buff pass should price
   *   gaps[]     entries for the unscored list
   * }
   */
  // Does THIS build's fight raise the event a status rides. The status reader
  // says which event (`trigger.on`); whether the rotation has one is a fact
  // about the build - a set worn with no weapon has no combo finisher to ride.
  const EVENT_NEEDS = {
    combo: ['a combo finisher', (rot) => (rot?.filler ?? []).some((x) => x.prof?.isCombo)],
    attack: ['a base attack', (rot) => (rot?.filler ?? []).some((x) => !x.prof?.isCombo)],
    'attack-or-combo': ['a base attack', (rot) => (rot?.filler ?? []).length > 0],
    'weapon-skill': ['a weapon skill', (rot) => (rot?.active ?? []).some((x) => x.prof?.type === 'WeaponSkill')],
  };

  function attach(loadout, sets, rot = null) {
    const out = {
      sets: [], pieces: [], affixes: [], buffs: [], gaps: [],
      // What the fight is handed on top of the rotation - see `fightOf`.
      fight: { any: false, dots: [], triggered: [], foeDebuffs: [], eventProcs: [], alternating: [], rankOf: new Map() },
    };
    for (const set of sets) {
      const src = cat.infusionSource(set.id);
      const entry = { ...set, attached: set.rank >= 1, affixes: [], priced: [], fought: [], unpriced: [], source: src };
      if (set.rank >= 1) {
        const r = read(set.id, set.rank);
        // An event the reader knows and this build never raises: named, like
        // everything else that is not in the number.
        const idle = [];
        const buffs = r.buffs.filter((b) => {
          const need = EVENT_NEEDS[b.trigger.on];
          if (need && need[1](rot)) return true;
          idle.push(need
            ? `the status ${label(b.status)} (it rides ${need[0]}, and this build plays none)`
            : `the status ${label(b.status)} (${b.trigger.why}, an event this fight does not raise for a set passive)`);
          return false;
        });
        const unpriced = [...r.unpriced.map((u) => u.text), ...idle];
        entry.title = r.title;
        entry.affixes = r.affixes;
        entry.priced = [
          ...r.affixes.map(fmtAffix),
          ...buffs.map((b) => `${nameOf(b.status) ?? b.status} at its cap (${b.trigger.why})`),
          ...r.labels,
        ];
        for (const k of ['dots', 'triggered', 'foeDebuffs', 'eventProcs', 'alternating']) out.fight[k].push(...r.fight[k]);
        for (const [row, at] of r.fight.rankOf) out.fight.rankOf.set(row, at);
        // The passive itself, for whoever asks a part of it a question by id.
        out.fight.rankOf.set(set.id, set.rank);
        if (r.labels.length) out.fight.any = true;
        entry.unpriced = unpriced;
        entry.why = r.why;
        out.affixes.push(...r.affixes);
        out.buffs.push(...buffs);
        if (r.scriptedUnpriced || idle.length) {
          out.gaps.push({
            id: set.id, name: r.name, source: 'infusion', kind: 'set effect not scored',
            why: `${r.name} is attached at its ${r.title} rank (${set.pieces} piece${set.pieces === 1 ? '' : 's'}, set rank ${set.rank}). `
              + (entry.priced.length ? `Scored: ${entry.priced.join('; ')}. ` : 'Nothing of it is scored at this rank. ')
              + `NOT scored: ${unpriced.length ? unpriced.join('; ') : 'what its script does'}`
              + (r.why ? ` - ${r.why}` : ''),
          });
        }
      } else {
        // Below the first cap. INFERRED: the op that adds the skill is not in
        // the client (see catalog.mjs), and "(2) Set" is the game's own word
        // for the first rank - so one piece attaches nothing here.
        entry.note = `${set.pieces} piece${set.pieces === 1 ? '' : 's'} is below the first set bonus at ${set.nextCap}; `
          + 'nothing is attached (inferred - the attach is server-side)';
      }
      out.sets.push(entry);
    }
    for (const slot of cat.combatSlots()) {
      const g = loadout.gear[slot.id];
      if (!g?.item || !(g.infusion || g.infusionStat || g.prismatic)) continue;
      const item = cat.itemById.get(g.item);
      if (!item) continue;
      const pool = cat.infusionBonusPool(item);
      const inf = g.infusion ? cat.infusions.get(g.infusion) : null;
      const rarity = cat.instanceRarity(item, g);
      const socketed = cat.socketsFor(item).map((t) => loadout.augments?.[`${slot.id}/${t}`]).filter(Boolean);
      const lit = cat.infusionBonusActive(item, g);
      const levelOpts = {
        charLevel: loadout.level, stars: Math.min(g.stars ?? 0, cat.maxStars(item, rarity)), rarity,
        flawless: !!g.flawless, level: g.level ?? null, socketed,
      };
      const value = g.infusionStat ? cat.infusionBonus(item, g.infusionStat, levelOpts) : 0;
      // What an unstated roll could be worth: the best rating in the pool, and
      // only where the piece would pay it at all.
      const ceiling = g.infusion && !g.infusionStat && cat.infusionBonusActive(item, { ...g, infusionStat: pool[0] ?? null })
        ? Math.max(0, ...pool.map((st) => cat.infusionBonus(item, st, levelOpts))) : 0;
      let note = null;
      if (!g.infusion) note = 'not infused, so its bonus stat is dark';
      else if (!g.infusionStat) {
        note = `which rating it rolled is not stated, so no bonus is priced (it is one of ${pool.map((p) => p.replace('Rating', '')).join(', ')})`;
      } else if (!lit) {
        note = `dark: ${inf?.name ?? g.infusion} is a ${inf?.faction ?? '?'} infusion on a ${cat.factionOrigin(item) ?? '?'} piece, and the piece is not Prismatic`;
      } else if (!pool.includes(g.infusionStat)) {
        note = `priced as stored - ${g.infusionStat} is not in the pool this bench computes for the piece (${pool.join(', ') || 'empty'})`;
      }
      out.pieces.push({
        slot: slot.id, item: item.id, infusion: g.infusion ?? null, stat: g.infusionStat ?? null,
        value: lit ? value : 0, wouldBe: value, ceiling, lit, prismatic: !!g.prismatic, pool, note,
      });
      if (g.infusion && g.infusionStat && lit && !pool.includes(g.infusionStat)) {
        out.gaps.push({
          id: item.id, name: item.name, source: slot.id, kind: 'assumption',
          why: `${item.name}'s infusion bonus is priced as stored (${value} ${g.infusionStat}), but ${g.infusionStat} is not `
            + `a rating this bench expects the piece to roll (${pool.join(', ') || 'none'}): the game removes the ratings a `
            + 'piece already pays before it rolls, so either the dump is wrong or the pool is',
        });
      }
    }
    // One line for the pieces whose roll nobody stated, not one per piece.
    const blind = out.pieces.filter((p) => p.infusion && !p.stat);
    if (blind.length) {
      const low = blind.reduce((s, p) => s + p.ceiling, 0);
      out.gaps.push({
        id: 'infusion-bonus', name: 'Infusion bonus', source: 'infusion', kind: 'assumption',
        why: `${blind.length} infused piece${blind.length === 1 ? '' : 's'} (${blind.map((p) => p.slot.replace('Slot_', '')).join(', ')}) `
          + 'state no bonus stat, so none is priced: the rating is rolled when the piece is looted and nothing derives it. '
          + (low > 0
            ? `Only a faction-matched or Prismatic piece is paid it; ${blind.filter((p) => p.ceiling > 0).length} of these would be, `
              + `so this reads LOW by up to ${low} rating`
            : 'None of them is faction-matched or Prismatic, so none would be paid it anyway'),
      });
    }
    return out;
  }

  /**
   * The share of a fight of `seconds` one of two timer-swapped statuses is
   * up. The script starts on the first the moment combat does and swaps every
   * `period`, so the first holds [0, p), [2p, 3p), ... - exactly half only
   * when the fight is a whole number of 2p. Scheduled, not averaged.
   */
  function alternatingShare(alternates, seconds) {
    const { period: p, first } = alternates;
    if (!(seconds > 0) || !(p > 0)) return 0;
    const mine = Math.floor(seconds / (2 * p)) * p + Math.min(p, seconds % (2 * p));
    return (first ? mine : seconds - mine) / seconds;
  }

  /**
   * After the fight: what each part came to, in a sentence on its set
   * (`fought`), and a line for every part the fight never raised the event
   * for. A part is in the number whether or not anything rode it - a zero is
   * a fact about the build, and it is said rather than left to be found.
   *
   * @returns gaps[] for the unscored list (kind `off in this build`)
   */
  function settle(attached, tp) {
    const lineOf = new Map((tp?.lines ?? []).map((l) => [l.id, l]));
    const T = tp?.elapsed ?? tp?.fight ?? 0;
    const rate = (l) => {
      const d = T > 0 ? (l.total?.damage ?? 0) / T : 0;
      const h = T > 0 ? (l.total?.heal ?? 0) / T : 0;
      return [d > 0 ? `${d.toFixed(1)} dps` : null, h > 0 ? `${h.toFixed(1)} hps` : null].filter(Boolean).join(', ') || '0 dps';
    };
    const gaps = [];
    for (const entry of attached.sets) {
      if (!entry.attached) continue;
      const f = read(entry.id, entry.rank).fight;
      const idle = [];
      for (const d of f.dots) {
        const l = lineOf.get(d.status);
        if (l) entry.fought.push(`${d.name}: ${Math.round(l.hits)} ticks, ${rate(l)}`);
        else idle.push(`${d.name} (${d.why} - the fight raised none)`);
      }
      for (const fd of f.foeDebuffs) {
        const got = (tp?.foeDebuffs ?? []).find((x) => x.status === fd.status);
        const top = fd.consumeAt != null ? Math.min(fd.cap, fd.consumeAt) : fd.cap;
        // The knocks this build pressed that author no force: left out of
        // the count (damage.mjs `knockNoForce`), and said where the count is.
        const unforced = fd.on.includes('knockback') ? Math.round(tp?.events?.['knock-no-force'] ?? 0) : 0;
        const leftOut = unforced > 0
          ? `${unforced} knock${unforced === 1 ? '' : 's'} of this build that author${unforced === 1 ? 's' : ''} no force `
            + `${unforced === 1 ? 'is' : 'are'} not counted (whether one raises the hook is the server's to say)`
          : '';
        if (got && got.applied > 0) {
          entry.fought.push(`${fd.name}: ${got.meanStacks.toFixed(2)} of ${top} stacks on the foe on average, up `
            + `${(got.uptime * 100).toFixed(0)}% of the fight, ${Math.round(got.applied)} applications`
            + (got.consumed > 0 ? `, spent ${Math.round(got.consumed)} times` : '')
            + (leftOut ? `; ${leftOut}` : ''));
        } else if (!fd.on.some((e) => e.startsWith('linked:'))) {
          idle.push(`${fd.name} (${fd.why} - this build lands none${leftOut ? `; ${leftOut}` : ''})`);
        }
      }
      for (const tr of f.triggered) {
        const l = lineOf.get(tr.prof.id);
        const step = tr.prof.id.split('#')[1];
        if (l) entry.fought.push(`${step} step: ${Math.round(l.hits)} hits, ${rate(l)}`);
        else idle.push(`its ${step} step (${tr.rule.why} - it never fired here)`);
      }
      for (const ep of f.eventProcs) {
        const l = lineOf.get(ep.prof.id);
        const got = (tp?.eventProcs ?? []).find((x) => x.id === ep.prof.id);
        if (l) entry.fought.push(`${ep.prof.name}: ${Math.round(got?.fires ?? 0)} casts, ${rate(l)}`);
        else idle.push(`${ep.prof.name} (${ep.why} - ${Math.round(got?.counted ?? 0)} counted, short of one cast)`);
      }
      for (const b of f.alternating) {
        entry.fought.push(`${b.affixes.map(fmtAffix).join(', ')}: up ${(alternatingShare(b.alternates, T) * 100).toFixed(0)}% of the fight`);
      }
      if (idle.length) {
        gaps.push({
          id: entry.id, name: entry.name, source: 'infusion', kind: 'off in this build',
          why: `${entry.name} is read, and ${idle.length === 1 ? 'one part of it is' : `${idle.length} parts of it are`} `
            + `worth nothing in this fight: ${idle.join('; ')}`,
        });
      }
    }
    return gaps;
  }

  return { read, attach, settle, alternatingShare };
}
