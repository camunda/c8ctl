import { writeFileSync } from "node:fs";
import type {} from "../../src/runtime.ts";
import { createBpmnModdle, readBpmnInput } from "./lint.ts";

if (!globalThis.c8ctl) throw new Error("c8ctl runtime not initialised");

type ParsedArgs = {
	inPlace: boolean;
	filePath: string | undefined;
	error: string | null;
};

function parseArgs(args: string[]): ParsedArgs {
	const usage = "Usage: c8ctl bpmn format [<file.bpmn>] [--in-place | -i]";
	const endOfOpts = args.indexOf("--");
	const optionArgs = endOfOpts === -1 ? args : args.slice(0, endOfOpts);
	const positionalArgs = endOfOpts === -1 ? [] : args.slice(endOfOpts + 1);

	const unknownFlag = optionArgs.find(
		(a) => a.startsWith("-") && a !== "--in-place" && a !== "-i",
	);
	if (unknownFlag) {
		return {
			inPlace: false,
			filePath: undefined,
			error: `Unknown flag: ${unknownFlag}. ${usage}`,
		};
	}

	const allPositionals = [
		...positionalArgs,
		...optionArgs.filter((a) => !a.startsWith("-")),
	];
	if (allPositionals.length > 1) {
		return {
			inPlace: false,
			filePath: undefined,
			error: `Unexpected argument: ${allPositionals[1]}. ${usage}`,
		};
	}

	return {
		inPlace: optionArgs.includes("--in-place") || optionArgs.includes("-i"),
		filePath: allPositionals[0],
		error: null,
	};
}

export async function formatSubcommand(args: string[]): Promise<void> {
	const parsed = parseArgs(args);
	if (parsed.error) {
		throw new Error(parsed.error);
	}

	if (parsed.inPlace && !parsed.filePath) {
		throw new Error("--in-place cannot be used with stdin input");
	}

	const input = await readBpmnInput(parsed.filePath);
	if (!input) {
		throw new Error(
			"No BPMN input provided. Pass a file path or pipe BPMN XML via stdin.",
		);
	}

	const moddle = await createBpmnModdle();
	let resultXml: string;
	try {
		const parsedXml = await moddle.fromXML(input.xml);
		const rendered = await moddle.toXML(parsedXml.rootElement, {
			format: true,
		});
		resultXml = rendered.xml;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to parse BPMN: ${message}`);
	}

	if (parsed.inPlace) {
		writeFileSync(input.source, resultXml, "utf-8");
		return;
	}

	process.stdout.write(resultXml);
}
