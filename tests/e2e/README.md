# End-to-End Smoke Test for c8ctl

Quick validation script that tests basic CLI functionality.

## Prerequisites

- **Camunda 8** running at `http://localhost:8080` (self-managed default: `http://localhost:8080/v2`, basic auth `demo`/`demo`)
- **Node.js 22 LTS**

## Usage

```bash
./tests/e2e/smoke-test.sh
```

Run with verbose output to see command responses:
```bash
./tests/e2e/smoke-test.sh --verbose
# or
./tests/e2e/smoke-test.sh -v
```

Adjust the polling timeout for slower environments:
```bash
C8_TIMEOUT=60 ./tests/e2e/smoke-test.sh
```

**Note**: The test automatically isolates its config from your real `~/.config/c8ctl` (or `~/Library/Application Support/c8ctl` on macOS) by setting `C8CTL_DATA_DIR` and `XDG_CONFIG_HOME` to a temporary directory that is cleaned up on exit.

State-changing commands (deploy, create, run, publish) are followed by polling helpers (`poll_until` / `poll_until_absent`) that retry assertions until the expected condition appears or `C8_TIMEOUT` (default: 30 seconds) is reached.

## Scenarios Covered

The smoke test validates these core CLI features:

1. **Help command**
2. **Deploy process**
3. **Create process instance** 
4. **Run command and list process instances** 
5. **Get topology** 
6. **User task search/completion** 
7. **Message correlation** 
8. **Search functionality** 
9. **Profile management**
