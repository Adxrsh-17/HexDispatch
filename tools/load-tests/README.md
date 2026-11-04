# load-tests

k6 scripts for HexDispatch. k6 is a standalone binary (https://k6.io); install it separately.

- `smoke.js`: placeholder that checks the gateway `/health`.
- Phase 2 adds the driver-ping ingest test; Phase 9 adds ride creation and WebSocket fan-out.

Record only measured results, together with the command, git commit and machine description, in `docs/benchmarks/`.
