# Camunda 8 CLI Project

This project provides a cli for Camunda 8. It is based on the Camunda 8 Orchestration
Cluster API in assets/rest-api.yaml and the npm module https://www.npmjs.com/package/@camunda8/orchestration-cluster-api. It makes the REST API available with corresponding commands from the command line.

## Commit Message Guidelines

Follow conventions in COMMIT-MESSAGE-GUIDELINE.md.

## Implementation Details

### Development

- use Node.js 24 LTS only
- this is a native Node.js project running TS files
- there is no build step for development. Only compile for test purposes or release.

- prefer functional programming over OOP where reasonable
- prefer concise expressions over verbose control structures

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
