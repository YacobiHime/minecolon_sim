'use strict';
// 設定ファイル (JSON) の読み込みと既定値
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  server: { host: '127.0.0.1', port: 25565, version: '1.20.1' },
  persona: { name: 'Bot1', personality: '', speech: '' },
  goal: { text: '', hints: [], success: null },
  // 文を作る LLM の提供元 (src/llm_provider.js)。provider: 既定 (local = llama.cpp の 2B、luna = gpt-6-luna)、roles: 役ごと (goal・talk・reflect・answer・broadcast・act)、
  //   providers: 提供元ごとの設定 (baseUrl・model・ctxTokens・pricing など)、maxUsd: 費用の上限 (null で無し)
  llm: { provider: 'local', roles: {}, providers: {}, maxUsd: null },
  decider: { type: 'llm', llm: { baseUrl: 'http://127.0.0.1:18081', model: 'gemma-4-e2b', temperature: 0.4, maxTokens: 96, timeoutMs: 60000, constrained: true, retries: 0 } },
  // hearRadius: 近くの声の届く距離 (m)。peopleRadius: follow・give・go_to(人) の対象になる「近くの人」の距離 (null なら hearRadius。call・ask は hearRadius)。
  //   どちらも見えているか (視線) は問わず、サーバーが送ってくる相手の位置からの距離だけで決める (people.js)。
  //   サーバーがプレイヤーの位置を送る距離 min(512 × entity-broadcast-range-percentage / 100, (view-distance − 1) × 16) 以下にする。
  //   positionStaleMs: 相手の位置が一時的に来ないとき、最後に分かった位置を使う時間
  perception: { visionRadius: 16, hearRadius: 48, peopleRadius: null, positionStaleMs: 15000, samplesPerType: 12, keepPerType: 5, maxTypes: 12, notable: null },
  memory: { file: null, limits: {} },
  act: { collectCount: 3, exploreDistance: 20, timeouts: {} },
  craftables: [
    'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks',
    'stick', 'crafting_table', 'wooden_pickaxe', 'wooden_axe', 'wooden_shovel', 'wooden_sword',
    'stone_pickaxe', 'stone_axe', 'stone_shovel', 'stone_sword', 'furnace', 'chest', 'torch',
  ],
  placeable: ['crafting_table', 'furnace', 'chest', 'torch', 'cobblestone', 'dirt', '_planks$'],
  loop: { minutes: 15, pauseMs: 500, stopOnGoal: false, chatMinIntervalMs: 1500 },
  record: { dir: null },
};

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function deepMerge(a, b) {
  if (!isObj(a) || !isObj(b)) return b === undefined ? a : b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(a[k]) ? deepMerge(a[k], v) : v;
  return out;
}

function loadConfig(file, overrides = {}) {
  const user = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const cfg = deepMerge(deepMerge(DEFAULTS, user), overrides);
  const root = path.resolve(__dirname, '..');
  const name = cfg.persona.name;
  if (!cfg.memory.file) cfg.memory.file = path.join(root, 'data', 'memory', `${name}.json`);
  if (!cfg.record.dir) cfg.record.dir = path.join(root, 'runs');
  return cfg;
}

module.exports = { loadConfig, deepMerge, DEFAULTS };
