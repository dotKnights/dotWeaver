import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type {
	GeneratedEnvFileEntry,
	RuntimeAgentConfig
} from '$lib/server/project-agent-config/runtime-types';
import {
	assertSafeName,
	assertSafeSkillFilePath
} from '$lib/server/project-agent-config/validation';
import { mergeDotenv } from '$lib/server/runtime/dotenv';
import { git, gitOk } from '$lib/server/runtime/git';

function placeholderForEnvName(envName: string): string {
	return `\${${envName}}`;
}

function asOptionalRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
	return value as Record<string, unknown>;
}

function replaceSecretValues(value: unknown, secretEnv: Record<string, string>): unknown {
	if (typeof value === 'string') {
		let scrubbed = value;
		for (const [envName, secretValue] of Object.entries(secretEnv)) {
			if (secretValue.length > 0) {
				scrubbed = scrubbed.split(secretValue).join(placeholderForEnvName(envName));
			}
		}
		return scrubbed;
	}
	if (Array.isArray(value)) {
		return value.map((item) => replaceSecretValues(item, secretEnv));
	}
	const record = asOptionalRecord(value);
	if (Object.keys(record).length > 0) {
		return Object.fromEntries(
			Object.entries(record).map(([key, item]) => [key, replaceSecretValues(item, secretEnv)])
		);
	}
	return value;
}

function scrubMcpJsonSecrets(
	config: RuntimeAgentConfig['mcpJson'],
	secretEnv: RuntimeAgentConfig['secretEnv']
): RuntimeAgentConfig['mcpJson'] {
	return replaceSecretValues(config, secretEnv) as RuntimeAgentConfig['mcpJson'];
}

export async function materializeProjectEnvFile(
	checkoutPath: string,
	envFile: RuntimeAgentConfig['envFile'],
	generatedPaths: string[] = [],
	generatedEnvFile: GeneratedEnvFileEntry[] = []
): Promise<void> {
	const entries = [...generatedEnvFile, ...envFile];
	if (entries.length === 0) return;
	const envPath = join(checkoutPath, '.env');
	let existing = '';
	try {
		existing = await readFile(envPath, 'utf8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
	}
	await writeFile(envPath, mergeDotenv(existing, entries));
	generatedPaths.push('.env');
	await protectGeneratedAgentConfigFiles(checkoutPath, generatedPaths);
}

export async function materializeRunAgentConfig(
	checkoutPath: string,
	config: RuntimeAgentConfig
): Promise<void> {
	const claudeDir = join(checkoutPath, '.claude');
	const codexSkillsDir = join(checkoutPath, '.agents', 'skills');
	const generatedPaths = ['.mcp.json', '.claude/settings.json', '.dotweaver/'];
	await mkdir(claudeDir, { recursive: true });
	await writeFile(
		join(checkoutPath, '.mcp.json'),
		`${JSON.stringify(scrubMcpJsonSecrets(config.mcpJson, config.secretEnv), null, 2)}\n`
	);
	await writeFile(
		join(claudeDir, 'settings.json'),
		`${JSON.stringify(config.settings, null, 2)}\n`
	);

	for (const skill of config.skills) {
		assertSafeName(skill.name);
		generatedPaths.push(`.claude/skills/${skill.name}/SKILL.md`);
		generatedPaths.push(`.agents/skills/${skill.name}/SKILL.md`);
		const skillDir = join(claudeDir, 'skills', skill.name);
		const codexSkillDir = join(codexSkillsDir, skill.name);
		await mkdir(skillDir, { recursive: true });
		await mkdir(codexSkillDir, { recursive: true });
		await writeFile(
			join(skillDir, 'SKILL.md'),
			skill.body.endsWith('\n') ? skill.body : `${skill.body}\n`
		);
		await writeFile(
			join(codexSkillDir, 'SKILL.md'),
			skill.body.endsWith('\n') ? skill.body : `${skill.body}\n`
		);
		for (const file of skill.files ?? []) {
			assertSafeSkillFilePath(file.path);
			generatedPaths.push(`.claude/skills/${skill.name}/${file.path}`);
			generatedPaths.push(`.agents/skills/${skill.name}/${file.path}`);
			const filePath = join(skillDir, file.path);
			const codexFilePath = join(codexSkillDir, file.path);
			await mkdir(dirname(filePath), { recursive: true });
			await mkdir(dirname(codexFilePath), { recursive: true });
			await writeFile(filePath, file.content);
			await writeFile(codexFilePath, file.content);
		}
	}

	if (config.envFile.length > 0) {
		await materializeProjectEnvFile(checkoutPath, config.envFile, generatedPaths);
	}

	await protectGeneratedAgentConfigFiles(checkoutPath, generatedPaths);
}

async function protectGeneratedAgentConfigFiles(
	checkoutPath: string,
	relativePaths: string[]
): Promise<void> {
	const gitWorkTree = await git(['rev-parse', '--is-inside-work-tree'], {
		cwd: checkoutPath,
		env: process.env
	});
	if (gitWorkTree.code !== 0 || gitWorkTree.stdout.trim() !== 'true') return;

	const gitExclude = await gitOk(['rev-parse', '--git-path', 'info/exclude'], {
		cwd: checkoutPath,
		env: process.env
	});
	const gitExcludePath = isAbsolute(gitExclude) ? gitExclude : join(checkoutPath, gitExclude);

	const uniquePaths = [...new Set(relativePaths)];
	await mkdir(dirname(gitExcludePath), { recursive: true });
	let existingExclude = '';
	try {
		existingExclude = await readFile(gitExcludePath, 'utf8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
	}
	const existingLines = new Set(existingExclude.split(/\r?\n/));
	const missingPaths = uniquePaths.filter((relativePath) => !existingLines.has(relativePath));
	if (missingPaths.length > 0) {
		await appendFile(
			gitExcludePath,
			`\n# dotWeaver generated agent config\n${missingPaths.join('\n')}\n`
		);
	}

	const trackedPaths: string[] = [];
	for (const relativePath of uniquePaths) {
		const result = await git(['ls-files', '--error-unmatch', '--', relativePath], {
			cwd: checkoutPath,
			env: process.env
		});
		if (result.code === 0) trackedPaths.push(relativePath);
	}

	if (trackedPaths.length > 0) {
		await gitOk(['update-index', '--skip-worktree', '--', ...trackedPaths], {
			cwd: checkoutPath,
			env: process.env
		});
	}
}
