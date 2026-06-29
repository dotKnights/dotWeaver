import { gitOk } from '$lib/server/runtime/git';
import { env as privateEnv } from '$env/dynamic/private';

export interface NumstatEntry {
	path: string;
	additions: number | null;
	deletions: number | null;
}
export interface NameStatusEntry {
	path: string;
	status: string;
}
export interface DiffFile {
	path: string;
	status: string;
	additions: number | null;
	deletions: number | null;
}

export function parseNumstat(output: string): NumstatEntry[] {
	return output
		.split('\n')
		.filter((l) => l.trim() !== '')
		.map((line) => {
			const [add, del, ...rest] = line.split('\t');
			return {
				path: rest.join('\t'),
				additions: add === '-' ? null : Number(add),
				deletions: del === '-' ? null : Number(del)
			};
		});
}

export function parseNameStatus(output: string): NameStatusEntry[] {
	return output
		.split('\n')
		.filter((l) => l.trim() !== '')
		.map((line) => {
			const parts = line.split('\t');
			return { path: parts[parts.length - 1], status: parts[0][0] };
		});
}

export function mergeDiffFiles(num: NumstatEntry[], names: NameStatusEntry[]): DiffFile[] {
	const counts = new Map(num.map((n) => [n.path, n]));
	return names.map((n) => ({
		path: n.path,
		status: n.status,
		additions: counts.get(n.path)?.additions ?? null,
		deletions: counts.get(n.path)?.deletions ?? null
	}));
}

export interface RunDiff {
	files: DiffFile[];
	patch: string;
	truncated: boolean;
}

const MAX_PATCH = 200_000;
const SAFE_DIFF_FLAGS = ['--no-ext-diff', '--no-textconv'];

/** Calcule le diff base..head depuis un checkout (côté hôte). */
export async function computeDiff(
	checkoutPath: string,
	baseSha: string,
	headSha: string,
	env: Record<string, string | undefined> = privateEnv
): Promise<RunDiff> {
	const range = `${baseSha}..${headSha}`;
	const [numstat, nameStatus, rawPatch] = await Promise.all([
		gitOk(['diff', ...SAFE_DIFF_FLAGS, '--numstat', range], { cwd: checkoutPath, env }),
		gitOk(['diff', ...SAFE_DIFF_FLAGS, '--name-status', range], { cwd: checkoutPath, env }),
		gitOk(['diff', ...SAFE_DIFF_FLAGS, range], { cwd: checkoutPath, env })
	]);
	const files = mergeDiffFiles(parseNumstat(numstat), parseNameStatus(nameStatus));
	const truncated = rawPatch.length > MAX_PATCH;
	return { files, patch: truncated ? rawPatch.slice(0, MAX_PATCH) : rawPatch, truncated };
}
