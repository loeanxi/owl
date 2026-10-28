import type { AskSpec } from "./types.js";

/**
 * Typed-ask result validation (ZCode's submit seam, adapted): the child answers
 * in prose, we extract the JSON object and check it against the schema built
 * from the script's T. Violations go back to the same agent session as a
 * repair round (budget ASK_REPAIR_BUDGET).
 */

export function extractJson(text: string): unknown | undefined {
	const trimmed = text.trim();
	const candidates: string[] = [trimmed];
	const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
	if (fenced) candidates.push(fenced[1].trim());
	const firstObject = indexOfAny(trimmed, "{", "}");
	if (firstObject !== undefined) candidates.push(firstObject);
	const firstArray = indexOfAny(trimmed, "[", "]");
	if (firstArray !== undefined) candidates.push(firstArray);
	for (const candidate of candidates) {
		try {
			return JSON.parse(candidate);
		} catch {
			// next candidate
		}
	}
	return undefined;
}

function indexOfAny(text: string, open: string, close: string): string | undefined {
	const start = text.indexOf(open);
	const end = text.lastIndexOf(close);
	if (start < 0 || end <= start) return undefined;
	return text.slice(start, end + 1);
}

interface SchemaProperty {
	type?: string;
	description?: string;
	enum?: string[];
	items?: SchemaProperty;
	properties?: Record<string, SchemaProperty>;
	required?: string[];
}

/** Returns one violation per broken expectation; empty means the value conforms. */
export function validateAgainstSchema(schema: unknown, value: unknown): string[] {
	return validateNode(schema as SchemaProperty, value, "$");
}

function validateNode(schema: SchemaProperty | undefined, value: unknown, path: string): string[] {
	if (!schema || typeof schema !== "object") return [];
	switch (schema.type) {
		case "string": {
			if (typeof value !== "string") return [`${path}: expected string, got ${typeName(value)}`];
			if (schema.enum && !schema.enum.includes(value))
				return [`${path}: "${value}" is not one of ${JSON.stringify(schema.enum)}`];
			return [];
		}
		case "number": {
			if (typeof value !== "number" || !Number.isFinite(value))
				return [`${path}: expected number, got ${typeName(value)}`];
			return [];
		}
		case "boolean": {
			if (typeof value !== "boolean") return [`${path}: expected boolean, got ${typeName(value)}`];
			return [];
		}
		case "array": {
			if (!Array.isArray(value)) return [`${path}: expected array, got ${typeName(value)}`];
			const out: string[] = [];
			for (const [index, item] of value.entries()) {
				out.push(...validateNode(schema.items, item, `${path}[${index}]`));
			}
			return out;
		}
		case "object": {
			if (value === null || typeof value !== "object" || Array.isArray(value)) {
				return [`${path}: expected object, got ${typeName(value)}`];
			}
			const out: string[] = [];
			const record = value as Record<string, unknown>;
			for (const [name, propSchema] of Object.entries(schema.properties ?? {})) {
				if (!(name in record)) {
					out.push(`${path}.${name}: missing required property`);
					continue;
				}
				out.push(...validateNode(propSchema, record[name], `${path}.${name}`));
			}
			return out;
		}
		default:
			return [];
	}
}

function typeName(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

/** The instruction block appended to a typed ask (the contract the child reads). */
export function contractFor(spec: AskSpec): string | undefined {
	if (!spec.typed || !spec.contract) return undefined;
	return spec.contract;
}
