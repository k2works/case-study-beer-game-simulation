/** 操作者。認証は外側の層が行い、ドメインには結果（進行役か、どの参加者か）だけを渡す。 */
export type Actor =
  { kind: 'FACILITATOR' } | { kind: 'PARTICIPANT'; participantId: string };

export const FACILITATOR: Actor = { kind: 'FACILITATOR' };
export const participant = (participantId: string): Actor => ({
  kind: 'PARTICIPANT',
  participantId,
});
