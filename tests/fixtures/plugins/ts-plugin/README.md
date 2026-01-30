# Sample TypeScript Plugin

Sample c8ctl plugin demonstrating custom commands in TypeScript.

## Installation

```bash
npm install
```

## Usage

This plugin can be loaded by c8ctl from the plugins directory. The TypeScript files are executed directly by Node.js without a build step.

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
