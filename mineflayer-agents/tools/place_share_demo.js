#!/usr/bin/env node
'use strict';
// 場所の共有を 2B で確かめる (bot なし): 見つけた人が【発見】の文と、聞かれたことへの答えを 2B で書く → 聞いた人の記憶に場所が入り、go_to の候補になるか。
//   LLM_BASE_URL=http://192.168.15.30:18081 node tools/place_share_demo.js [--n 3]
const path = require('path');
const { Talker } = require('../src/talker');
const { Memory } = require('../src/memory');
const { relDir } = require('../src/util');
const { loadConfig } = require('../src/config');
const ask = require('../src/ask');

const cfg = loadConfig(path.join(__dirname, '..', 'configs', 'survival_3days.json'));
const N = Number((process.argv[process.argv.indexOf('--n') + 1]) || 3);
const O = { x: -320, y: 72, z: 64 };

async function main() {
  const baseUrl = process.env.LLM_BASE_URL || 'http://192.168.15.30:18081';
  const talker = new Talker({ llmOpts: { ...cfg.decider.llm, baseUrl }, maxTokens: 96 });
  const here = { x: -210, y: 70, z: -30 };
  const finder = new Memory({ origin: O });
  finder.notePlace('jungle_log', { x: -205, y: 70, z: -36 });
  finder.notePlace('water', { x: -200, y: 62, z: -20 });
  const ref = (p) => finder.commonRef(p);
  const seen = [`water: ${relDir(here, { x: -200, z: -20 })}・${ref({ x: -200, z: -20 })}`, `cow: ${relDir(here, { x: -214, z: -24 })}・${ref({ x: -214, z: -24 })}`, `sugar_cane: ${relDir(here, { x: -198, z: -22 })}・${ref({ x: -198, z: -22 })}`];
  const persona = cfg.personas.find((p) => p.name === 'Ken');
  const ctx = { persona, socialText: 'お腹は空いていない。知らない所を見てみたい', plan: '', nearText: 'なし', heardText: 'なし', boardText: '', memText: finder.toPromptText(here), hereText: ref(here), seenText: seen.join('\n') };
  for (let i = 0; i < N; i++) {
    const r = await talker.reportFind(ctx);
    const hearer = new Memory({ origin: O });
    const got = hearer.learnPlaces('Ken', r.say || '');
    const mp = hearer.placesForPrompt({ x: -320, y: 72, z: 64 });
    console.log(`【発見】${r.say}  [入力 ${r.promptTokens}]`);
    console.log(`  → 聞いた側 (Taro) の記憶: ${mp.map((p) => `${p.id}=${p.label}`).join(' / ') || '(場所なし)'}  ${got.map((g) => g.how).join(',')}`);
  }
  // 聞かれて答える (ask の答え)
  const mems = ask.relevantMemories(finder, 'jungle_log はどこにある？');
  for (let i = 0; i < N; i++) {
    const r = await talker.answer({ persona, from: 'Taro', question: 'jungle_log はどこにある？', memories: mems });
    const hearer = new Memory({ origin: O });
    hearer.noteHeard('Ken', r.say || '');
    console.log(`答え: ${r.say}  → 聞いた側の記憶: ${hearer.placesForPrompt({ x: -320, y: 72, z: 64 }).map((p) => `${p.id}=${p.label}`).join(' / ') || '(場所なし)'}`);
  }
  console.log(`(答えに使った記憶: ${mems.map((m) => m.text).join(' / ')})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
