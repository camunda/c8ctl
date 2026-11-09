---
id: camunda-json
title: "camunda.json"
sidebar_label: "camunda.json"
description: "The camunda.json project descriptor marks a folder as a Camunda project and holds the optional Camunda Hub link and resource selection."
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

Selects which files in the project are its resources, using an array of glob patterns. The selected set is what `c8 deploy` and `c8 deploy --dry-run` submit for the project and what `c8 watch --project` watches and redeploys.

Patterns use the same syntax as [`.c8ignore`](development-workflows.md#exclude-files-with-c8ignore), a subset of [`.gitignore`](https://git-scm.com/docs/gitignore), but reversed: patterns **select** files instead of excluding them.

- Patterns are relative to the project root and use `/` separators. Absolute paths (including a leading `/`) and `..` are invalid.
- A pattern without a `/` in the middle matches at any depth (`*.bpmn`, `drafts/`). A pattern with a `/` in the middle is anchored to the project root (`resources/**`). A directory pattern such as `resources/` selects everything inside matching directories.
- Prefix a pattern with `!` to deselect matches.
- Selection starts empty. Patterns apply in order, and the last matching pattern wins for each file.
- Positive patterns select files in subdirectories directly, and a later positive pattern re-selects a file below an earlier excluded directory. Unlike `.gitignore`, you don't need to re-include the parent directory first.

When `deployResources` is present, it acts as an allowlist: the default extension scan doesn't apply and `.c8ignore` is ignored. When it is omitted, the default scan rules apply unchanged.

`node_modules/`, `target/`, `.git/`, and the project-root `camunda.json` are excluded by default. These defaults apply before your patterns, so a later positive pattern that matches a file inside them selects it. For example, `target/classes/**` selects generated resources and `**/*` selects everything, including `target/`, `node_modules/` and `camunda.json`. Add exclusions after a broad pattern to narrow it, such as `["**/*", "!node_modules/", "!target/", "!camunda.json"]`.

Wildcards (`*`, `?`, `**`, `[...]`) never match a file or folder whose name starts with a dot. A pattern that names it explicitly selects it, for example `resources/.prompt.md` or `.camunda/**`. Control files such as `.c8ignore` and `.process-application` are therefore never selected by wildcards.

Validation:

- A field that is not an array of strings, or an invalid pattern (empty, a bare `!`, a `#` comment, an absolute path, or one containing `..`), is an error. Nothing is deployed.
- An empty final selection is an error. Nothing is deployed.
- A `camunda.json` that exists but can't be read (for example a folder with that name, or a file without read permission) is an error when you deploy or watch the project. `c8ctl` never falls back to the default scan in that case.
- A pattern that matches no file is silently ignored.

Nested projects are not supported. A `camunda.json` in a subfolder doesn't exclude that subfolder from the selection. Add a `!` pattern to exclude it.

For usage scenarios, such as generated resources, hidden files, and command-line flags, see [Select resources with `deployResources`](development-workflows.md#select-resources-with-deployresources).

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
