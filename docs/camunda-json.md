---
id: camunda-json
title: "camunda.json"
sidebar_label: "camunda.json"
description: "The camunda.json project descriptor marks a folder as a Camunda project and holds the optional Camunda Hub link."
---

<!-- This page is maintained in the c8ctl repository (https://github.com/camunda/c8ctl, in docs/) and
     is synced to camunda-docs automatically. Do not edit it in camunda-docs — changes will be
     overwritten. Edit the source in the c8ctl repo instead. -->

A `camunda.json` file in the root of a folder marks the folder as a [Camunda project](/components/concepts/projects.md), the unit you build, test, and deploy together. Desktop Modeler and `c8ctl` recognize the file.

## File location and format

The file is named `camunda.json`, lives in the root of your project folder, and contains a single JSON object. There is one project per folder, and projects don't nest. In a monorepo, use sibling folders with one `camunda.json` each.

## Fields

| Field             | Type     | Description                                                            |
| :---------------- | :------- | :--------------------------------------------------------------------- |
| `hub`             | object   | Optional. Camunda Hub connection settings.                             |
| `hub.projectId`   | string   | Optional. ID of the linked project in Camunda Hub.                     |
| `deployResources` | string[] | Optional. Glob patterns selecting which files deploy with the project. |

All fields are optional. An empty `camunda.json` (`{}`) is valid and simply marks the folder as a project.

### hub.projectId

Links the local project to a project in [Camunda Hub](/components/hub/index.md).

A project does not need a Hub link. You can create a folder with `camunda.json`, build, and deploy locally with `c8 deploy`, and connect it to Hub later.

### deployResources

Selects which files in the project are deployed, using an array of glob patterns.

Patterns follow a similar syntax to [`.gitignore`](https://git-scm.com/docs/gitignore), but reversed: patterns **select** files instead of excluding them.

- Patterns are relative to the project root and use `/` separators. Absolute paths and `..` are invalid.
- Prefix a pattern with `!` to deselect matches.
- Patterns apply in order; the last matching pattern wins per file.
- Positive patterns select files in subdirectories directly, and a later positive pattern re-selects a file below an earlier excluded directory.
- An invalid field or pattern, or an empty final selection, fails the deployment. A pattern that matches nothing is silently ignored.

When `deployResources` is present, it acts as an allowlist: selection starts empty, the default extension scan does not apply, and `.c8ignore` is ignored. When it is omitted, the default scan rules apply unchanged.

Excluded by default, but selectable through explicit allowlisting: `node_modules/`, `target/`, `.git/`, and the project-root `camunda.json`.

Wildcard patterns never select files whose name starts with a dot. A pattern naming the file explicitly (for example `resources/.prompt.md`) selects it. Hidden directories are traversed normally.

For usage scenarios — generated resources, hidden files, broad selections — see [Select resources with `deployResources`](development-workflows.md#select-resources-with-deployresources).

## Example

```json
{
  "hub": {
    "projectId": "<hub-project-id>"
  },
  "deployResources": ["resources/**", "!resources/drafts/**"]
}
```

## Related resources

- [Development workflows](development-workflows.md): deploy, run, and watch projects with `c8ctl`.
- [Projects](/components/concepts/projects.md): the Camunda project concept across Hub and Desktop Modeler.
