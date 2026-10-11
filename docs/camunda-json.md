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

Selects which files in the project are deployed, using an array of glob patterns. The syntax follows the conventions you know from `package.json` (`files`) and `.gitignore`:

- Patterns are relative to the project root.
- Prefix a pattern with `!` to exclude matches.
- Patterns apply in order; later patterns override earlier ones.

When `deployResources` is present, **only** matching files deploy — it replaces the default directory-scan rules (deployable file extensions, filtered by [`.c8ignore`](development-workflows.md#exclude-files-with-c8ignore)). When it is omitted, the default scan rules apply. Files you name explicitly on the command line are always deployed, regardless of `deployResources`:

```bash
c8 deploy ./custom-resource.unsupported
```

## Example

```json
{
  "hub": {
    "projectId": "<hub-project-id>"
  },
  "deployResources": ["resources/**", "!resources/drafts/**"]
}
```

```text
invoicing/
├── camunda.json
├── README.md                   # not deployed (outside resources/)
├── AGENTS.md                   # not deployed (outside resources/)
└── resources/
    ├── invoice.bpmn            # deploys
    ├── invoice.dmn             # deploys
    ├── AGENT_TASK_PROMPT-3.md  # deploys
    └── drafts/
        └── invoice-v2.bpmn     # not deployed (excluded)
```

With this configuration, everything under `resources/` deploys — including non-BPMN resources such as agent task prompts — while work in progress under `resources/drafts/` is excluded. Anything outside `resources/`, such as `README.md` or `AGENTS.md`, does not deploy because `deployResources` defines the complete set of deployable files.

## Related resources

- [Development workflows](development-workflows.md) — deploy, run, and watch projects with `c8ctl`.
- [Projects](/components/concepts/projects.md) — the Camunda project concept across Hub and Desktop Modeler.
