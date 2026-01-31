# Camunda 8 CLI Project

This project provides a cli for Camunda 8. It is based on the Camunda 8 Orchestration
Cluster API in assets/rest-api.yaml and the npm module https://www.npmjs.com/package/@camunda8/orchestration-cluster-api. It makes the REST API available with corresponding commands from the command line.

## Commit Message Guidelines

Follow conventions in COMMIT-MESSAGE-GUIDELINE.md.

## Implementation Details

### Work Environment

- when you are not in "Cloud" mode, make sure to evaluate the OS environment and adapt behavior accordingly
- prefer cross-platform solutions where reasonable

### Development

- use Node.js 22 LTS only by respecting .nvmrc
- this is a native Node.js project running TS files
- there is no build step for development. Only compile for test purposes or release.

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
