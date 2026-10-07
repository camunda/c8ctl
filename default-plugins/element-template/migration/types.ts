/**
 * Minimal shapes of the element template data the migration engine reads.
 * Structural on purpose: any template object that satisfies them works.
 */

export interface TemplateBinding {
	type: string;
	name?: string;
	source?: string;
	key?: string;
	property?: string;
}

export interface TemplateProperty {
	id?: string;
	label?: string;
	group?: string;
	type?: string;
	value?: unknown;
	feel?: string;
	optional?: boolean;
	constraints?: { notEmpty?: boolean };
	condition?: unknown;
	binding?: TemplateBinding;
}

export interface MigrationTemplate {
	id: string;
	version?: number;
	name?: string;
	deprecated?: boolean | { message?: string };
	appliesTo?: string[];
	elementType?: { value?: string };
	groups?: { id: string; label: string }[];
	properties: TemplateProperty[];
	metadata?: unknown;
}
