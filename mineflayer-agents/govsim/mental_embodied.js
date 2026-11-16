'use strict';
// Minecraft の中の版 (embodied) の心のモデル。govsim/mental.js の Mental と同じ部品 (src/social.js・src/needs.js、
// 同じ設定: 先のつらさ off・上の欲求 off (--higher-needs on で戻す)) を使い、違いは「何から動くか」だけ:
//   - 時計と体: 文字の版は 1か月 = 1日の作った時計と、取った量から作った満腹度。ここは本物の world age (tick) と、
//     bot の本物の満腹度 (bot.food・bot.foodSaturation)・明るさ・囲まれているか (senseShelter)・近くの人 (見えている bot と距離) で
//     2 秒ごとに Social.tick を呼ぶ (agent.js の senseNeeds と同じ材料)
//   - 取り決めを破った/守った: 文字の版は村長の報告 (全員の取った量) から全員が知る。ここは自分の目で見た漁だけ
//     (Knowledge.judge: 見た量が上限を超えた = 破った、その人の今月の漁を全部見ていて上限以下 = 守った)。
//     動かし方 (addGrudge('breach')・onRelationScore(1/3)・信頼 ∓0.06) は文字の版と同じ
//   - 欲しい量より少なかった (onActionResult('fish', false))・話し合いの onHeard/onSpoke/onTogether は文字の版と同じ
//   - 寝る: ベッドは使わない (昼のまま止めた世界)。文字の版と同じく、月の終わり (振り返りのあと) に寝たことにする
const { Mental } = require('./mental');

class EmbodiedMental extends Mental {
  constructor(o) {
    super(o);
    this.lastSense = null;
  }

  // 本物の材料で1回進める。sense: { time (world age), timeOfDay, food, saturation, health, light, shelter, players: [{name,d}], atHome, invTotal, invKinds }
  tickReal(sense) {
    const s = { ...sense };
    s.players = (s.players || []).map((p) => ({ ...p, affinity: this.social.rel(p.name).affinity }));
    this.lastSense = s;
    this.time = s.time;
    this.food = s.food;
    this.social.tick({ tick: s.time, sense: s });
  }

  // 自分の漁の結果 (文字の版の onHarvest のうち、満腹度を作る所を除いたもの。満腹度は本物)
  onHarvestReal({ wanted, caught }) {
    const ok = caught >= wanted;
    this.social.onActionResult('fish', ok);
    return { ok, food: this.food };
  }

  // 見て分かった、取り決めを破った/守った人 (Knowledge.judge の結果)
  onJudged(list) {
    const out = [];
    for (const j of list) {
      if (j.who === this.name) continue;
      const r = this.social.rel(j.who);
      if (j.kind === 'breach') {
        const g = this.social.addGrudge(j.who, 'breach');
        this.social.onRelationScore(j.who, 1);
        r.trust = Math.round(Math.max(0, r.trust - 0.06) * 100) / 100;
        out.push({ ...j, grudge: g ? g.v : null, affinity: r.affinity, trust: r.trust });
      } else if (j.kind === 'kept') {
        this.social.onRelationScore(j.who, 3);
        r.trust = Math.round(Math.min(1, r.trust + 0.06) * 100) / 100;
        out.push({ ...j, affinity: r.affinity, trust: r.trust });
      }
    }
    return out;
  }

  // 取った魚 (raw cod) を食べた (needs.js の onEat。agent.js で食べたときと同じ)
  onAte(n) { for (let i = 0; i < n; i++) this.social.needsModel.onEat('cod'); }

  onHeardChat(from, text) { this.social.onHeard(from, this.time || 0, text); }
  onSpokeChat() { this.social.onSpoke(this.time || 0); }

  // 振り返りのあと、寝たことにする (時計は進めない。本物の時計は bot から来る)
  sleepNow() { this.social.needsModel.onSleep({ nightSkipped: true, timeOfDay: 0 }); }
}

module.exports = { EmbodiedMental };
