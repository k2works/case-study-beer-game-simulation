// 50 週の golden test の期待値を、SimulationEngine とは別の考え方で導出する（BR8.3、Q2 の A）。
//
// 実装（src/server/domain/engine.ts）は「遅延の枠を前へ送る」状態機械として書かれている。
// この導出は、枠を持たず、週ごとの「流れの表」（受注・入荷・出荷・在庫・受注残）を直接引く。
//   - 入荷（r）: 工場は 2 週前の自分の生産要請、それ以外は 2 週前の上流の出荷。最初の 2 週は初期の枠（4）。
//   - 受注（o）: 小売店はその週の顧客需要、それ以外は 2 週前の下流の発注。最初の 2 週は初期の枠（4）。
//   - 在庫と受注残: 前週末の値 + 入荷 を、前週末の受注残 + 受注 に充てる。
// シナリオ: 顧客需要は週 1〜4 が 4、週 5 以降が 8。各役割は、その週に受けた注文の数をそのまま発注する。
//
// 使い方: node derive-golden.mjs           → golden-50-weeks.json を書く
//         node derive-golden.mjs --check   → 書かずに、保存済みのファイルと一致することを確かめる

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const WEEKS = 50;
const INITIAL_INVENTORY = 12;
const INITIAL_FLOW = 4; // 最初の 2 週の入荷・受注（初期の枠）
const HOLD_COST = 50;
const SHORT_COST = 100;

// 出荷（モノ）の上流 → 下流の順
const CHAIN = ['factory', 'wholesaler1', 'wholesaler2', 'retailer'];
const upstreamOf = (role) => CHAIN[CHAIN.indexOf(role) - 1];
const downstreamOf = (role) => CHAIN[CHAIN.indexOf(role) + 1];

const demandAt = (week) => (week <= 4 ? 4 : 8);

export function derive() {
  // 週 t（1 始まり）の値を表で持つ
  const table = {};
  for (const role of CHAIN) {
    table[role] = {
      orders: {},
      receipt: {},
      shipped: {},
      inventory: { 0: INITIAL_INVENTORY },
      backlog: { 0: 0 },
      decision: {},
      weeklyCost: {},
      cumulativeCost: { 0: 0 },
    };
  }

  const ordersAt = (role, week) => {
    if (role === 'retailer') return demandAt(week);
    if (week <= 2) return INITIAL_FLOW;
    return table[downstreamOf(role)].decision[week - 2];
  };
  const receiptAt = (role, week) => {
    if (week <= 2) return INITIAL_FLOW;
    if (role === 'factory') return table.factory.decision[week - 2];
    return table[upstreamOf(role)].shipped[week - 2];
  };

  for (let week = 1; week <= WEEKS; week += 1) {
    for (const role of CHAIN) {
      const t = table[role];
      t.orders[week] = ordersAt(role, week);
      t.receipt[week] = receiptAt(role, week);
      // この週に受けた注文の数をそのまま発注する（工場は同じ数の生産要請）
      t.decision[week] = t.orders[week];
      const available = t.inventory[week - 1] + t.receipt[week];
      const owed = t.backlog[week - 1] + t.orders[week];
      t.shipped[week] = owed <= available ? owed : available;
      t.inventory[week] = available - t.shipped[week];
      t.backlog[week] = owed - t.shipped[week];
      t.weeklyCost[week] = t.inventory[week] * HOLD_COST + t.backlog[week] * SHORT_COST;
      t.cumulativeCost[week] = t.cumulativeCost[week - 1] + t.weeklyCost[week];
    }
  }

  const weeks = [];
  for (let week = 1; week <= WEEKS; week += 1) {
    const roles = {};
    let teamCost = 0;
    for (const role of CHAIN) {
      const t = table[role];
      roles[role] = {
        decision: t.decision[week],
        receipt: t.receipt[week],
        ordersReceived: t.orders[week],
        shipped: t.shipped[week],
        inventory: t.inventory[week],
        backlog: t.backlog[week],
        weeklyCost: t.weeklyCost[week],
        cumulativeCost: t.cumulativeCost[week],
      };
      teamCost += t.weeklyCost[week];
    }
    // 週末に残る遅延の枠。remaining1 = 次の週に届く、remaining2 = 次の次の週に届く。
    // 届く量・受ける量は、上の流れの定義を未来の週に当てはめて求める（t+1、t+2 が最終週を超えても定義で決まる）。
    const slots = {
      delivery: {},
      order: {},
      production: {},
    };
    for (const role of ['wholesaler1', 'wholesaler2', 'retailer']) {
      slots.delivery[role] = [receiptAt(role, week + 1), receiptAt(role, week + 2)];
    }
    for (const role of ['factory', 'wholesaler1', 'wholesaler2']) {
      slots.order[role] = [ordersAt(role, week + 1), ordersAt(role, week + 2)];
    }
    slots.production.factory = [receiptAt('factory', week + 1), receiptAt('factory', week + 2)];
    weeks.push({ week, customerDemand: demandAt(week), roles, teamCost, slots });
  }

  return {
    scenario: {
      weekCount: WEEKS,
      initialInventory: INITIAL_INVENTORY,
      initialPipelineQuantity: INITIAL_FLOW,
      inventoryUnitCost: HOLD_COST,
      backlogUnitCost: SHORT_COST,
      demandSeries: Array.from({ length: WEEKS }, (_, i) => demandAt(i + 1)),
      decisionRule: '各役割は、その週に受けた注文の数をそのまま発注する',
    },
    weeks,
  };
}

const outputPath = fileURLToPath(new URL('./golden-50-weeks.json', import.meta.url));
const text = `${JSON.stringify(derive(), null, 2)}\n`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) {
    if (readFileSync(outputPath, 'utf8') !== text) {
      process.stderr.write('golden-50-weeks.json が導出結果と一致しません\n');
      process.exit(1);
    }
    process.stdout.write('golden-50-weeks.json は導出結果と一致します\n');
  } else {
    writeFileSync(outputPath, text);
    process.stdout.write(`${outputPath} を書きました\n`);
  }
}
