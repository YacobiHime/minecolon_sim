'use strict';
// 動けない状態を防ぐ・見張る・回復する (2026-11-05 の実行で6人が同じ場所から動けなくなった件)。
//
//   原因 (本命): mineflayer-pathfinder の returningPos。LOSWhenPlacingBlocks が true で足場を置くと設定され、
//     monitorMovement が毎 tick まずそこへ歩こうとして、着くまで何もしない。resetPath・setGoal(null)・stop()・死亡で消えないので、
//     着けない位置だと goto が永久に止まる。→ spawn 時に LOSWhenPlacingBlocks = false (setupPathfinder)。
//     念のため patches/mineflayer-pathfinder+2.4.5.patch (patch-package) で resetPath・stop で消し、
//     bot.pathfinder.getReturningPos / clearReturningPos を足した。ここではそれがあるときだけ使う。
//   竹 (bamboo): 当たり判定は細い柱で、サーバーでは場所ごとにずれる。pathfinder は満ブロックとして上に立てると思い込む
//     (竹林の上 4〜6m で止まった)。→ fences (乗れない・通れない = 通るなら壊す) に入れる。
//
//   gotoProgress: goto を「noProgressMs (既定 10秒) で minProgress (1m) も目標に近づかなければやめる」にする。
//     掘る・置くあいだは workGraceMs まで待つ。やめたら NoProgress (pathErr は「動けなかった」)。
//   行動ごとの記録 (beginAction / endAction): goto の回数・打ち切り・押し戻し (forcedMove)・path_reset の理由・
//     isMining/isBuilding/isMoving の割合・returningPos があったか。
//   StuckWatch: 移動系の行動 (goto を使い、失敗したか打ち切られた) が続けて stuckRepeat 回、stuckMoved 未満しか動かなければ「動けない」。
//   recover: setGoal(null) → returningPos を消す → 後ろへ下がって跳ぶ → すぐ横・足元の竹・葉などを掘って抜ける。
//     それでも駄目なら agent.js が同じ名前で入り直す。

const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const { sleep, dist3 } = require('./util');

const UNSTUCK_DEFAULTS = {
  noProgressMs: 10000, minProgress: 1, sampleMs: 500, workGraceMs: 20000,
  stuckMoved: 1, stuckRepeat: 2, troubleLoops: 3,
  backMs: 700, digMax: 4, digMaxTimeMs: 3000, walkMs: 900,
  reconnect: true, reconnectWaitMs: 4000, reconnectTimeoutMs: 60000,
  avoidBamboo: true, losWhenPlacing: false,
  avoidFarmland: true,
};

// 掘って抜けるときに先に狙う物 (当たり判定がずれやすい・柔らかい)
const SOFT_RE = /bamboo|leaves|scaffolding|vine|cobweb|_carpet$|snow|pointed_dripstone|sugar_cane|kelp|azalea/;
// 柔らかくなくても掘ってよい物: 自然の地面と、pathfinder が足場に使う土・丸石 (板材・原木などは小屋の壁かもしれないので掘らない)
const NATURAL_RE = /^(dirt|grass_block|coarse_dirt|podzol|rooted_dirt|mud|sand|red_sand|gravel|clay|stone|cobblestone|deepslate|cobbled_deepslate|andesite|diorite|granite|tuff|calcite|netherrack|snow_block|moss_block)$/;
// 動くための行動 (失敗して動かなければ、打ち切りでなくても「動けない」に数える)
const MOVE_ACTIONS = new Set(['go_to', 'explore', 'search', 'flee', 'pick_up', 'follow', 'call']);

function cfgOf(bot, o = {}) { return { ...UNSTUCK_DEFAULTS, ...((bot && bot.__unstuckCfg) || {}), ...o }; }

// returningPos (patch があるとき)。無ければ null
function returningPosOf(bot) {
  const pf = bot && bot.pathfinder;
  if (!pf || typeof pf.getReturningPos !== 'function') return null;
  try { return pf.getReturningPos() || null; } catch (_) { return null; }
}

