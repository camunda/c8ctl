---
id: cluster-variables
title: "Cluster variables"
sidebar_label: "Cluster variables"
description: "Use c8ctl to list, search, get, create, update, and delete global and tenant-scoped cluster variables in a Camunda 8 cluster."
---

<!-- This page is maintained in the c8ctl repository (https://github.com/camunda/c8ctl, in docs/) and
     is synced to camunda-docs automatically. Do not edit it in camunda-docs — changes will be
     overwritten. Edit the source in the c8ctl repo instead. -->

`c8ctl` manages cluster variables through the Orchestration Cluster API. A cluster variable holds a JSON object value, is scoped globally or to one tenant, and is referenced from process definitions.

| Verb     | Command                                  |
| :------- | :--------------------------------------- |
| `list`   | `c8 list cluster-variables`              |
| `search` | `c8 search cluster-variables [filters]`  |
| `get`    | `c8 get cluster-variable <name>`         |
| `create` | `c8 create cluster-variable <name> ...`  |
| `update` | `c8 update cluster-variable <name> ...`  |
| `delete` | `c8 delete cluster-variable <name>`      |

:::note
`update`, `--metadata`, and `--kind` require a Camunda 8.10 or later cluster.
:::

## Global and tenant scope

Commands operate on global variables by default. Pass `--tenantId <id>` to target a tenant-scoped variable. The flag is explicit: the active session or profile tenant is never used implicitly.

```bash
c8 get cluster-variable MY_VAR                    # global
c8 get cluster-variable MY_VAR --tenantId acme    # tenant "acme"
```

A name may contain letters, digits, and `_ ~ @ . + -` (1 to 256 characters). `create`, `update`, and `delete` also accept `--dry-run` to preview the request.

## List and search

```bash
c8 list cluster-variables
c8 search cluster-variables --name='DB_*' --scope TENANT --tenantId acme
c8 search cluster-variables --kind SECRET_REFERENCE
c8 search cluster-variables --isTruncated
```

Output columns: `Name`, `Scope`, `Tenant ID`, `Kind`, `Value`, `Truncated`.

| Flag            | Description                                    |
| :-------------- | :--------------------------------------------- |
| `--name`        | Filter by name (supports wildcards)            |
| `--value`       | Filter by value (supports wildcards)           |
| `--scope`       | `GLOBAL` or `TENANT`                           |
| `--tenantId`    | Filter by tenant ID                            |
| `--kind`        | `JSON` or `SECRET_REFERENCE`                   |
| `--isTruncated` | Only variables whose stored value is truncated |
| `--fullValue`   | Return full values instead of truncated ones   |

`list` and `search` truncate long values by default. Use `--fullValue` on `search`, or `get`, to read the complete value.

## Get

```bash
c8 get cluster-variable MY_VAR
c8 get cluster-variable MY_VAR --tenantId acme
```

`get` returns the full value. The `value` field is the JSON string stored by the cluster.

## Create

```bash
c8 create cluster-variable MY_VAR --value '{"url":"https://example.org"}'
c8 create cluster-variable MY_VAR --value @value.json --tenantId acme
cat value.json | c8 create cluster-variable MY_VAR --value @-
c8 create cluster-variable MY_VAR --value '{"a":1}' --metadata '{"owner":"ops"}'
```

| Flag         | Description                                                                      |
| :----------- | :------------------------------------------------------------------------------- |
| `--value`    | Required. JSON object, `@file.json`, or `@-` for stdin                           |
| `--metadata` | JSON object with string or number values, `@file.json`, or `@-`                  |
| `--kind`     | `JSON` (default) or `SECRET_REFERENCE`                                           |
| `--tenantId` | Create a tenant-scoped variable                                                  |

The value must be a JSON object. Arrays and primitive values are rejected. Use `@file.json` or `@-` to avoid shell quoting problems, for example in PowerShell.

Use `--kind SECRET_REFERENCE` for a variable that points at a Camunda Credential Manager secret, such as `{"ref":"camunda.secrets.MY_SECRET"}`.

## Update

```bash
c8 update cluster-variable MY_VAR --value '{"url":"https://example.org/v2"}'
c8 update cluster-variable MY_VAR --value @value.json --metadata '{"owner":"ops"}' --tenantId acme
```

`update` replaces the value and, when given, the metadata. The kind cannot be changed after creation.

## Delete

```bash
c8 delete cluster-variable MY_VAR
c8 delete cluster-variable MY_VAR --tenantId acme
```
