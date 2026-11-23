/** @type {import('@docusaurus/plugin-content-docs').SidebarsConfig} */

module.exports = [
  {
    type: "category",
    label: "Camunda 8 CLI",
    link: {
      type: "doc",
      id: "apis-tools/c8ctl/getting-started",
    },
    items: [
      "apis-tools/c8ctl/cluster-inspection",
      "apis-tools/c8ctl/identity-management",
      "apis-tools/c8ctl/development-workflows",
      "apis-tools/c8ctl/camunda-json",
      "apis-tools/c8ctl/plugins",
      "apis-tools/c8ctl/command-reference",
    ],
  },
];
