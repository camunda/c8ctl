# End-to-End Smoke Test for c8ctl

Quick validation script that tests basic CLI functionality.

## Prerequisites

- **Camunda 8** running at `http://localhost:8080`

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

Adjust wait times for slower environments:
```bash
C8_WAIT_TIME=2 ./tests/e2e/smoke-test.sh
```

**Note**: The test uses a `c8_cmd` wrapper function for all CLI commands:
- **State-changing commands** (deploy, create, run, publish, add, remove): Automatically waits after execution (default: 1 second) to ensure data is properly indexed
- **Read-only commands** (list, get, search): Uses `c8_cmd 0` to skip wait time
- **Custom wait**: Use `c8_cmd 2 publish msg` for longer waits
- The default wait time can be configured via the `C8_WAIT_TIME` environment variable

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
