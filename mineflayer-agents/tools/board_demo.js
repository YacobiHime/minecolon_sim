#!/usr/bin/env node
'use strict';
// 全体チャット (board.js) の試し: 2B を実際に呼んで broadcast の文・propose の文 (と構造) を作り、
// Jev (本物、/root/.config/typesafe.env のキー) に、提案を聞いた何人かが賛成するか (agree_q1 の noul) を聞く。bot はつながない。
//   LLM_BASE_URL=http://192.168.15.30:18081 node tools/board_demo.js [--no-jev] [--json]
const path = require('path');
const { loadConfig } = require('../src/config');
const { Talker } = require('../src/talker');
const { Board, parseLine, line } = require('../src/board');
const { buildContext } = require('../src/agent');
const { Memory } = require('../src/memory');
const { JevDecider, buildStateEn } = require('../src/deciders/jev');
const { JevClient } = require('../src/jev_client');
const { UsageMeter } = require('../src/usage');
const { Social } = require('../src/social');
const { estimateTokens } = require('../src/usage');

const args = process.argv.slice(2);
const cfg = loadConfig(path.join(__dirname, '..', 'configs', 'survival_3days.json'));
const persona = (n) => cfg.personas.find((p) => p.name === n);
const meter = new UsageMeter();
const talker = new Talker({ llmOpts: { ...cfg.decider.llm, baseUrl: process.env.LLM_BASE_URL || 'http://192.168.15.30:18081', ...cfg.talk.llm }, meter });
const blk = (name, x, z, notable = false) => ({ name, notable, diggable: true, seen: 3, nearest: { x, y: 64, z, d: Math.round(Math.hypot(x, z)) }, positions: [] });
const rawOf = (name, over = {}) => ({ self: { name, pos: { x: 0, y: 64, z: 0 }, health: 20, food: 16, timeOfDay: 4000, phase: '昼', day: 1 }, inventory: [], blocks: [blk('oak_log', 6, -3, true), blk('grass_block', 1, 0)], entities: [], heard: [], craft: { now: [], withTable: [] }, tableNearby: null, ...over });

