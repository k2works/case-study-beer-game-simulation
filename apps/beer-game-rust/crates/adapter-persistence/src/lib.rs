//! 永続化のアダプター（sqlx）。`EventStore` ポートの PostgreSQL 実装。

mod store;

pub use store::{EventCodec, PgEventStore, PgTx, StreamType, migrate};
