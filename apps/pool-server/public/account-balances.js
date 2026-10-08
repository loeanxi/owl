// Account balance summaries use only the account API's balance fields. They never
// combine providers, different resource pools, or check-in rewards.
(function (global) {
  "use strict";

  function numberOf(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value !== "string" || !value.trim()) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function textOf(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function metricFor(summary, fields) {
    let metric = summary.metrics.get(fields.key);
    if (!metric) {
      metric = {
        ...fields,
        remaining: null,
        total: null,
        minimum: null,
        maximum: null,
        count: 0,
        unlimitedCount: 0,
        unavailableCount: 0,
        unknownCount: 0,
        totalCount: 0,
        totalSum: 0,
      };
      summary.metrics.set(fields.key, metric);
    }
    // A shared pool or account window must stay a range even if another snapshot
    // omitted its scope/reset metadata.
    if (fields.kind === "range") metric.kind = "range";
    return metric;
  }

  function addBalance(metric, remaining, total) {
    metric.count += 1;
    metric.remaining = (metric.remaining ?? 0) + remaining;
    metric.minimum = metric.minimum === null ? remaining : Math.min(metric.minimum, remaining);
    metric.maximum = metric.maximum === null ? remaining : Math.max(metric.maximum, remaining);
    if (total !== null) {
      metric.totalCount += 1;
      metric.totalSum += total;
    }
  }

  function summarize(accounts) {
    const platforms = new Map();
    for (const account of Array.isArray(accounts) ? accounts : []) {
      if (!isRecord(account) || !textOf(account.platform)) continue;
      const platform = account.platform;
      let summary = platforms.get(platform);
      if (!summary) {
        summary = {
          platform,
          accountCount: 0,
          knownCount: 0,
          failedCount: 0,
          unavailableQueryCount: 0,
          unknownCount: 0,
          unavailableCount: 0,
          unlimitedCount: 0,
          updatedAt: null,
          metrics: new Map(),
        };
        platforms.set(platform, summary);
      }
      summary.accountCount += 1;
      const updatedAt = numberOf(account.creditsUpdatedAt);
      if (updatedAt !== null && updatedAt > 0) {
        // The card shows the oldest included snapshot so a freshly refreshed
        // account does not hide another account's stale balance.
        summary.updatedAt = summary.updatedAt === null ? updatedAt : Math.min(summary.updatedAt, updatedAt);
      }
      // Never include old balance fields after a failed refresh.
      if (account.creditsStatus === "UNAVAILABLE") {
        summary.unavailableQueryCount += 1;
        continue;
      }
      if (account.creditsStatus === "FAIL") {
        summary.failedCount += 1;
        continue;
      }

      let known = false;
      let unlimited = false;
      let unavailable = false;
      if (Array.isArray(account.creditBuckets) && account.creditBuckets.length > 0) {
        for (const bucket of account.creditBuckets) {
          if (!isRecord(bucket)) continue;
          const bucketKey = textOf(bucket.key) || textOf(bucket.label);
          if (!bucketKey) continue;
          const originalUnit = textOf(bucket.unit);
          const resourceType = textOf(bucket.resourceType) || textOf(bucket.resource_type);
          const label = textOf(bucket.label) || bucketKey;
          const percent = numberOf(bucket.remainingPercent);
          const total = numberOf(bucket.total);
          const used = numberOf(bucket.used);
          let remaining = numberOf(bucket.remaining);
          if (remaining === null && total !== null && total >= 0 && used !== null) {
            remaining = Math.max(0, total - used);
          }
          const percentage = originalUnit === "%" || (remaining === null && percent !== null);
          if (percentage && remaining === null) remaining = percent;
          const unit = percentage ? "%" : originalUnit;
          const scope = `${bucketKey} ${label} ${textOf(bucket.scope)} ${resourceType}`;
          const shared = bucket.shared === true || /organization|shared|team|组织|共享/i.test(scope);
          const window = !!textOf(bucket.resetsAt) || /^(primary|secondary|hour5|weekly)$/.test(bucketKey);
          const metric = metricFor(summary, {
            key: JSON.stringify(["bucket", bucketKey, unit, resourceType]),
            bucketKey,
            label,
            unit,
            resourceType,
            source: "bucket",
            kind: percentage || window || shared || !unit ? "range" : "sum",
          });
          // A displayed but unavailable organization/add-on pool is not spendable.
          if (bucket.unavailable === true) {
            metric.unavailableCount += 1;
            unavailable = true;
          } else if (bucket.unlimited === true) {
            metric.unlimitedCount += 1;
            unlimited = true;
          } else if (remaining !== null) {
            addBalance(metric, remaining, percentage ? null : total);
            known = true;
          } else {
            metric.unknownCount += 1;
          }
        }
      } else {
        const rawLabel = textOf(account.creditsLabel);
        // Package count describes one account's source data, not a separate currency.
        const label = platform === "WORKBUDDY" ? rawLabel.replace(/^(CycleRemainCapacity|CapacityRemain)×\d+$/, "$1") : rawLabel;
        const remaining = numberOf(account.credits);
        // The explicit unlimited flag is a balance result; a subscription label
        // alone (such as MiMo's ping result) is not.
        if (account.creditsUnlimited === true || remaining !== null) {
          const metric = metricFor(summary, {
            key: JSON.stringify(["scalar", label]),
            bucketKey: "",
            label,
            unit: "",
            resourceType: "",
            source: "scalar",
            kind: /organization|shared|team|组织|共享/i.test(label) ? "range" : "sum",
          });
          if (account.creditsUnlimited === true) {
            metric.unlimitedCount += 1;
            unlimited = true;
          } else {
            addBalance(metric, remaining, null);
            known = true;
          }
        }
      }
      if (known) summary.knownCount += 1;
      if (unlimited) summary.unlimitedCount += 1;
      if (unavailable) summary.unavailableCount += 1;
      if (!known && !unlimited && !unavailable) summary.unknownCount += 1;
    }

    return Array.from(platforms.values(), (summary) => ({
      ...summary,
      metrics: Array.from(summary.metrics.values(), (metric) => {
        const { totalCount, totalSum, ...result } = metric;
        if (result.kind === "range") {
          result.remaining = result.count === 1 ? result.minimum : null;
          result.total = result.count === 1 && totalCount === 1 ? totalSum : null;
        } else {
          result.total = result.count > 0 && totalCount === result.count ? totalSum : null;
        }
        return result;
      }),
    }));
  }

  global.PoolAccountBalances = Object.freeze({ summarize });
})(window);
