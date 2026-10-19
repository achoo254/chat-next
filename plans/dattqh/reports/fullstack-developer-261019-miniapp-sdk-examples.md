# Mini App example bots + conformance scenario

Status: done, not committed.

## Changes
- `sdk/ts/examples/miniapp.ts`, `sdk/python/examples/miniapp.py`, `sdk/go/examples/miniapp/main.go`: `/start` sends the button `Mở cửa hàng` → `web_app: {url: MINI_APP_URL}` (default `https://shop.example.com/app`). A backend on `MINI_APP_PORT` (default 8081) serves `POST /verify`. It verifies the raw init data with the SDK helper, the bot id from `getMe` and a cached `getMiniAppKey` key, fetching the key again once when verification fails. It answers 200 `{"user_id","chat_type"}`, 401 when the data is not genuine, 413 above 8 KiB and 500 when the key cannot be fetched. A message carrying `web_app_data` gets the reply `Đã nhận đơn: <data>`.
- `server/internal/api/sdk_conformance_test.go`: added `miniapp` to `conformanceExamples` and a `miniapp` scenario. The scenario checks the button's `mini_app_url`, calls `OpenMiniApp`, and expects `/verify` to return 200 with the user's id and `private`. It then sets `chat_type=group` and expects 401. Finally it calls `SendMiniAppData("order-42", "Mở cửa hàng")` and waits for the reply. `forExample` passes `MINI_APP_URL`/`MINI_APP_PORT` (a free port) to the example process through the new `extraEnv` argument of `runBot`. The Python command uses `$PYTHON` (default `python3`).
- Docs: the examples lists in the ts/python/go SDK READMEs and in `docs/bot-api/README.md` §12, plus the `PYTHON`/`cryptography` note.

## Verification
- `SDK_CONFORMANCE=1 PYTHON=<venv> go test -count=1 -run TestSDKConformance ./internal/api/`: ok, 46 PASS lines, 0 FAIL, including the 6 miniapp subtests.
- `sdk/go`: gofmt clean, go vet clean, `go test -race -p 2 ./...` ok. `sdk/ts`: tsc exit 0, vitest 50/50. `sdk/python` (venv): 68 tests OK, 1 skipped (the test that only runs without cryptography). `pnpm -s lint` exit 0.

## Notes
- The TS backend closes its server and connections on SIGINT/SIGTERM. Keep-alive sockets otherwise kept node alive until the runner's 5 s kill.
- `phase-15-sdk-contract.md` still describes 5 example bots. A `miniapp` row is not added, because plans were out of scope.