// returningPos を消す。消したら true。patch が無ければ、LOSWhenPlacingBlocks を false にする (それで returningPos は使われない)
function clearReturning(bot) {
  const pf = bot && bot.pathfinder;
  if (!pf) return false;
  let had = false;
  if (typeof pf.clearReturningPos === 'function') { try { had = !!pf.clearReturningPos(); } catch (_) { /* ignore */ } }
  else pf.LOSWhenPlacingBlocks = false;
  return had;
}

function haltPath(bot) {
  try { bot.pathfinder.setGoal(null); } catch (_) { /* ignore */ }
  try { bot.clearControlStates(); } catch (_) { /* ignore */ }
}

// ---- 行動ごとの記録 ----
function freshStats() {
  return { gotos: 0, noProgress: 0, forced: 0, resets: {}, samples: 0, mining: 0, building: 0, moving: 0, returning: 0, returningCleared: 0 };
}
function stats(bot) { if (!bot.__mv) bot.__mv = freshStats(); return bot.__mv; }
function beginAction(bot) { bot.__mv = freshStats(); bot.__mvStart = bot.entity ? bot.entity.position.clone() : null; }
// 行動の終わり: returningPos を消し、記録を返す (goto を使わなかった行動は null。記録の行を軽くする)
function endAction(bot) {
  const s = stats(bot);
  if (clearReturning(bot)) s.returningCleared += 1;
  const start = bot.__mvStart;
  const moved = start && bot.entity ? Math.round(dist3(start, bot.entity.position) * 10) / 10 : null;
  bot.__mv = freshStats();
  if (!s.gotos && !s.forced && !s.returningCleared) return null;
  const pct = (n) => (s.samples ? Math.round((n / s.samples) * 100) / 100 : 0);
  const out = { gotos: s.gotos, moved };
  if (s.noProgress) out.noProgress = s.noProgress;
  if (s.forced) out.forced = s.forced;
  if (Object.keys(s.resets).length) out.resets = s.resets;
  if (s.samples) { out.mining = pct(s.mining); out.building = pct(s.building); out.moving = pct(s.moving); }
  if (s.returning) out.returning = pct(s.returning);
  if (s.returningCleared) out.returningCleared = s.returningCleared;
  return out;
}

// spawn 時に1回: pathfinder の設定と見張り
function setupPathfinder(bot, movements, o = {}) {
  const c = { ...UNSTUCK_DEFAULTS, ...o };
  bot.__unstuckCfg = c;
  bot.pathfinder.LOSWhenPlacingBlocks = !!c.losWhenPlacing;
  if (movements && c.avoidBamboo) {
    // 竹: 乗れない・通れない (fences = physical でなく safe でもない) → 通り道にあれば pathfinder が掘ってから進む
    const b = bot.registry.blocksByName.bamboo;
    if (b && movements.fences) movements.fences.add(b.id);
  }
  if (movements && c.avoidFarmland) {
    // 耕地: 上に乗らない・通らない・掘らない (fences + blocksCantBreak)。乗ったあとの跳ぶ・落ちるで踏まれて土に戻る (仕様) のを避ける。
    //   2026-11-06 の実行では、水の近くで土に戻った7回のうち4回が、go_to・use_on の歩きで耕地の上に下りた・跳んだあと
    const f = bot.registry.blocksByName.farmland;
    if (f && movements.fences) movements.fences.add(f.id);
    if (f && movements.blocksCantBreak) movements.blocksCantBreak.add(f.id);
  }
  bot.on('forcedMove', () => { stats(bot).forced += 1; });
  bot.on('path_reset', (reason) => { const r = stats(bot).resets; r[reason] = (r[reason] || 0) + 1; });
  for (const ev of ['death', 'respawn', 'spawn']) bot.on(ev, () => clearReturning(bot));
}

function NoProgressError(ms) {
  const e = new Error(`no progress for ${Math.round(ms / 1000)}s`);
  e.name = 'NoProgress';
  return e;
}

