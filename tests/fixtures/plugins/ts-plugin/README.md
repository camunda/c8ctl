# Sample TypeScript Plugin

Sample c8ctl plugin demonstrating custom commands in TypeScript.

## Installation

```bash
npm install
```

## Build

Compile TypeScript to JavaScript:

```bash
npm run build
```

This will transpile the TypeScript source to the `dist/` folder.

## Usage

This plugin can be loaded by c8ctl from the plugins directory after building.

## Commands

- `analyze` - Analyze processes and workflows
- `validate` - Validate BPMN files
- `config` - Manage configuration (get, set, list)

### Examples

```bash
c8 analyze file1.bpmn file2.bpmn
c8 validate process.bpmn
c8 config get timeout
c8 config set timeout 60s
c8 config list
```
