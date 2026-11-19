import {
  createInitialState,
  type EngineState,
  type Pipe,
  type RoleState,
} from '../domain/engine.js';
import { ROLES, type Role, type SlotKind } from '../domain/types.js';
import type { SettingsRow, SlotRow, WeekRecordRow } from './store.js';

/** 遅延の枠を持つ（種類、届く側の役割）の組。entities.md の PipelineSlot の制約と同じ。 */
export const SLOT_LAYOUT: ReadonlyArray<{ kind: SlotKind; role: Role }> = [
  { kind: 'delivery', role: 'wholesaler1' },
  { kind: 'delivery', role: 'wholesaler2' },
  { kind: 'delivery', role: 'retailer' },
  { kind: 'order', role: 'factory' },
  { kind: 'order', role: 'wholesaler1' },
  { kind: 'order', role: 'wholesaler2' },
  { kind: 'production', role: 'factory' },
];

/** 保存されているはずの状態が欠けている（BR7.4）。0 を代入せず、確定を失敗にする。 */
export class MissingStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingStateError';
  }
}

function pipeFrom(slots: SlotRow[], kind: SlotKind, role: Role): Pipe {
  const quantity = (remainingWeeks: 1 | 2): number => {
    const found = slots.find(
      (s) => s.kind === kind && s.role === role && s.remainingWeeks === remainingWeeks,
    );
    if (!found) {
      throw new MissingStateError(`遅延の枠が欠けています: ${kind} ${role} ${remainingWeeks}`);
    }
    return found.quantity;
  };
  return [quantity(1), quantity(2)];
}

/** 開始のときの初期状態（BR3.3）。 */
export function initialEngineState(settings: SettingsRow): EngineState {
  return createInitialState(settings.initialInventory, settings.initialPipelineQuantity);
}

/**
 * 保存されている枠と、前の週の確定済みの記録から、週の初めの状態を組み立てる。
 * 第 1 週の前週末の値は設定から決め（BR3.3）、第 2 週以降は前の週の記録を使う（BR5.3）。
 * 前の週の確定済みの記録（在庫、受注残、累積費用）が欠けているときは、0 を代入せず失敗にする（BR7.4）。
 */
export function engineStateAtWeekStart(
  settings: SettingsRow,
  week: number,
  weekRecords: WeekRecordRow[],
  slots: SlotRow[],
): EngineState {
  const roles = {} as Record<Role, RoleState>;
  for (const role of ROLES) {
    const state: RoleState =
      week === 1
        ? { inventory: settings.initialInventory, backlog: 0, cumulativeCost: 0 }
        : startOfWeekFrom(weekRecords, week, role);
    if (role === 'factory') {
      state.productionPipeline = pipeFrom(slots, 'production', role);
    } else {
      state.deliveryPipeline = pipeFrom(slots, 'delivery', role);
    }
    if (role !== 'retailer') {
      state.orderPipeline = pipeFrom(slots, 'order', role);
    }
    roles[role] = state;
  }
  return { roles };
}

function startOfWeekFrom(weekRecords: WeekRecordRow[], week: number, role: Role): RoleState {
  const previous = weekRecords.find((r) => r.week === week - 1 && r.role === role && r.isConfirmed);
  if (
    !previous ||
    previous.inventory === null ||
    previous.backlog === null ||
    previous.cumulativeCost === null
  ) {
    throw new MissingStateError(`第 ${week - 1} 週の ${role} の確定済みの記録が欠けています`);
  }
  return {
    inventory: previous.inventory,
    backlog: previous.backlog,
    cumulativeCost: previous.cumulativeCost,
  };
}

/** エンジンの状態を、保存する枠の行にする。 */
export function slotRowsOf(state: EngineState): SlotRow[] {
  const rows: SlotRow[] = [];
  for (const { kind, role } of SLOT_LAYOUT) {
    const roleState = state.roles[role];
    const pipe =
      kind === 'delivery'
        ? roleState.deliveryPipeline
        : kind === 'order'
          ? roleState.orderPipeline
          : roleState.productionPipeline;
    if (!pipe) {
      throw new Error(`${role} の ${kind} の枠がありません`);
    }
    rows.push({ kind, role, remainingWeeks: 1, quantity: pipe[0] });
    rows.push({ kind, role, remainingWeeks: 2, quantity: pipe[1] });
  }
  return rows;
}
