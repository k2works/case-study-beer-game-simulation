/**
 * 共有の契約の操作のうち、TS 版にまだ実装していないもの（operationId）。
 *
 * 契約へ合わせる作業（docs/development/beer-game-ts/api_alignment_plan.md）の進捗を、ここに持つ。
 * 操作を `/api/v1` に実装したら、この一覧から**消す**（消し忘れると、operations.test.ts が失敗して教える）。
 * 一覧が空になれば、契約の全操作を実装したことになる。
 */
export const PENDING_OPERATIONS: ReadonlySet<string> = new Set([
  'createGame',
  'getLobby',
  'getObservation',
  'inviteObserver',
  'revokeObserverInvitation',
  'joinAsObserver',
  'getReview',
  'getExport',
  'getRetention',
  'assignRole',
  'joinGame',
  'startGame',
  'saveDecision',
  'commitWeek',
  'pauseSession',
  'setCommitMode',
  'resumeSession',
  'submitProxyDecision',
  'revokeCredential',
  'reissueCredential',
  'recoverParticipation',
  'getSessionState',
  'getGameState',
]);
