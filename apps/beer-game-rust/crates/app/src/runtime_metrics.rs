//! Rust の実行環境の観測（NF-O12）。常駐メモリ（RSS）、tokio のタスク数、panic の件数、接続プールの使用率を、メトリクスに出す。
//! **JVM のヒープ・GC に当たる項目は無い**（B14 計画の判断項目 5）。RSS は Linux（`/proc/self/status`）だけ。他の環境では出さない。
//! メモリのアラームの閾値は、実測後に決める（判断項目 4）ので、ここは観測の出力まで。

use std::sync::atomic::{AtomicU64, Ordering};

use beergame_application::{MetricSample, MetricUnit, metric_names};

/// これまでの panic の件数（プロセスの間の累計）。
static PANICS: AtomicU64 = AtomicU64::new(0);

/// panic の件数を数えるフックを入れる。元のフック（メッセージの出力）はそのまま呼ぶ。プロセスの継続・終了は変えない（判断項目 6）。
pub fn install_panic_counter() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        PANICS.fetch_add(1, Ordering::SeqCst);
        previous(info);
    }));
}

/// これまでの panic の件数。
#[must_use]
pub fn panic_count() -> u64 {
    PANICS.load(Ordering::SeqCst)
}

/// `/proc/self/status` の本文から、常駐メモリ（`VmRSS`。バイト）を読む。
#[must_use]
pub fn parse_rss_bytes(status: &str) -> Option<u64> {
    let line = status.lines().find_map(|l| l.strip_prefix("VmRSS:"))?;
    let kilobytes: u64 = line.trim().strip_suffix("kB")?.trim().parse().ok()?;
    kilobytes.checked_mul(1024)
}

/// 接続プールの使用率（%）。`size` は開いている接続、`idle` は空き、`max` は上限。上限が 0 なら 0。
#[must_use]
pub fn pool_utilization_percent(size: u32, idle: usize, max: u32) -> f64 {
    if max == 0 {
        return 0.0;
    }
    // 使用中の接続数 = 開いている数 - 空き（負にならない）
    let in_use = u64::from(size).saturating_sub(u64::try_from(idle).unwrap_or(u64::MAX));
    // 接続数は小さい（f64 に収まる範囲）
    #[allow(clippy::cast_precision_loss)]
    let percent = in_use as f64 / f64::from(max) * 100.0;
    percent
}

/// 実行環境の観測の入力。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RuntimeReading {
    pub rss_bytes: Option<u64>,
    pub tokio_alive_tasks: usize,
    pub panics: u64,
    pub pool_size: u32,
    pub pool_idle: usize,
    pub pool_max: u32,
}

/// 実行環境のメトリクス。RSS が読めない環境では、RSS は出さない。
#[must_use]
pub fn runtime_samples(reading: &RuntimeReading, at_millis: i64) -> Vec<MetricSample> {
    let sample = |name: &'static str, unit: MetricUnit, value: f64| MetricSample {
        name,
        unit,
        value,
        at_millis,
        operation: None,
    };
    // 件数・バイト数は f64 に収まる範囲
    #[allow(clippy::cast_precision_loss)]
    let (tasks, panics) = (reading.tokio_alive_tasks as f64, reading.panics as f64);
    let mut samples = Vec::new();
    if let Some(rss) = reading.rss_bytes {
        #[allow(clippy::cast_precision_loss)]
        samples.push(sample(
            metric_names::RSS_BYTES,
            MetricUnit::Bytes,
            rss as f64,
        ));
    }
    samples.push(sample(
        metric_names::TOKIO_ALIVE_TASKS,
        MetricUnit::Count,
        tasks,
    ));
    samples.push(sample(metric_names::PANIC_COUNT, MetricUnit::Count, panics));
    samples.push(sample(
        metric_names::DB_POOL_UTILIZATION_PERCENT,
        MetricUnit::Percent,
        pool_utilization_percent(reading.pool_size, reading.pool_idle, reading.pool_max),
    ));
    samples
}

