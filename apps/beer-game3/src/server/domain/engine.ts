import { DOWNSTREAM, ROLES, UPSTREAM, type Decisions, type Role } from './types.js';

/**
 * SimulationEngine: 週の計算（C2）。
 * 副作用がなく、時計・乱数・保存・通信に触れない。同じ入力からは常に同じ出力を返す（NFR1.1）。
 * 金額はすべて整数の最小単位（セント）で扱う（NFR1.2）。
 */

/**
 * 遅延の枠（2 週）。[当週に届く, 次の週に届く]。
 * 確定のたびに、先頭を消費し、末尾を先頭へ前進させ、新しい末尾を入れる。
 */
export type Pipe = readonly [number, number];

export interface RoleState {
  /** 前週末在庫 */
  inventory: number;
  /** 前週末受注残 */
  backlog: number;
  /** 前週までの累積費用 */
  cumulativeCost: number;
  /** 配送の枠（届く側の役割ごと）。工場にはない */
  deliveryPipeline?: Pipe;
  /** 注文の枠（受け取る側の役割ごと）。小売店の受注は顧客需要で、枠を持たない */
  orderPipeline?: Pipe;
  /** 生産の枠。工場だけが持つ */
  productionPipeline?: Pipe;
}

export interface EngineState {
  roles: Record<Role, RoleState>;
}

export interface EngineSettings {
  inventoryUnitCost: number;
  backlogUnitCost: number;
}

export interface EngineInput {
  settings: EngineSettings;
  state: EngineState;
  customerDemand: number;
  decisions: Decisions;
}

export interface RoleResult {
  receipt: number;
  ordersReceived: number;
  shipped: number;
  inventory: number;
  backlog: number;
  weeklyCost: number;
  cumulativeCost: number;
}

export interface EngineOutput {
  /** 次の週の状態 */
  state: EngineState;
  perRole: Record<Role, RoleResult>;
  /** チーム費用（4 役割の週次費用の合計） */
  teamCost: number;
}

/** 入力が型の違反のとき（負数・小数・欠け）に投げる。呼び出し側が事前に検証する前提。 */
export class EngineInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineInputError';
  }
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new EngineInputError(`${label} は 0 以上の整数でなければなりません`);
  }
}

function pipeOf(pipe: Pipe | undefined, label: string): Pipe {
  if (!pipe) {
    throw new EngineInputError(`${label} の枠がありません`);
  }
  assertNonNegativeInteger(pipe[0], `${label}（当週）`);
  assertNonNegativeInteger(pipe[1], `${label}（次週）`);
  return pipe;
}

/** 開始のときの初期状態。前週末在庫は初期在庫、受注残と累積費用は 0、全部の枠は初期パイプライン数量（BR3.3）。 */
export function createInitialState(
  initialInventory: number,
  initialPipelineQuantity: number,
): EngineState {
  const pipe = (): Pipe => [initialPipelineQuantity, initialPipelineQuantity];
  return {
    roles: {
      factory: {
        inventory: initialInventory,
        backlog: 0,
        cumulativeCost: 0,
        orderPipeline: pipe(),
        productionPipeline: pipe(),
      },
      wholesaler1: {
        inventory: initialInventory,
        backlog: 0,
        cumulativeCost: 0,
        deliveryPipeline: pipe(),
        orderPipeline: pipe(),
      },
      wholesaler2: {
        inventory: initialInventory,
        backlog: 0,
        cumulativeCost: 0,
        deliveryPipeline: pipe(),
        orderPipeline: pipe(),
      },
      retailer: {
        inventory: initialInventory,
        backlog: 0,
        cumulativeCost: 0,
        deliveryPipeline: pipe(),
      },
    },
  };
}

/** 当週に届く入荷の数量。工場は生産の枠、それ以外は配送の枠。 */
export function receiptOf(role: Role, state: RoleState): number {
  return role === 'factory'
    ? pipeOf(state.productionPipeline, 'factory 生産')[0]
    : pipeOf(state.deliveryPipeline, `${role} 配送`)[0];
}

