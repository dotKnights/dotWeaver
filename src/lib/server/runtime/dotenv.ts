export interface DotenvEntry {
	key: string;
	value: string;
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function unquote(raw: string): string {
	const v = raw.trim();
	if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
		return v.slice(1, -1).replace(/\\(["\\])/g, '$1');
	}
	if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
		return v.slice(1, -1);
	}
	return v;
}

/** Parse `.env` text into entries. Invalid keys, blank lines and `#` comments are dropped. */
export function parseDotenv(text: string): DotenvEntry[] {
	const entries: DotenvEntry[] = [];
	for (const rawLine of text.split('\n')) {
		const line = rawLine.trim();
		if (line.length === 0 || line.startsWith('#')) continue;
		const withoutExport = line.startsWith('export ') ? line.slice('export '.length) : line;
		const eq = withoutExport.indexOf('=');
		if (eq === -1) continue;
		const key = withoutExport.slice(0, eq).trim();
		if (!KEY_RE.test(key)) continue;
		entries.push({ key, value: unquote(withoutExport.slice(eq + 1)) });
	}
	return entries;
}

function serializeValue(value: string): string {
	if (!/[\s#"']/.test(value)) return value;
	return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Merge managed entries into existing `.env` text. Existing keys outside the
 * managed block are treated as manual and preserved; keys inside the managed
 * block are refreshed; missing keys are appended under a managed block.
 * Comments and unmanaged lines are preserved. Always returns text ending in `\n`.
 */
export function mergeDotenv(existing: string, managed: DotenvEntry[]): string {
	const byKey = new Map(managed.map((entry) => [entry.key, entry.value]));
	const seen = new Set<string>();
	const manualKeys = new Set<string>();
	const lines = existing.length === 0 ? [] : existing.replace(/\n+$/, '').split('\n');
	let inManagedBlock = false;
	const out: string[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed === '# dotWeaver managed') {
			inManagedBlock = true;
			out.push(line);
			continue;
		}
		if (trimmed.length === 0 || trimmed.startsWith('#')) {
			out.push(line);
			continue;
		}
		const body = trimmed.startsWith('export ') ? trimmed.slice('export '.length) : trimmed;
		const eq = body.indexOf('=');
		if (eq === -1) {
			out.push(line);
			continue;
		}
		const key = body.slice(0, eq).trim();
		if (!byKey.has(key)) {
			out.push(line);
			continue;
		}
		seen.add(key);
		if (!inManagedBlock) {
			manualKeys.add(key);
			out.push(line);
			continue;
		}
		if (manualKeys.has(key)) continue;
		out.push(`${key}=${serializeValue(byKey.get(key)!)}`);
	}

	const appended = [...byKey.entries()]
		.filter(([key]) => !seen.has(key))
		.map(([key, value]) => ({ key, value }));
	if (appended.length > 0) {
		out.push('', '# dotWeaver managed');
		for (const entry of appended) out.push(`${entry.key}=${serializeValue(entry.value)}`);
	}
	return `${out.join('\n')}\n`;
}
