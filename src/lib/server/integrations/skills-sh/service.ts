import { env } from '$env/dynamic/private';

const SKILLS_SH_BASE_URL = 'https://skills.sh';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_FILES = 100;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class SkillsShError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SkillsShError';
	}
}

type SkillsShSearchResult = {
	id: string;
	slug: string;
	name: string;
	source: string;
	installs: number;
	sourceType?: string;
	installUrl?: string | null;
	url?: string | null;
	isDuplicate?: boolean;
};

export type SkillsShSearchResponse = {
	query: string;
	results: SkillsShSearchResult[];
	count: number;
	searchType?: string;
};

export type SkillsShDownloadedSkill = {
	id: string;
	name: string;
	description: string;
	body: string;
	files: Array<{ path: string; content: string }>;
	source: string;
	slug: string;
	hash: string | null;
	installs?: number;
	sourceType?: string | null;
	installUrl?: string | null;
	url?: string | null;
};

type SearchInput = {
	query: string;
	limit?: number;
	token?: string;
};

type DownloadInput = {
	id: string;
	token?: string;
};

type DownloadedFile = {
	path?: unknown;
	contents?: unknown;
};

function authToken(inputToken?: string): string | undefined {
	return inputToken || env.SKILLS_SH_API_TOKEN || env.VERCEL_OIDC_TOKEN || undefined;
}

function normalizedLimit(limit: number | undefined): number {
	if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_LIMIT;
	return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(limit)));
}

function pathForSkillId(id: string): string {
	return id
		.split('/')
		.map((segment) => encodeURIComponent(segment))
		.join('/');
}

function splitSkillId(id: string): { source: string; slug: string } {
	const parts = id.split('/').filter(Boolean);
	if (parts.length < 2) {
		throw new SkillsShError('Invalid skills.sh skill id');
	}
	return {
		source: parts.slice(0, -1).join('/'),
		slug: parts[parts.length - 1]
	};
}

async function readJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		throw new SkillsShError('skills.sh returned invalid JSON');
	}
}

async function fetchJson(url: string, token: string | undefined, fetchImpl: FetchLike) {
	const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
	const response = await fetchImpl(url, { headers });
	if (!response.ok) {
		return { ok: false as const, status: response.status, body: await readJson(response) };
	}
	return { ok: true as const, status: response.status, body: await readJson(response) };
}

function asRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
	return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function optionalNullableString(value: unknown): string | null {
	return typeof value === 'string' ? value : null;
}

function optionalNumber(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function normalizeSearchResult(item: Record<string, unknown>): SkillsShSearchResult | null {
	const source = optionalString(item.source);
	const slug = optionalString(item.slug) ?? optionalString(item.skillId);
	const id = optionalString(item.id) ?? (source && slug ? `${source}/${slug}` : undefined);
	const name = optionalString(item.name) ?? slug;
	if (!id || !source || !slug || !name) return null;
	return {
		id,
		slug,
		name,
		source,
		installs: optionalNumber(item.installs),
		sourceType: optionalString(item.sourceType),
		installUrl: optionalNullableString(item.installUrl),
		url: optionalNullableString(item.url),
		isDuplicate: item.isDuplicate === true
	};
}

function normalizeSearchResponse(body: unknown, query: string): SkillsShSearchResponse {
	const record = asRecord(body);
	const rawResults = Array.isArray(record.data)
		? record.data
		: Array.isArray(record.skills)
			? record.skills
			: [];
	const results = rawResults
		.map((item) => normalizeSearchResult(asRecord(item)))
		.filter((item): item is SkillsShSearchResult => item !== null);
	return {
		query: optionalString(record.query) ?? query,
		searchType: optionalString(record.searchType),
		count: typeof record.count === 'number' ? record.count : results.length,
		results
	};
}

function assertOk(result: Awaited<ReturnType<typeof fetchJson>>): asserts result is {
	ok: true;
	status: number;
	body: unknown;
} {
	if (result.ok) return;
	const record = asRecord(result.body);
	const message =
		optionalString(record.message) ?? `skills.sh request failed with ${result.status}`;
	throw new SkillsShError(message);
}

export async function searchSkillsShCatalog(
	input: SearchInput,
	fetchImpl: FetchLike = fetch
): Promise<SkillsShSearchResponse> {
	const query = input.query.trim();
	if (query.length < 2) return { query, results: [], count: 0 };

	const limit = normalizedLimit(input.limit);
	const token = authToken(input.token);
	const search = new URL(`${SKILLS_SH_BASE_URL}/api/v1/skills/search`);
	search.searchParams.set('q', query);
	search.searchParams.set('limit', String(limit));

	if (token) {
		const official = await fetchJson(search.toString(), token, fetchImpl);
		if (official.ok) return normalizeSearchResponse(official.body, query);
		if (official.status !== 401) assertOk(official);
	}

	const legacy = new URL(`${SKILLS_SH_BASE_URL}/api/search`);
	legacy.searchParams.set('q', query);
	legacy.searchParams.set('limit', String(limit));
	const result = await fetchJson(legacy.toString(), undefined, fetchImpl);
	assertOk(result);
	return normalizeSearchResponse(result.body, query);
}

function parseFrontmatterValue(value: string): string {
	const trimmed = value.trim();
	if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
		try {
			return JSON.parse(trimmed) as string;
		} catch {
			return trimmed.slice(1, -1);
		}
	}
	if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
	return trimmed;
}