/** 当週の受注。小売店は顧客需要、それ以外は注文の枠の当週分（BR5.5、BR5.6）。 */
export function ordersReceivedOf(role: Role, state: RoleState, customerDemand: number): number {
  return role === 'retailer' ? customerDemand : pipeOf(state.orderPipeline, `${role} 注文`)[0];
}

/**
 * 1 週を計算する。4 役割とも週の初めの状態だけを入力にするため、計算の順序によらず同じ結果になる。
 */
export function computeWeek(input: EngineInput): EngineOutput {
  const { settings, state, customerDemand, decisions } = input;
  assertNonNegativeInteger(settings.inventoryUnitCost, '在庫単価');
  assertNonNegativeInteger(settings.backlogUnitCost, '受注残単価');
  assertNonNegativeInteger(customerDemand, '顧客需要');
  for (const role of ROLES) {
    assertNonNegativeInteger(decisions[role], `${role} の意思決定`);
    assertNonNegativeInteger(state.roles[role].inventory, `${role} の在庫`);
    assertNonNegativeInteger(state.roles[role].backlog, `${role} の受注残`);
    assertNonNegativeInteger(state.roles[role].cumulativeCost, `${role} の累積費用`);
  }

  const perRole = {} as Record<Role, RoleResult>;
  for (const role of ROLES) {
    const roleState = state.roles[role];
    const receipt = receiptOf(role, roleState);
    const ordersReceived = ordersReceivedOf(role, roleState, customerDemand);
    // BR5.3
    const available = roleState.inventory + receipt;
    const target = roleState.backlog + ordersReceived;
    const shipped = Math.min(available, target);
    const inventory = Math.max(0, available - target);
    const backlog = Math.max(0, target - available);
    // BR5.8
    const weeklyCost = inventory * settings.inventoryUnitCost + backlog * settings.backlogUnitCost;
    perRole[role] = {
      receipt,
      ordersReceived,
      shipped,
      inventory,
      backlog,
      weeklyCost,
      cumulativeCost: roleState.cumulativeCost + weeklyCost,
    };
  }

  // 枠の前進（BR5.4、BR5.5、BR5.6）。末尾の「次週に届く」は先頭へ前進し、新しい値が末尾に入る。
  const next = {} as Record<Role, RoleState>;
  for (const role of ROLES) {
    const roleState = state.roles[role];
    const result = perRole[role];
    const upstream = UPSTREAM[role];
    const downstream = DOWNSTREAM[role];
    const nextState: RoleState = {
      inventory: result.inventory,
      backlog: result.backlog,
      cumulativeCost: result.cumulativeCost,
    };
    if (role === 'factory') {
      // 工場の生産要請は、自身の生産の枠の末尾へ入る（2 週後に工場の入荷になる）
      nextState.productionPipeline = [
        pipeOf(roleState.productionPipeline, 'factory 生産')[1],
        decisions.factory,
      ];
    } else if (upstream) {
      // 上流の出荷は、同じ週に自分の配送の枠の末尾へ入り、自分の同じ週の入荷には加わらない
      nextState.deliveryPipeline = [
        pipeOf(roleState.deliveryPipeline, `${role} 配送`)[1],
        perRole[upstream].shipped,
      ];
    }
    if (downstream) {
      // 下流の発注は、同じ週に自分の注文の枠の末尾へ入り、2 週後の受注になる
      nextState.orderPipeline = [
        pipeOf(roleState.orderPipeline, `${role} 注文`)[1],
        decisions[downstream],
      ];
    }
    next[role] = nextState;
  }

  const teamCost = ROLES.reduce((sum, role) => sum + perRole[role].weeklyCost, 0);
  return { state: { roles: next }, perRole, teamCost };
}
