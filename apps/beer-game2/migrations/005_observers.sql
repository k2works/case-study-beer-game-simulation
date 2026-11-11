-- Up Migration
-- Bolt 8: 観察用の招待と観察者（docs/development/beer-game2/bolt_8_plan.md）。
-- すべて games の削除で連鎖して消える。招待コードは保存せず、ダイジェストだけを持つ
CREATE TABLE observer_invitations (
  invitation_id  uuid PRIMARY KEY,
  game_id        uuid NOT NULL REFERENCES games (game_id) ON DELETE CASCADE,
  code_digest    text NOT NULL UNIQUE,
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX observer_invitations_game_idx ON observer_invitations (game_id);

CREATE TABLE observers (
  observer_id    uuid PRIMARY KEY,
  game_id        uuid NOT NULL REFERENCES games (game_id) ON DELETE CASCADE,
  invitation_id  uuid NOT NULL REFERENCES observer_invitations (invitation_id) ON DELETE CASCADE,
  display_name   text NOT NULL,
  joined_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX observers_game_idx ON observers (game_id);

-- 観察者のブラウザセッション
ALTER TABLE browser_sessions DROP CONSTRAINT browser_sessions_actor_kind_check;
ALTER TABLE browser_sessions
  ADD CONSTRAINT browser_sessions_actor_kind_check
  CHECK (actor_kind IN ('FACILITATOR', 'PARTICIPANT', 'OBSERVER'));
ALTER TABLE browser_sessions
  ADD COLUMN observer_id uuid REFERENCES observers (observer_id) ON DELETE CASCADE;

-- Down Migration
ALTER TABLE browser_sessions DROP COLUMN observer_id;
DELETE FROM browser_sessions WHERE actor_kind = 'OBSERVER';
ALTER TABLE browser_sessions DROP CONSTRAINT browser_sessions_actor_kind_check;
ALTER TABLE browser_sessions
  ADD CONSTRAINT browser_sessions_actor_kind_check
  CHECK (actor_kind IN ('FACILITATOR', 'PARTICIPANT'));
DROP TABLE observers;
DROP TABLE observer_invitations;
