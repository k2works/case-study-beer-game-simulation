//! 集約に共通の土台。操作者、エラーの分類、再生の結果。時刻・ID・乱数はここでも作らない。

use crate::values::{GameId, ParticipantId};

/// エラーの分類。HTTP の状態への写像（アダプターの責務）の入力になる。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorCategory {
    Forbidden,
    NotFound,
    InvalidState,
    Conflict,
    RuleViolation,
}

/// コマンドを発行した主体。認証は境界が行い、結果の [`Actor`] をコマンドに載せる。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Actor {
    Facilitator(GameId),
    Participant(ParticipantId),
    Anonymous,
}

impl Actor {
    #[must_use]
    pub fn is_facilitator_of(&self, game_id: GameId) -> bool {
        *self == Actor::Facilitator(game_id)
    }
}

/// `evolve` の結果。`decide` が作らない列（例: 未開始への入力の保存）は `Ignored` で返し、状態は変わらない。
/// 再生側が検知し、**コマンドの経路では失敗として扱う**（fail closed。設計判断 RD2）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Evolution<S> {
    Applied(S),
    Ignored(S),
}

impl<S> Evolution<S> {
    /// 採用されたかどうかにかかわらず、次の状態を取り出す。
    #[must_use]
    pub fn into_state(self) -> S {
        match self {
            Evolution::Applied(s) | Evolution::Ignored(s) => s,
        }
    }

    #[must_use]
    pub const fn is_ignored(&self) -> bool {
        matches!(self, Evolution::Ignored(_))
    }
}
