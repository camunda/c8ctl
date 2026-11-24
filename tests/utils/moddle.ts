/**
 * Plain-object stand-ins for moddle elements, for engine unit tests.
 */

import type { ModdleElement } from "../../default-plugins/element-template/migration/moddle.ts";

export function moddle(
	$type: string,
	props: Record<string, unknown>,
): ModdleElement {
	return { $type, ...props, get: (name: string) => props[name] };
}

export function extensionElements(...values: ModdleElement[]): ModdleElement {
	return moddle("bpmn:ExtensionElements", { values });
}