async function main() {
  const out = { broadcast: [], propose: [], votes: [] };
  // ---- 2B: broadcast ----
  const bctx = [
    { who: 'Ken', plan: 'ゴール: 拠点の近くの囲いの中に sheep が2頭いる / 道筋: oak_fence 23 ← …', social: '少し人恋しい。落ち着いている', board: '## 全体に届いた話\nMai「羊毛がほしいな」' },
    { who: 'Yuki', plan: 'ゴール: 拠点の近くに明かりが4個ある / 次: coal を手に入れる', social: 'もうすぐ暗くなるし、外にいるので落ち着かない', board: '' },
    { who: 'Daiki', plan: 'ゴール: iron_ingot 3', social: '物が少なくて落ち着かない', board: '## 共有のチェスト\n- Hanako-1 (北 20m): white_wool 2, oak_planks 10' },
  ];
  for (const c of bctx) {
    const r = await talker.broadcast({ persona: persona(c.who), goal: { text: '' }, plan: c.plan, socialText: c.social, nearText: '', heardText: '', memText: '', boardText: c.board });
    out.broadcast.push({ who: c.who, say: r.say, error: r.error, promptTokens: r.promptTokens, ms: r.ms });
  }
  // ---- 2B: propose ----
  const pctx = [
    { who: 'Hanako', items: ['white_wool', 'oak_planks', 'white_bed', 'bread', 'torch'], chests: [{ id: 'Hanako-1', text: '東 3m・white_wool 2' }], hereChest: false, plan: 'ゴール: white_bed 1 / 道筋: white_wool 3 ← sheep', social: '誰かの役に立ちたい。少し人恋しい', board: '## 全体に届いた話\nKen「夜が来る前に寝床をなんとかしたい」' },
    { who: 'Ken', items: ['white_bed', 'torch', 'oak_log', 'cobblestone'], chests: [], hereChest: true, plan: 'ゴール: 拠点の近くに明かりが4個ある', social: '段取りを決めたい。落ち着いている', board: '' },
    { who: 'Rin', items: ['bread', 'wheat', 'iron_ingot'], chests: [{ id: 'Taro-1', text: '西 30m・bread 4' }], hereChest: false, plan: 'ゴール: bread 3', social: '少しお腹が空いた', board: '## 共有のチェスト\n- Taro-1 (西 30m): bread 4' },
  ];
  for (const c of pctx) {
    const r = await talker.propose({ persona: persona(c.who), goal: { text: '' }, plan: c.plan, socialText: c.social, nearText: '', heardText: '', memText: '', boardText: c.board, items: c.items, chests: c.chests, hereChest: c.hereChest });
    out.propose.push({ who: c.who, raw: r.rawOutput, proposal: r.proposal, error: r.error, promptTokens: r.promptTokens, ms: r.ms });
  }
  // ---- Jev: 提案を聞いた人が賛成するか ----
  if (!args.includes('--no-jev')) {
    const jev = new JevDecider({ ...cfg.decider.jev, meter, client: new JevClient(cfg.decider.jev) });
    const hp = out.propose.find((x) => x.who === 'Hanako' && x.proposal);
    const prop = hp ? hp.proposal : { spec: { type: 'rule', item: 'white_wool', chest: 'Hanako-1' }, text: '羊毛は Hanako-1 のチェストに入れよう' };
    const voters = [
      { who: 'Sayaka', aff: 80, plan: null, social: 'calm; wants to be useful to someone' },
      { who: 'Jiro', aff: 35, plan: 'obtain iron_pickaxe x1', social: 'impatient; a little stressed' },
      { who: 'Daiki', aff: 50, plan: 'obtain white_wool x6', social: 'uneasy without lots of things' },
      { who: 'Mai', aff: 65, plan: 'obtain white_bed x1', social: 'a little lonely' },
    ];
    for (const v of voters) {
      const p = persona(v.who);
      const board = new Board({ cfg: cfg.board, me: v.who });
      board.receive('Hanako', parseLine(line.share('Hanako-1', { x: 10, y: 64, z: -2 })), { tick: 5 });
      board.receive('Hanako', parseLine(line.chest('Hanako-1', 'Hanako', null, [{ name: 'white_wool', count: 2 }, { name: 'oak_planks', count: 10 }])), { tick: 5 });
      board.receive('Ken', parseLine(line.say('夜が来る前に寝床をなんとかしたい')), { tick: 5 });
      board.receive('Hanako', parseLine(line.propose({ id: 'Hanako#7', n: 20, spec: prop.spec, text: prop.text })), { tick: 6 });
      const social = new Social({ temperament: p.temperament });
      social.rel('Hanako').affinity = v.aff;
      const shown = board.select({ me: v.who, tick: 6 });
      const open = board.openFor(v.who);
      const bview = board.stateEn({ me: v.who, tick: 6, here: { x: 0, y: 64, z: 0 }, shown, open, relationEn: (n) => social.relationWord(n, { lang: 'en' }) });
      const raw = rawOf(v.who, { inventory: v.who === 'Daiki' ? [{ name: 'white_wool', count: 1 }] : [{ name: 'bread', count: 2 }] });
      const vcfg = { ...cfg, persona: p };
      const m = new Memory({ limits: cfg.memory.limits });
      const ctx = buildContext(raw, m, vcfg, { foods: new Set(['bread']), socialEn: `${v.social}; with Hanako: ${social.relationWord('Hanako', { lang: 'en' })}`, lastResultEn: 'none',
        boardEn: { state: bview.state, open: bview.open, breakers: bview.breakers }, boardText: board.textJa({ shown }), planEn: v.plan ? { goal: v.plan } : null });
      ctx.goalPath = true;
      const dec = await jev.decide(ctx);
      const st = buildStateEn(ctx, {});
      out.votes.push({ who: v.who, relation: social.relationWord('Hanako', { lang: 'en' }), agreeP: dec.jev && dec.jev.agree ? dec.jev.agree.q1 : null, vote: dec.jev && dec.jev.agree && dec.jev.agree.q1 != null ? (dec.jev.agree.q1 >= cfg.board.voteThreshold ? '賛成' : '反対') : null,
        action: `${dec.action}:${dec.arg}`, inputTokens: dec.jev ? dec.jev.inputTokens : null, boardStateTokens: estimateTokens(JSON.stringify({ board: st.board, shared_chests: st.shared_chests, open_proposals: st.open_proposals, agreements: st.agreements })), open: bview.open.q1, error: dec.error || null });
    }
  }
  out.usage = meter.summary();
  if (args.includes('--json')) { console.log(JSON.stringify(out, null, 2)); return; }
  for (const b of out.broadcast) console.log(`[broadcast] ${b.who}: ${b.say || `(なし ${b.error || ''})`}  (2B ${b.promptTokens} tok, ${b.ms}ms)`);
  for (const p of out.propose) console.log(`[propose] ${p.who}: ${p.proposal ? `${p.proposal.text}  ${JSON.stringify(p.proposal.spec)}` : `(読めなかった ${p.raw || p.error})`}  (2B ${p.promptTokens} tok)`);
  for (const v of out.votes) console.log(`[vote] ${v.who} (Hanako とは ${v.relation}): agree P=${v.agreeP} → ${v.vote}  / 行動 ${v.action}  (Jev ${v.inputTokens} tok、うち board の欄 約 ${v.boardStateTokens})${v.error ? ` error ${v.error}` : ''}`);
  if (out.votes[0]) console.log(`  open_proposals.q1 の文: ${out.votes[0].open}`);
  console.log(`Jev 合計 ${out.usage.jev.inputTokens} トークン、2B ${out.usage.twoB.calls} 回`);
}

main().catch((e) => { console.error(e); process.exit(1); });
