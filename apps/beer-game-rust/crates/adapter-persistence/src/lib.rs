//! 永続化のアダプター（sqlx）。`EventStore` ポートの PostgreSQL 実装。

mod codec;
mod maintenance;
mod projection;
mod retention;
mod store;
mod upcast;

pub use codec::{GameCodec, SessionCodec};
pub use maintenance::{PROJECTION_TABLES, PgProjectionMaintenance};
pub use projection::{Bind, Statement, game_statements, session_statements};
pub use retention::PgRetentionStore;
pub use store::{EventCodec, PgEventStore, PgGameStore, PgTx, StreamType, migrate};