// 目標までの近さ (小さいほど近い)。heuristic の無い目標は、動いた距離のマイナス
function closeness(goal, start, pos) {
  if (goal && typeof goal.heuristic === 'function' && goal.heuristic !== goals.Goal.prototype.heuristic) {
    try { const h = goal.heuristic(pos); if (Number.isFinite(h)) return h; } catch (_) { /* fallthrough */ }
  }
  return -dist3(start, pos);
}

// goto を進み具合で打ち切る。opts: { noProgressMs, minProgress, sampleMs, workGraceMs }
async function gotoProgress(bot, goal, opts = {}) {
  const c = cfgOf(bot, opts);
  const st = stats(bot);
  st.gotos += 1;
  const p = bot.pathfinder.goto(goal);
  if (!(c.noProgressMs > 0) || !bot.entity) return p;
  const start = bot.entity.position.clone();
  let best = closeness(goal, start, start);
  let lastGood = Date.now();
  let grace = 0;
  let timer = null;
  const watch = new Promise((_, reject) => {
    timer = setInterval(() => {
      if (!bot.entity) return;
      const pf = bot.pathfinder;
      const mining = pf.isMining && pf.isMining();
      const building = pf.isBuilding && pf.isBuilding();
      st.samples += 1;
      if (mining) st.mining += 1;
      if (building) st.building += 1;
      if (pf.isMoving && pf.isMoving()) st.moving += 1;
      if (returningPosOf(bot)) st.returning += 1;
      const now = Date.now();
      const s = closeness(goal, start, bot.entity.position);
      if (s < best - c.minProgress) { best = s; lastGood = now; } else if ((mining || building) && grace < c.workGraceMs) { grace += c.sampleMs; lastGood += c.sampleMs; }
      if (now - lastGood >= c.noProgressMs) {
        clearInterval(timer);
        st.noProgress += 1;
        reject(NoProgressError(c.noProgressMs)); // 先に (setGoal(null) で goto が GoalChanged になるより前に) 決める
        haltPath(bot);
      }
    }, c.sampleMs);
  });
  try {
    return await Promise.race([p, watch]);
  } finally {
    clearInterval(timer);
    p.catch(() => {});
  }
}

// ---- 見張り ----
class StuckWatch {
  constructor(cfg = {}) { this.cfg = { ...UNSTUCK_DEFAULTS, ...cfg }; this.run = 0; this.last = null; this.troubleUntil = -1; this.troubleMsg = ''; this.count = 0; }

  // 行動の後に呼ぶ。move = endAction の値 (null = 移動しない行動)。返り値: 今「動けない」になったか
  note({ action, ok, move }) {
    if (!move || !move.gotos) return false; // 移動しない行動は数えない (続けての数は保つ)
    // 打ち切られた (近づけなかった) か、動くための行動が失敗した。届かない物を掘ろうとして失敗しただけ (collect など) は数えない
    const stuckish = move.moved != null && move.moved < this.cfg.stuckMoved && (move.noProgress > 0 || (!ok && MOVE_ACTIONS.has(action)));
    if (!stuckish) { this.run = 0; return false; }
    this.run += 1;
    this.last = { action, moved: move.moved };
    return this.run >= this.cfg.stuckRepeat;
  }

  // 回復した (しなかった) あと: 数え直し、困りごとを troubleLoops ループ出す
  noteRecovery(tick, rec) {
    this.run = 0;
    this.count += 1;
    this.troubleUntil = tick + this.cfg.troubleLoops;
    this.troubleMsg = rec && rec.ok ? `回復: ${rec.how}` : '回復できなかった';
  }

  // 困りごと (ask.troubles と同じ形)。出していなければ null
  trouble(tick) {
    if (tick > this.troubleUntil) return null;
    return { key: 'stuck:', kind: 'stuck', about: 'その場から動けない', lastMsg: `移動が続けて1m未満だった (${this.troubleMsg})` };
  }
}

