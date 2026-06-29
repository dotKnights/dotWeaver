import { customAdapter } from '$lib/server/project-environments/adapters/custom';
import { nodeAdapter } from '$lib/server/project-environments/adapters/node';
import { pythonAdapter } from '$lib/server/project-environments/adapters/python';
import type {
	DetectionInput,
	DetectionResult,
	RuntimeAdapter
} from '$lib/server/project-environments/types';

const runtimeAdapters: RuntimeAdapter[] = [nodeAdapter, pythonAdapter, customAdapter];

export function getRuntimeAdapter(id: string): RuntimeAdapter | null {
	return runtimeAdapters.find((adapter) => adapter.id === id) ?? null;
}

export function detectProjectEnvironment(input: DetectionInput): DetectionResult {
	const detected = runtimeAdapters
		.map((adapter) => adapter.detect(input))
		.filter((result): result is DetectionResult => result !== null)
		.sort((a, b) => b.confidence - a.confidence);
	return detected[0] ?? customAdapter.detect(input)!;
}
