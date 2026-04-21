//! Rate limiter for the public demo API key.
//!
//! Single global fixed-window bucket shared across all callers using the
//! demo key. Window = 60 s; limit = configurable (default 100 req/min).
//!
//! The bucket is "fixed window" rather than "sliding" because that's
//! dramatically simpler, fits in one mutex, and the failure mode (up to 2x
//! the configured rate briefly at window boundaries) is benign for a
//! demo surface. Sliding would add complexity with no customer-visible win.
//!
//! Returns `RateLimitDecision::Ok` with the current bucket state for
//! observability, or `RateLimitDecision::Exceeded { retry_after_sec }`.
//!
//! This is deliberately not pluggable — there's one demo key, one rate
//! bucket, and that's the product. Multi-tenant rate limiting (per-OAuth-
//! subject) is a separate concern for Week 4+.

use std::sync::Mutex;
use std::time::{Duration, Instant};

pub struct DemoRateLimiter {
    limit_per_min: u32,
    state: Mutex<BucketState>,
}

struct BucketState {
    window_start: Instant,
    count: u32,
}

#[derive(Debug)]
pub enum RateLimitDecision {
    Ok { count_in_window: u32, limit: u32 },
    Exceeded { retry_after_sec: u64, limit: u32 },
}

impl DemoRateLimiter {
    pub fn new(limit_per_min: u32) -> Self {
        Self {
            limit_per_min,
            state: Mutex::new(BucketState {
                window_start: Instant::now(),
                count: 0,
            }),
        }
    }

    /// Count one request; return whether it's allowed.
    pub fn check(&self) -> RateLimitDecision {
        let now = Instant::now();
        let window = Duration::from_secs(60);
        let mut s = self.state.lock().expect("demo rate limiter mutex poisoned");

        // Roll the window if it's expired.
        if now.duration_since(s.window_start) >= window {
            s.window_start = now;
            s.count = 0;
        }

        if s.count >= self.limit_per_min {
            let elapsed = now.duration_since(s.window_start);
            let retry_after_sec = window.saturating_sub(elapsed).as_secs().max(1);
            return RateLimitDecision::Exceeded {
                retry_after_sec,
                limit: self.limit_per_min,
            };
        }

        s.count += 1;
        RateLimitDecision::Ok {
            count_in_window: s.count,
            limit: self.limit_per_min,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn under_limit_is_ok() {
        let rl = DemoRateLimiter::new(5);
        for _ in 0..5 {
            match rl.check() {
                RateLimitDecision::Ok { .. } => {}
                RateLimitDecision::Exceeded { .. } => panic!("should be ok"),
            }
        }
    }

    #[test]
    fn sixth_exceeds_limit_of_five() {
        let rl = DemoRateLimiter::new(5);
        for _ in 0..5 {
            let _ = rl.check();
        }
        match rl.check() {
            RateLimitDecision::Exceeded {
                retry_after_sec,
                limit,
            } => {
                assert_eq!(limit, 5);
                assert!((1..=60).contains(&retry_after_sec));
            }
            RateLimitDecision::Ok { .. } => panic!("should be exceeded"),
        }
    }
}
