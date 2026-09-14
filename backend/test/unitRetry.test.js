const assert = require('node:assert/strict');
const test = require('node:test');

const {
  withUnitRetry,
  isRetryableFailure,
  backoffMs,
  unitAttempts,
} = require('../dist/services/ai/retry');
const { AIProviderError } = require('../dist/services/ai/errors');

/**
 * The failure this exists to catch: a 500-resume run finished with 76 failures,
 * nearly all of them a browser that took the prompt and then did not answer in
 * time. Every one was already marked `retryable`, and nothing retried them. The
 * failover inside a single call tries the OTHER free account once and stops,
 * which is the right scope for "this account is walled" and the wrong one for
 * "that turn went wrong".
 */

const providerError = (kind, extra = {}) =>
  new AIProviderError({ provider: 'claude-web', kind, detail: 'test', ...extra });

// No real waiting: the backoff is asserted separately.
const instant = { random: () => 0, attempts: 3 };

test('a transient failure is retried until it succeeds', async () => {
  let calls = 0;
  const value = await withUnitRetry(
    async (attempt) => {
      calls = attempt;
      if (attempt < 3) throw providerError('timeout');
      return 'tailored';
    },
    { ...instant, attempts: 3 }
  );

  assert.equal(value, 'tailored');
  assert.equal(calls, 3, 'it should have taken all three attempts');
});

test('the exact failure from the 500-resume run is retryable', () => {
  // "was still writing when the deadline passed"
  assert.equal(isRetryableFailure(providerError('timeout')), true);
  assert.equal(isRetryableFailure(providerError('stalled')), true);
  assert.equal(isRetryableFailure(providerError('truncated')), true);
  assert.equal(isRetryableFailure(providerError('malformedOutput')), true);
  assert.equal(isRetryableFailure(providerError('unavailable')), true);
  assert.equal(isRetryableFailure(providerError('rateLimited')), true);
});

test('a failure that a second attempt cannot change is not retried', async () => {
  for (const kind of ['auth', 'disabled', 'locked', 'binaryMissing']) {
    assert.equal(isRetryableFailure(providerError(kind)), false, kind);
  }

  let calls = 0;
  await assert.rejects(
    withUnitRetry(
      async () => {
        calls += 1;
        throw providerError('disabled');
      },
      instant
    )
  );
  assert.equal(calls, 1, 'a disabled provider should be reported once, not three times');
});

test('a cancellation is not a failure to retry', async () => {
  const aborted = new Error('The operation was aborted');
  aborted.name = 'AbortError';
  assert.equal(isRetryableFailure(aborted), false);

  let calls = 0;
  await assert.rejects(
    withUnitRetry(
      async () => {
        calls += 1;
        throw aborted;
      },
      instant
    )
  );
  assert.equal(calls, 1);
});

test('an unclassified fault is retried, because that is the population retries help', async () => {
  // A socket closing, a tab that went away mid-read.
  assert.equal(isRetryableFailure(new Error('socket hang up')), true);

  let calls = 0;
  const value = await withUnitRetry(
    async () => {
      calls += 1;
      if (calls < 2) throw new Error('socket hang up');
      return 'ok';
    },
    instant
  );
  assert.equal(value, 'ok');
  assert.equal(calls, 2);
});

test('the last error is what comes back, not the first', async () => {
  await assert.rejects(
    withUnitRetry(async (attempt) => {
      throw providerError('timeout', { detail: `attempt ${attempt}` });
    }, instant),
    /attempt 3/
  );
});

test('a provider that said when to come back is believed', () => {
  const walled = providerError('rateLimited', { retryAfterSeconds: 42 });
  assert.equal(backoffMs(1, walled), 42_000);
  // Still bounded, so a wild value cannot park the batch for an hour.
  assert.equal(backoffMs(1, providerError('rateLimited', { retryAfterSeconds: 99_999 })), 60_000);
});

test('backoff grows, is jittered, and is capped', () => {
  const error = providerError('timeout');
  // random() = 0 is the low end of the jitter window, random() = 1 the high.
  assert.equal(backoffMs(1, error, () => 1), 2_000);
  assert.equal(backoffMs(2, error, () => 1), 4_000);
  assert.equal(backoffMs(3, error, () => 1), 8_000);
  assert.equal(backoffMs(99, error, () => 1), 60_000);

  // Jitter is what stops twenty units that failed together coming back together.
  assert.equal(backoffMs(1, error, () => 0), 1_000);
  assert.ok(backoffMs(1, error, () => 0.5) > 1_000);
});

test('the attempt count is configurable and bounded', () => {
  assert.equal(unitAttempts({}), 3);
  assert.equal(unitAttempts({ AI_UNIT_ATTEMPTS: '5' }), 5);
  assert.equal(unitAttempts({ AI_UNIT_ATTEMPTS: '1' }), 1, 'one attempt means no retry');
  assert.equal(unitAttempts({ AI_UNIT_ATTEMPTS: '99' }), 6, 'capped');
  assert.equal(unitAttempts({ AI_UNIT_ATTEMPTS: 'lots' }), 3);
});

test('a run of failures reports each retry once', async () => {
  const seen = [];
  await assert.rejects(
    withUnitRetry(async () => { throw providerError('timeout'); }, {
      ...instant,
      onRetry: (info) => seen.push(info.attempt),
    })
  );
  // Two waits for three attempts: nothing waits after the last one.
  assert.deepEqual(seen, [1, 2]);
});
