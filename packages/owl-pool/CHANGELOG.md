# Changelog

## [Unreleased]

### Fixed

- Wallet debits, refunds and ledger transitions now share a synchronous transaction, so failed ledger writes cannot leave an unmatched balance change.
- New gateway reservations retain durable request and call-log identities and require a single dispatch claim. Interrupted or unknown billing retains a review hold; only versioned, proven pre-dispatch reservations can be released automatically.
- Gateway cancellation now propagates through supported upstream adapters, stops further account retries, and gives active requests a bounded shutdown drain.
- Token usage must contain finite, non-negative safe integers before settlement; invalid or unknown usage stays available for review.
- Isolated gateway output, completion, and continuation account state per request so concurrent calls cannot clear retry protection, suppress a valid retry, or select another request's pinned account.
- WorkBuddy streams now use a 120-second idle deadline and 600-second total bound by default, honor explicit absolute timeouts, propagate cancellation, and release readers and timers on completion or failure. Unknown accepted streams cannot trigger another account dispatch.
- Gateway SSE errors now retain their cause after partial output instead of closing silently and leaving clients with a missing finish reason.
- Known input usage now settles ordinary input, verified cache reads and verified cache writes at their configured rates, with one rounding step for aggregate input and one for output. Conservative pre-dispatch reservation remains unchanged; missing cache metrics use ordinary input and invalid or overlapping metrics retain review holds. New ledger entries retain their cache components.
- Anthropic upstream conversion now preserves cache components and folds native ordinary input into total prompt input consistently in streaming and nonstreaming responses; gateway defaults use total prompt semantics while explicit standalone fold=false behavior remains available.
- Native Anthropic nullable cumulative input/cache fields now preserve previous verified measurements; complete-response null cache fields remain absent instead of triggering an invalid-cache hold. Strict normalized usage validation remains unchanged.
- SDK bridge turns retain unknown usage after an explicit invalid metric instead of settling earlier counters; stream and nonstream consumers preserve that status through wallet review. Empty notifications preserve earlier valid usage.
