/**
 * Row mapping for the suspend and resume process definition commands.
 */

type SuspensionResult = {
	processDefinitions: Array<{
		processDefinitionKey: string;
		processDefinitionVersion: number;
		outcome: string;
	}>;
	batchOperationKey: string | null;
};

/**
 * One row per affected version. A missing batch operation key stays null so
 * JSON output keeps the API contract; text rendering shows an empty cell.
 */
export function suspensionRows(result: SuspensionResult) {
	return result.processDefinitions.map((pd) => ({
		processDefinitionKey: pd.processDefinitionKey,
		version: pd.processDefinitionVersion,
		outcome: pd.outcome,
		batchOperationKey: result.batchOperationKey,
	}));
}
