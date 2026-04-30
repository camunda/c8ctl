/**
 * Ambient module declarations for the untyped bpmn-io ecosystem libraries
 * used by this plugin. Declarations are deliberately narrow — only the
 * surface this plugin actually uses — so type guards remain at the
 * boundaries.
 */

declare module "bpmn-moddle" {
	export type BpmnModdleAttrs = Record<string, string | undefined>;
	export type BpmnModdleElement = { $attrs?: BpmnModdleAttrs };
	export type BpmnModdleParseResult = { rootElement: BpmnModdleElement };
	export default class BpmnModdle {
		constructor(extensions?: Record<string, unknown>);
		fromXML(xml: string): Promise<BpmnModdleParseResult>;
	}
}

declare module "zeebe-bpmn-moddle/resources/zeebe.json" {
	const schema: Record<string, unknown>;
	export default schema;
}

declare module "bpmnlint" {
	export type LintReport = {
		category: string;
		id?: string;
		message: string;
		name?: string;
		path?: ReadonlyArray<string | number>;
	};
	export type LintResults = Record<string, LintReport[]>;
	export type LinterOptions = {
		config: Record<string, unknown>;
		resolver: unknown;
	};
	export class Linter {
		constructor(options: LinterOptions);
		lint(rootElement: unknown): Promise<LintResults>;
	}
}

declare module "bpmnlint/lib/resolver/node-resolver" {
	export default class NodeResolver {
		constructor(options: { require: NodeRequire });
	}
}

declare module "bpmnlint-plugin-camunda-compat" {
	const plugin: { configs: Record<string, unknown> };
	export default plugin;
}

declare module "@bpmn-io/moddle-utils" {
	export function pathStringify(path: ReadonlyArray<string | number>): string;
}