function frontmatterValue(markdown: string, key: string): string | undefined {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
	if (!match) return undefined;
	for (const line of match[1].split(/\r?\n/)) {
		const separator = line.indexOf(':');
		if (separator === -1) continue;
		if (line.slice(0, separator).trim() === key) {
			return parseFrontmatterValue(line.slice(separator + 1));
		}
	}
	return undefined;
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, 'utf8');
}

function assertSafeSkillFilePath(path: string): void {
	if (
		path.length === 0 ||
		path.length > 240 ||
		path.startsWith('/') ||
		path.includes('\\') ||
		path.includes('\0')
	) {
		throw new SkillsShError(`Unsafe skill file path: ${path}`);
	}
	const segments = path.split('/');
	if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
		throw new SkillsShError(`Unsafe skill file path: ${path}`);
	}
}

function normalizeDownloadedFiles(rawFiles: unknown): {
	body: string;
	files: Array<{ path: string; content: string }>;
} {
	if (!Array.isArray(rawFiles)) {
		throw new SkillsShError('Downloaded skill must include files');
	}
	if (rawFiles.length > MAX_FILES) {
		throw new SkillsShError(`Downloaded skill has too many files; max is ${MAX_FILES}`);
	}

	let body: string | undefined;
	let totalBytes = 0;
	const files: Array<{ path: string; content: string }> = [];

	for (const rawFile of rawFiles) {
		const file = asRecord(rawFile) as DownloadedFile;
		if (typeof file.path !== 'string' || typeof file.contents !== 'string') {
			throw new SkillsShError('Downloaded skill files must include path and contents');
		}
		assertSafeSkillFilePath(file.path);
		const size = byteLength(file.contents);
		if (size > MAX_FILE_BYTES) {
			throw new SkillsShError(`Downloaded skill file is too large: ${file.path}`);
		}
		totalBytes += size;
		if (totalBytes > MAX_TOTAL_BYTES) {
			throw new SkillsShError(`Downloaded skill is too large; max is ${MAX_TOTAL_BYTES} bytes`);
		}
		if (file.path === 'SKILL.md') {
			if (body !== undefined)
				throw new SkillsShError('Downloaded skill has multiple SKILL.md files');
			body = file.contents;
		} else {
			files.push({ path: file.path, content: file.contents });
		}
	}

	if (body === undefined) throw new SkillsShError('Downloaded skill must include SKILL.md');
	return { body, files };
}

function normalizeDownloadedSkill(body: unknown, id: string): SkillsShDownloadedSkill {
	const record = asRecord(body);
	const split = splitSkillId(id);
	const skillId = optionalString(record.id) ?? id;
	const source = optionalString(record.source) ?? split.source;
	const slug = optionalString(record.slug) ?? split.slug;
	const files = normalizeDownloadedFiles(record.files);
	return {
		id: skillId,
		name: slug,
		description: frontmatterValue(files.body, 'description') ?? `Imported skill ${slug}`,
		body: files.body,
		files: files.files,
		source,
		slug,
		hash: optionalNullableString(record.hash),
		installs: typeof record.installs === 'number' ? record.installs : undefined,
		sourceType: optionalNullableString(record.sourceType),
		installUrl: optionalNullableString(record.installUrl),
		url: optionalNullableString(record.url)
	};
}

export async function downloadSkillsShSkill(
	input: DownloadInput,
	fetchImpl: FetchLike = fetch
): Promise<SkillsShDownloadedSkill> {
	const id = input.id.trim();
	const token = authToken(input.token);
	const path = pathForSkillId(id);

	if (token) {
		const official = await fetchJson(
			`${SKILLS_SH_BASE_URL}/api/v1/skills/${path}`,
			token,
			fetchImpl
		);
		if (official.ok) return normalizeDownloadedSkill(official.body, id);
		if (official.status !== 401) assertOk(official);
	}

	const legacy = await fetchJson(
		`${SKILLS_SH_BASE_URL}/api/download/${path}`,
		undefined,
		fetchImpl
	);
	assertOk(legacy);
	return normalizeDownloadedSkill(legacy.body, id);
}
