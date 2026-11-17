import type { Template } from "./helpers.ts";
import type { ElementValue } from "./migration-values.ts";
import type { ModdleElement } from "./moddle.ts";
import type { BpmnElement, ModelerInstance } from "./vendor.ts";

export type MigrationTemplate = Template & { id: string };

export type Recipe = {
	sources: (
		| {
				kind: "upgrade";
				sourceTemplateId: string;
				toVersion: number;
		  }
		| {
				kind: "change";
				sourceTemplateId: string;
				minSourceVersion?: number;
		  }
	)[];
};

export interface Note {
	level: "info" | "warning";
	message: string;
}

export interface Field {
	key: string;
	bindingType: string | null;
	label?: string;
	group?: string;
	groupLabel?: string;
	propertyId?: string;
}

export type ValueSource = "recipe" | "map" | "default" | "fixed";

export interface TemplateRef {
	id: string;
	version: number;
	name?: string;
	deprecated: boolean;
}

export interface ValueChange {
	from: string;
	to: string;
	fromName?: string;
	toName?: string;
}

export interface MovedItem {
	from: Field;
	to: Field;
	value: string;
	valueName?: string;
	valueChange?: ValueChange;
	source: "recipe" | "map";
}

export interface ReportStep {
	kind: "version" | "hop";
	templateId: string;
	fromVersion: number;
	toVersion: number;
	implicit?: true;
}

export interface MigrationReport {
	from: TemplateRef;
	to: TemplateRef;
	usedRecipe: boolean;
	refusal: string | null;
	steps: ReportStep[];
	dropped: (Field & {
		value: string;
		valueName?: string;
		cause?: "hidden" | "displaced";
	})[];
	added: (Field & {
		value: string;
		valueName?: string;
		source: ValueSource;
	})[];
	changed: (Field & { valueChange: ValueChange; source: ValueSource })[];
	moved: MovedItem[];
	kept: Field[];
	notes: Note[];
	skipped: {
		guard: { from: string; to: string }[];
		template: { to: string; missing: string[] }[];
		noMatch: { from: string; to: string }[];
		feel: { from: string; to: string }[];
		unchecked: Field[];
	};
	lossless: boolean;
}

export interface AppliedTemplate {
	id: string;
	version: number;
}

export interface ValueMap {
	from: { key: string; bindingType: string | null };
	to: { key: string; bindingType: string | null };
}

export type MigrationModeler = Pick<ModelerInstance, "get">;

export interface MigrationOptions {
	modeler: MigrationModeler;
	element: BpmnElement;
	fromTemplate: MigrationTemplate;
	sourceKnown?: boolean;
	target: MigrationTemplate;
	templates: MigrationTemplate[];
	recipe?: unknown;
	engineVersion?: string;
	isCompatible?: (template: MigrationTemplate) => boolean;
	maps?: ValueMap[];
}

export interface MigrationResult {
	element: BpmnElement;
	report: MigrationReport;
}

export interface FieldKey {
	key: string;
	bindingType: string | null;
}

export interface ReportFacts {
	moved: {
		from: FieldKey;
		to: FieldKey;
		transformed: boolean;
		map?: boolean;
		value?: string;
		read?: string;
	}[];
	set: (FieldKey & { value: string })[];
	notes: Note[];
	guardSkipped: { from: string; to: string }[];
	templateSkipped: { to: string; missing: string[] }[];
	noMatch: { from: string; to: string }[];
	feelSkipped: { from: string; to: string }[];
	after?: ElementValue[];
	failedWrites?: boolean;
	written?: FieldKey[];
	reset?: (FieldKey & { from: string })[];
}

export interface BuildReportOptions {
	fromTemplate: MigrationTemplate;
	toTemplate: MigrationTemplate;
	via?: MigrationTemplate[];
	before: ElementValue[];
	after: ElementValue[];
	facts: ReportFacts;
	usedRecipe: boolean;
	refusal: string | null;
	steps?: ReportStep[];
	lostInImplicitSteps?: ElementValue[];
	implicitTemplates?: MigrationTemplate[];
}

export interface DestinationError extends Error {
	carryOver: boolean;
}

export interface MigrationApi {
	migrateElement(options: MigrationOptions): MigrationResult;
	parseRecipe(raw: unknown): Recipe;
	resolveCatalog(
		templates: MigrationTemplate[],
		authoritative?: MigrationTemplate[],
	): MigrationTemplate[];
	latestOf(
		templates: MigrationTemplate[],
		id: string,
	): MigrationTemplate | undefined;
	findSuccessors(
		candidates: MigrationTemplate[],
		appliedId: string,
		appliedVersion: number,
		templates: MigrationTemplate[],
	): MigrationTemplate[];
	readEmbeddedRecipe(template: { metadata?: unknown }): Recipe | undefined;
	validateRecipeOwner(
		recipe: Recipe,
		owner: { id: string; version?: number },
	): void;
	readAppliedTemplate(
		businessObject: ModdleElement,
	): AppliedTemplate | undefined;
	RecipeError: new (message: string) => Error;
	DestinationError: new (
		message: string,
		carryOver: boolean,
	) => DestinationError;
	emptyFacts(): ReportFacts;
	buildReport(options: BuildReportOptions): MigrationReport;
}

export type { ElementValue };
