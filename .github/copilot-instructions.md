# Camunda 8 CLI Project

This project provides a cli for Camunda 8. It is based on the Camunda 8 Orchestration
Cluster API in assets/rest-api.yaml and the npm module https://www.npmjs.com/package/@camunda8/orchestration-cluster-api. It makes the REST API available with corresponding commands from the command line.

## Commit Message Guidelines

Follow conventions in COMMIT-MESSAGE-GUIDELINE.md.

## Implementation Details

- this is a native Node.js project running TS files
- there is no build step, files are run directly with Node.js >= 22.18.0
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
