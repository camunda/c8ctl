# Camunda 8 CLI Project

This project provides a cli for Camunda 8. It is based on the Camunda 8 Orchestration
Cluster API npm module https://www.npmjs.com/package/@camunda8/orchestration-cluster-api. It makes the REST API available with corresponding commands from the command line.

## Commit Message Guidelines

Follow conventions in COMMIT-MESSAGE-GUIDELINE.md.

## Implementation Details

- always make sure that cli commands, resources and options are reflected in 
  - the `help` tests
  - README.md, EXAMPLES.md and other documentation
  - shell completion
  
- for every implementation, make sure to add or update tests that cover the new functionality. This includes unit tests for individual functions and integration tests for end-to-end scenarios. Tests should be comprehensive and cover edge cases to ensure the robustness of the codebase.

- in any test, only use the implemented cli commands to interact with the system. Avoid using internal functions or direct API calls in tests, as this can lead to brittle tests that are tightly coupled to the implementation. By using the cli commands, you ensure that your tests are more resilient to changes in the underlying code and better reflect real-world usage.

- don't use Promises in tests to wait for the overall system status to settle. Instead, use the polling helper from tests/utils/polling.ts to wait for specific conditions to be met.
  
- as a final Quality Gate before running tests, make sure to run `npm run build` to catch any compilation errors that might be missed by the test suite. This is especially important for catching type errors and ensuring that the codebase remains robust and maintainable.

### Work Environment

- when you are not in "Cloud" mode, make sure to evaluate the OS environment and adapt behavior accordingly
- prefer cross-platform solutions where reasonable

- always consult the GitHub repository camunda/orchestration-cluster-api-js for API details and usage examples. It is the main source of truth for how to interact with the Camunda 8 Orchestration Cluster API. As a backup, a copy of the REST API documentation is available in OpenAPI format in the `assets/c8/rest-api` folder. As a last resort, you should refer to the npm module https://www.npmjs.com/package/@camunda8/orchestration-cluster-api.

- always consult `.github/SDK_GAPS.md` for known SDK limitations before implementing features that interact with the Camunda SDK. When a newer SDK version is available, check whether gaps listed there have been resolved and update the file accordingly (mark resolved items, remove workarounds).

### Terminal Commands

- avoid heredocs (`<< EOF`) in terminal commands as they don't work reliably in zsh on macOS when executed via tools
- instead of heredocs, use one of these alternatives:
  - use the file editing tools (`create_file`, `replace_string_in_file`) to modify file content directly
  - use `echo` or `printf` for appending single lines: `echo "content" >> file.txt`
  - use `printf` for multi-line content: `printf 'line1\nline2\n' >> file.txt`

### Development

- **only use** Node.js 22 LTS and respect .nvmrc
- this is a native Node.js project running TS files
- there is no build step for development. Only compile for test purposes or release.
- on changes, make sure all tests pass and a build via `npm run build` works without errors

- pay attention on cross-platform compatibility (Linux, MacOS, Windows). _BUT_ only cater to WSL on Windows, no native Windows support.
- prefer functional programming over OOP where reasonable
- prefer concise expressions over verbose control structures
- when outputting errors, provide clear, concise and actionable hints to the user

- use modern TypeScript syntax and features
- use modern Getter and Setter syntax for class properties. Examples:

```typescript
class MyClass {
  private _myProp: string;  
  get myProp(): string {
    return this._myProp;
  }
  set myProp(value: string) {
    this._myProp = value;
  }
}
```
