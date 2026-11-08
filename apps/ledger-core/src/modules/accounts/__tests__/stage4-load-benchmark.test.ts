import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { performance } from 'node:perf_hooks';

// Silence pino-pretty terminal stdout formatting during throughput benchmarking
process.env.LOG_LEVEL = 'warn';

import { buildServer } from '../../../index';

interface BenchmarkMetrics {
  name: string;
  concurrency: number;
  totalRequests: number;
  durationSec: number;
  rps: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  p999Ms: number;
  errors: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Number(sorted[idx]!.toFixed(2));
}

async function runHttpBenchmark(opts: {
  name: string;
  port: number;
  concurrency: number;
  totalRequests: number;
  makeRequestOptions: (reqIndex: number) => {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: string;
  };
  expectedStatuses: number[];
}): Promise<BenchmarkMetrics> {
  const agent = new http.Agent({
    keepAlive: true,
    maxSockets: opts.concurrency,
  });

  const latenciesMs: number[] = new Array(opts.totalRequests);
  let nextIndex = 0;
  let errors = 0;

  const sendOne = (reqIdx: number): Promise<void> =>
    new Promise((resolve) => {
      const reqSpec = opts.makeRequestOptions(reqIdx);
      const start = performance.now();

      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: opts.port,
          method: reqSpec.method,
          path: reqSpec.path,
          headers: reqSpec.headers,
          agent,
        },
        (res) => {
          res.resume();
          res.on('end', () => {
            latenciesMs[reqIdx] = performance.now() - start;
            if (!opts.expectedStatuses.includes(res.statusCode ?? 0)) {
              errors += 1;
            }
            resolve();
          });
        }
      );

      req.on('error', () => {
        latenciesMs[reqIdx] = performance.now() - start;
        errors += 1;
        resolve();
      });

      if (reqSpec.body) {
        req.write(reqSpec.body);
      }
      req.end();
    });

  const startWall = performance.now();

  const workers = Array.from({ length: opts.concurrency }, async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= opts.totalRequests) break;
      await sendOne(current);
    }
  });

  await Promise.all(workers);
  const durationSec = (performance.now() - startWall) / 1000;
  agent.destroy();

  const sorted = [...latenciesMs].sort((a, b) => a - b);

  return {
    name: opts.name,
    concurrency: opts.concurrency,
    totalRequests: opts.totalRequests,
    durationSec: Number(durationSec.toFixed(2)),
    rps: Math.round(opts.totalRequests / durationSec),
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    p999Ms: percentile(sorted, 99.9),
    errors,
  };
}

