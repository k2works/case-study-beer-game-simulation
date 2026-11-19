/** 操作者。認証は外側の層が行い、ドメインには結果（進行役か、どの参加者か）だけを渡す。 */
export type Actor =
  | { kind: 'FACILITATOR' }
  | { kind: 'PARTICIPANT'; participantId: string }
  /** 観察者。役割を持たず、読み取りだけ（すべての変更の操作は、進行役・参加者の検査で拒否される） */
  | { kind: 'OBSERVER'; observerId: string };

export const FACILITATOR: Actor = { kind: 'FACILITATOR' };
export const participant = (participantId: string): Actor => ({
  kind: 'PARTICIPANT',
  participantId,
});
