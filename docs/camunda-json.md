---
id: camunda-json
title: "camunda.json"
sidebar_label: "camunda.json"
description: "The camunda.json project descriptor marks a folder as a Camunda project and holds the optional Camunda Hub link, recognized across all Camunda tools."
---

<!-- This page is maintained in the c8ctl repository (https://github.com/camunda/c8ctl, in docs/) and
     is synced to camunda-docs automatically. Do not edit it in camunda-docs — changes will be
     overwritten. Edit the source in the c8ctl repo instead. -->

A `camunda.json` file in the root of a folder marks the folder as a [Camunda project](/components/concepts/projects.md) — the unit that is built, tested, and deployed together. The same file is recognized by Camunda Hub, Desktop Modeler, and `c8ctl`, similar to how `package.json` marks an npm package.

:::tip
Camunda projects supersede **process applications**. During the transition, tools read both `camunda.json` and the legacy `.process-application` marker file, and the `--pa` flag remains as an alias. Your existing process applications keep working; switch to `camunda.json` when you are ready.
:::

## File location and format

The file is named `camunda.json`, lives in the root of your project folder, and contains a single JSON object. There is one project per folder — projects do not nest; in a monorepo, use sibling folders with one `camunda.json` each.

## Fields

| Field           | Type   | Description                                        |
| :-------------- | :----- | :------------------------------------------------- |
| `hub`           | object | Optional. Camunda Hub connection settings.         |
| `hub.projectId` | string | Optional. ID of the linked project in Camunda Hub. |

All fields are optional. An empty `camunda.json` (`{}`) is valid and simply marks the folder as a project.

### hub.projectId

Links the local project to a project in [Camunda Hub](/components/hub/index.md). Locally, `c8 hub link` writes the link into an existing `camunda.json`. Use `c8 hub link --create` to create the Hub project and link it in one step.

A project does not need a Hub link. You can create a folder with `camunda.json`, build, and deploy locally with `c8 deploy`, and connect it to Hub later.

## Example

```json
{
  "hub": {
    "projectId": "<hub-project-id>"
  }
}
```

## Related resources

- [Development workflows](development-workflows.md) — deploy, run, and watch projects with `c8ctl`.
- [Projects](/components/concepts/projects.md) — the Camunda project concept across Hub and Desktop Modeler.