describe('Stage 4: Accounts Module — HTTP Load, Latency & Throughput Benchmark Suite', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let port = 0;
  const TEST_TENANT = `tnt_stage4_${Date.now()}`;
  let targetAccountId = '';
  const allMetrics: BenchmarkMetrics[] = [];

  before(async () => {
    app = await buildServer({ logger: false });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (typeof address === 'object' && address) {
      port = address.port;
    }

    const boot = await app.inject({
      method: 'POST',
      url: '/v1/accounts/bootstrap',
      headers: { 'x-tenant-id': TEST_TENANT },
      payload: { currency: 'INR' },
    });
    const clearingId = boot
      .json()
      .data.accounts.find((a: { category: string }) => a.category === 'SYSTEM_CLEARING').id;

    const accRes = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: { 'x-tenant-id': TEST_TENANT },
      payload: { owner_id: 'usr_bench_target', category: 'USER_WALLET', currency: 'INR' },
    });
    targetAccountId = accRes.json().data.id;

    // Seed 20 ledger entries on targetAccountId for realistic balance aggregation
    await app.sql.begin(async (tx) => {
      for (let i = 0; i < 10; i++) {
        const [txRow] = await tx`
          INSERT INTO transactions (tenant_id, idempotency_key, type, status)
          VALUES (${TEST_TENANT}, ${`idem_bench_${i}_${TEST_TENANT}`}, 'PAYMENT', 'PENDING')
          RETURNING id
        `;
        await tx`
          INSERT INTO ledger_entries (tenant_id, transaction_id, account_id, entry_type, amount, currency)
          VALUES
            (${TEST_TENANT}, ${txRow!.id}, ${targetAccountId}, 'CREDIT', 1000, 'INR'),
            (${TEST_TENANT}, ${txRow!.id}, ${clearingId}, 'DEBIT', 1000, 'INR')
        `;
        await tx`UPDATE transactions SET status = 'COMPLETED', completed_at = now() WHERE id = ${txRow!.id}`;
      }
    });
  });

  after(async () => {
    console.log('\n=========================================================================================');
    console.log('STAGE 4: HTTP LOAD & LATENCY BENCHMARK RESULTS (Concurrency = 20, Keep-Alive TCP)');
    console.log('=========================================================================================');
    console.table(
      allMetrics.map((m) => ({
        Endpoint: m.name,
        Reqs: m.totalRequests,
        'p50 (ms)': m.p50Ms,
        'p95 (ms)': m.p95Ms,
        'p99 (ms)': m.p99Ms,
        'p99.9 (ms)': m.p999Ms,
        'Throughput (RPS)': m.rps,
        Errors: m.errors,
      }))
    );
    console.log('=========================================================================================\n');

    if (app) {
      await app.close();
    }
  });

  it('4.1 Benchmarks GET /health/live (Liveness Probe — Zero DB I/O)', async () => {
    const metrics = await runHttpBenchmark({
      name: 'GET /health/live',
      port,
      concurrency: 20,
      totalRequests: 2000,
      makeRequestOptions: () => ({
        method: 'GET',
        path: '/health/live',
      }),
      expectedStatuses: [200],
    });
    allMetrics.push(metrics);

    assert.equal(metrics.errors, 0);
    assert.ok(metrics.p50Ms < 10, `Expected p50 < 10ms, got ${metrics.p50Ms}ms`);
  });

  it('4.2 Benchmarks POST /v1/accounts (Invalid 400 AJV Schema Rejection Boundary)', async () => {
    const invalidPayload = JSON.stringify({ owner_id: 'usr_1', currency: 'invalid' });
    const metrics = await runHttpBenchmark({
      name: 'POST /v1/accounts (400 AJV Guard)',
      port,
      concurrency: 20,
      totalRequests: 2000,
      makeRequestOptions: () => ({
        method: 'POST',
        path: '/v1/accounts',
        headers: {
          'content-type': 'application/json',
          'x-tenant-id': TEST_TENANT,
        },
        body: invalidPayload,
      }),
      expectedStatuses: [400],
    });
    allMetrics.push(metrics);

    assert.equal(metrics.errors, 0);
    assert.ok(metrics.p50Ms < 10, `Expected p50 < 10ms, got ${metrics.p50Ms}ms`);
  });

  it('4.3 Benchmarks GET /v1/accounts/:id (Point Lookup via uq_accounts_tenant_id)', async () => {
    const metrics = await runHttpBenchmark({
      name: 'GET /v1/accounts/:id',
      port,
      concurrency: 20,
      totalRequests: 1000,
      makeRequestOptions: () => ({
        method: 'GET',
        path: `/v1/accounts/${targetAccountId}`,
        headers: { 'x-tenant-id': TEST_TENANT },
      }),
      expectedStatuses: [200],
    });
    allMetrics.push(metrics);

    assert.equal(metrics.errors, 0);
    assert.ok(metrics.p50Ms < 15, `Expected p50 < 15ms, got ${metrics.p50Ms}ms`);
  });

  it('4.4 Benchmarks GET /v1/accounts/:id/balance (Hot Balance — Singleflight + Index-Only Scan)', async () => {
    const metrics = await runHttpBenchmark({
      name: 'GET /v1/accounts/:id/balance',
      port,
      concurrency: 20,
      totalRequests: 1500,
      makeRequestOptions: () => ({
        method: 'GET',
        path: `/v1/accounts/${targetAccountId}/balance`,
        headers: { 'x-tenant-id': TEST_TENANT },
      }),
      expectedStatuses: [200],
    });
    allMetrics.push(metrics);

    assert.equal(metrics.errors, 0);
    assert.ok(metrics.p50Ms < 15, `Expected p50 < 15ms, got ${metrics.p50Ms}ms`);
  });

  it('4.5 Benchmarks POST /v1/accounts (Sustained Distinct Account Creation Writes)', async () => {
    const metrics = await runHttpBenchmark({
      name: 'POST /v1/accounts (201 Writes)',
      port,
      concurrency: 20,
      totalRequests: 500,
      makeRequestOptions: (idx) => ({
        method: 'POST',
        path: '/v1/accounts',
        headers: {
          'content-type': 'application/json',
          'x-tenant-id': TEST_TENANT,
        },
        body: JSON.stringify({
          owner_id: `usr_load_${idx}`,
          category: 'USER_WALLET',
          currency: 'INR',
        }),
      }),
      expectedStatuses: [201],
    });
    allMetrics.push(metrics);

    assert.equal(metrics.errors, 0);
    assert.ok(metrics.p50Ms < 25, `Expected p50 < 25ms, got ${metrics.p50Ms}ms`);
  });
});
