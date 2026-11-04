# Benchmark: Location Ping Ingest (Phase 2)

- Date: 2026-11-04
- Git Commit: Phase 2 verification
- Machine: AMD Ryzen 7 7435HS (8 Cores, 16 Logical Processors), 24 GB RAM, Windows 11 Home Single Language (10.0.26300)
- Runtime: Node.js v24.19.0, k6 v0.56.0 (commit/50afb99947, go1.23.4, windows/amd64)

## Command

```bash
pnpm exec tsx tools/load-tests/run-benchmark.ts
# Under the hood:
# k6 run tools/load-tests/location-pings.js (with BASE_URL=http://127.0.0.1:3002)
```

## Scenario

- Target: `POST http://127.0.0.1:3002/drivers/me/location`
- Concurrency: 20 Virtual Users (VUs) simulating concurrent active drivers
- Pacing: ~100ms pause per VU (~10 pings/s per driver)
- Duration: 15 seconds sustained
- Telemetry payload: JSON containing `lat`, `lng`, `heading`, `speedMps`, `status`, `ts`, and `x-user-id` header

## Measured Results

| Metric                       | Measured Value                             |
| :--------------------------- | :----------------------------------------- |
| **Total Ingested Pings**     | **2,868**                                  |
| **Sustained Throughput**     | **189.97 pings/sec**                       |
| **Failed Requests**          | **0 (0.00%)**                              |
| **Check Pass Rate**          | **100.00%** (5,736 / 5,736 checks)         |
| **Latency (Average)**        | **4.35 ms**                                |
| **Latency (Median / p50)**   | **2.88 ms**                                |
| **Latency (p90)**            | **4.77 ms**                                |
| **Latency (p95)**            | **10.09 ms**                               |
| **Kafka Batches Dispatched** | **2,868 items** (flushed in micro-batches) |

## Raw k6 Output

```text
     ✓ status is 200
     ✓ has valid cell

     checks.........................: 100.00% 5736 out of 5736
     data_received..................: 943 kB  63 kB/s
     data_sent......................: 908 kB  60 kB/s
     http_req_blocked...............: avg=45.13µs  min=0s       med=0s       max=9.22ms   p(90)=0s       p(95)=0s
     http_req_connecting............: avg=41.94µs  min=0s       med=0s       max=9.22ms   p(90)=0s       p(95)=0s
   ✓ http_req_duration..............: avg=4.35ms   min=509.9µs  med=2.88ms   max=152.18ms p(90)=4.77ms   p(95)=10.09ms
       { expected_response:true }...: avg=4.35ms   min=509.9µs  med=2.88ms   max=152.18ms p(90)=4.77ms   p(95)=10.09ms
   ✓ http_req_failed................: 0.00%   0 out of 2868
     http_req_receiving.............: avg=249.73µs min=0s       med=0s       max=2.55ms   p(90)=820.54µs p(95)=995.47µs
     http_req_sending...............: avg=9.18µs   min=0s       med=0s       max=1.96ms   p(90)=0s       p(95)=0s
     http_req_tls_handshaking.......: avg=0s       min=0s       med=0s       max=0s       p(90)=0s       p(95)=0s
     http_req_waiting...............: avg=4.09ms   min=425.5µs  med=2.65ms   max=152.18ms p(90)=4.52ms   p(95)=10.01ms
     http_reqs......................: 2868    189.974858/s
     iteration_duration.............: avg=104.97ms min=100.68ms med=103.39ms max=262.52ms p(90)=105.4ms  p(95)=111.51ms
     iterations.....................: 2868    189.974858/s
     location_ingest_duration_ms....: avg=4.464784 min=0        med=3        max=163      p(90)=5        p(95)=10
     location_pings_total_k6........: 2868    189.974858/s
     vus............................: 20      min=20           max=20
     vus_max........................: 20      min=20           max=20
```