// ---- 回復 ----
async function backAndJump(bot, ms) {
  try {
    bot.setControlState('back', true);
    bot.setControlState('jump', true);
    await sleep(ms);
  } finally { try { bot.clearControlStates(); } catch (_) { /* ignore */ } }
  await sleep(300);
}

// すぐ横 (足と頭の高さ)・頭の上・足元の竹などで、当たり判定のある掘れる物。柔らかい順
function blockersAround(bot, maxMs) {
  const f = bot.entity.position.floored();
  const out = [];
  const offs = [];
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, 1]) offs.push([dx, dy, dz]);
  offs.push([0, 2, 0]);
  offs.push([0, -1, 0]); // 足元 (竹の上に乗っているとき)
  for (const [dx, dy, dz] of offs) {
    const b = bot.blockAt(f.offset(dx, dy, dz));
    if (!b || b.boundingBox !== 'block') continue;
    const soft = SOFT_RE.test(b.name);
    if (dy === -1 && !/bamboo|leaves|scaffolding/.test(b.name)) continue; // 足元は竹・葉だけ (地面は掘らない)
    let t = 0;
    try { t = typeof b.digTime === 'function' ? b.digTime(bot.heldItem ? bot.heldItem.type : null, false, false, false, [], []) : 0; } catch (_) { t = 0; }
    if (!soft && !(NATURAL_RE.test(b.name) && t <= maxMs)) continue;
    if (typeof bot.canDigBlock === 'function' && !bot.canDigBlock(b)) continue;
    out.push({ b, d: [dx, dy, dz], soft, t });
  }
  return out.sort((a, b) => (b.soft - a.soft) || (a.t - b.t));
}

// 回復手順。返り値 { ok, how, moved, steps: [...], returning (returningPos があったか) }
async function recover(bot, opts = {}) {
  const c = cfgOf(bot, opts);
  const steps = [];
  if (!bot.entity) return { ok: false, how: '体が無い', moved: 0, steps };
  const start = bot.entity.position.clone();
  const movedNow = () => Math.round(dist3(start, bot.entity.position) * 10) / 10;
  haltPath(bot);
  steps.push('halt');
  const returning = returningPosOf(bot);
  const hadRet = clearReturning(bot);
  steps.push(hadRet ? 'returning_cleared' : 'returning_none');
  await backAndJump(bot, c.backMs);
  steps.push(`back_jump:${movedNow()}`);
  if (movedNow() >= c.stuckMoved) return { ok: true, how: '後ろへ下がって跳んだら動けた', moved: movedNow(), steps, returning: !!returning || hadRet };
  const dug = [];
  for (const x of blockersAround(bot, c.digMaxTimeMs).slice(0, c.digMax)) {
    try { await bot.dig(x.b, true); dug.push(x.b.name); } catch (e) { steps.push(`dig_fail:${x.b.name}`); }
  }
  steps.push(`dig:${dug.join(',') || '-'}`);
  // 掘った方 (無ければ前) へ少し歩いて跳ぶ
  try {
    bot.setControlState('forward', true);
    bot.setControlState('jump', true);
    await sleep(c.walkMs);
  } finally { try { bot.clearControlStates(); } catch (_) { /* ignore */ } }
  await sleep(300);
  steps.push(`walk:${movedNow()}`);
  if (movedNow() >= c.stuckMoved) return { ok: true, how: dug.length ? `すぐ横の${[...new Set(dug)].join('・')}を掘ったら動けた` : '歩いて跳んだら動けた', moved: movedNow(), steps, dug, returning: !!returning || hadRet };
  return { ok: false, how: dug.length ? `${[...new Set(dug)].join('・')}を掘っても動けなかった` : '下がっても掘っても動けなかった', moved: movedNow(), steps, dug, returning: !!returning || hadRet };
}

module.exports = { UNSTUCK_DEFAULTS, setupPathfinder, gotoProgress, beginAction, endAction, StuckWatch, recover, clearReturning, returningPosOf, closeness, blockersAround, NoProgressError };
