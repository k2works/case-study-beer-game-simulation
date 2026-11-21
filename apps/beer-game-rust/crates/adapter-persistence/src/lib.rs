//! 永続化のアダプター（sqlx）。`EventStore` ポートの PostgreSQL 実装。

mod codec;
mod store;

pub use codec::{GameCodec, SessionCodec};
pub use store::{EventCodec, PgEventStore, PgGameStore, PgTx, StreamType, migrate};