/// 実行環境の観測を、定期的に（`interval`）シンクへ出す。API のプロセスの間、走り続ける。
/// RSS は Linux だけ（`/proc/self/status`）。タスク数は tokio のランタイムから読む。
pub fn spawn_sampler(
    pool: sqlx::PgPool,
    sink: std::sync::Arc<dyn beergame_application::MetricSink>,
    interval: std::time::Duration,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        loop {
            ticker.tick().await;
            let reading = RuntimeReading {
                rss_bytes: std::fs::read_to_string("/proc/self/status")
                    .ok()
                    .and_then(|s| parse_rss_bytes(&s)),
                tokio_alive_tasks: tokio::runtime::Handle::current()
                    .metrics()
                    .num_alive_tasks(),
                panics: panic_count(),
                pool_size: pool.size(),
                pool_idle: pool.num_idle(),
                pool_max: pool.options().get_max_connections(),
            };
            let at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX));
            sink.record(&runtime_samples(&reading, at));
        }
    })
}

#[cfg(test)]
#[allow(non_snake_case)] // 理由: RT1 の命名（承認済み）の `__` を使うため。
mod tests {
    use super::*;

    fn find(samples: &[MetricSample], name: &str) -> Option<f64> {
        samples.iter().find(|s| s.name == name).map(|s| s.value)
    }

    #[test]
    fn nf_o12__status_の_VmRSS_は_kB_をバイトにして読む() {
        let status =
            "Name:\tbeergame-app\nVmPeak:\t  200000 kB\nVmRSS:\t   12345 kB\nThreads:\t4\n";
        assert_eq!(parse_rss_bytes(status), Some(12_345 * 1024));
    }

    #[test]
    fn nf_o12__VmRSS_が無い_または読めなければ_None() {
        assert_eq!(parse_rss_bytes("Name:\tx\n"), None);
        assert_eq!(parse_rss_bytes("VmRSS:\tabc kB\n"), None);
        assert_eq!(parse_rss_bytes(""), None);
    }

    #[test]
    fn nf_o3__接続プールの使用率は_使用中の接続数を上限で割った割合() {
        // 開いている 8 本のうち 2 本が空き → 使用中 6 本 / 上限 10 本 = 60%
        assert!((pool_utilization_percent(8, 2, 10) - 60.0).abs() < 1e-9);
        assert!((pool_utilization_percent(0, 0, 10) - 0.0).abs() < 1e-9);
        assert!((pool_utilization_percent(10, 0, 10) - 100.0).abs() < 1e-9);
    }

    #[test]
    fn nf_o3__接続プールの上限が_0_なら_使用率は_0() {
        assert!((pool_utilization_percent(0, 0, 0) - 0.0).abs() < 1e-9);
    }

    #[test]
    fn nf_o12__実行環境のメトリクスは_RSS_タスク数_panic_プールを出す() {
        let reading = RuntimeReading {
            rss_bytes: Some(1_000),
            tokio_alive_tasks: 7,
            panics: 2,
            pool_size: 8,
            pool_idle: 2,
            pool_max: 10,
        };
        let samples = runtime_samples(&reading, 5);
        assert_eq!(find(&samples, metric_names::RSS_BYTES), Some(1_000.0));
        assert_eq!(find(&samples, metric_names::TOKIO_ALIVE_TASKS), Some(7.0));
        assert_eq!(find(&samples, metric_names::PANIC_COUNT), Some(2.0));
        assert_eq!(
            find(&samples, metric_names::DB_POOL_UTILIZATION_PERCENT),
            Some(60.0)
        );
        assert!(
            samples
                .iter()
                .all(|s| s.at_millis == 5 && s.operation.is_none())
        );
    }

    #[test]
    fn nf_o12__RSS_が読めない環境では_RSS_は出さず_他は出す() {
        let reading = RuntimeReading {
            rss_bytes: None,
            tokio_alive_tasks: 1,
            panics: 0,
            pool_size: 0,
            pool_idle: 0,
            pool_max: 10,
        };
        let samples = runtime_samples(&reading, 0);
        assert_eq!(find(&samples, metric_names::RSS_BYTES), None);
        assert_eq!(find(&samples, metric_names::PANIC_COUNT), Some(0.0));
    }

    #[test]
    fn nf_o12__panic_フックは件数を増やして_プロセスを続ける() {
        let before = panic_count();
        install_panic_counter();
        let caught = std::panic::catch_unwind(|| {
            panic!("試験のための panic");
        });
        assert!(caught.is_err());
        assert!(panic_count() > before);
    }
}
