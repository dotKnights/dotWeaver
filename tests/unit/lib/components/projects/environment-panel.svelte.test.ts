import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import EnvironmentEditor from '$lib/components/projects/EnvironmentEditor.svelte';
import EnvironmentPanel from '$lib/components/projects/EnvironmentPanel.svelte';

function readyEnvironment(overrides: Record<string, unknown> = {}) {
	return {
		id: 'env1',
		runtime: 'node',
		packageManager: 'bun',
		status: 'ready',
		currentFingerprint: 'fp1',
		lastPreparedFingerprint: 'fp1',
		lastPrepareStatus: 'succeeded',
		installCommand: 'bun install',
		testCommand: 'bun run test',
		buildCommand: '',
		devCommand: '',
		warnings: [],
		...overrides
	};
}

function deferred<T = unknown>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe('EnvironmentPanel', () => {
	it('renders an unconfigured state with detect action', async () => {
		const onDetect = vi.fn().mockResolvedValue({});
		const screen = render(EnvironmentPanel, {
			projectId: 'p1',
			environment: null,
			onDetect,
			onSave: vi.fn(),
			onPrepare: vi.fn(),
			prepareEvents: []
		});

		await expect.element(screen.getByText('Environment')).toBeInTheDocument();
		await expect.element(screen.getByText('Not configured')).toBeInTheDocument();
		await screen.getByRole('button', { name: /detect/i }).click();

		expect(onDetect).toHaveBeenCalledWith({ projectId: 'p1' });
	});

	it('renders a ready Node environment', async () => {
		const screen = render(EnvironmentPanel, {
			projectId: 'p1',
			environment: readyEnvironment(),
			onDetect: vi.fn(),
			onSave: vi.fn(),
			onPrepare: vi.fn(),
			prepareEvents: []
		});

		await expect.element(screen.getByText('node')).toBeInTheDocument();
		await expect.element(screen.getByText('bun')).toBeInTheDocument();
		await expect.element(screen.getByRole('button', { name: /prepare/i })).toBeInTheDocument();
	});

	it('shows prepared state when the current fingerprint has been prepared', async () => {
		const screen = render(EnvironmentPanel, {
			projectId: 'p1',
			environment: readyEnvironment({
				currentFingerprint: 'fp1',
				lastPreparedFingerprint: 'fp1',
				lastPrepareStatus: 'succeeded'
			}),
			onDetect: vi.fn(),
			onSave: vi.fn(),
			onPrepare: vi.fn(),
			prepareEvents: []
		});

		await expect.element(screen.getByText('Prepared')).toBeInTheDocument();
		await expect.element(screen.getByText('Needs prepare')).not.toBeInTheDocument();
	});

	it('keeps needs prepare visible when the prepared fingerprint is stale', async () => {
		const screen = render(EnvironmentPanel, {
			projectId: 'p1',
			environment: readyEnvironment({
				currentFingerprint: 'fp2',
				lastPreparedFingerprint: 'fp1',
				lastPrepareStatus: 'succeeded'
			}),
			onDetect: vi.fn(),
			onSave: vi.fn(),
			onPrepare: vi.fn(),
			prepareEvents: []
		});

		await expect.element(screen.getByText('Needs prepare')).toBeInTheDocument();
		await expect.element(screen.getByText('Prepared')).not.toBeInTheDocument();
	});

	it('shows prepare-needed state, events, and keeps prepare queued after enqueue', async () => {
		const prepare = deferred();
		const onPrepare = vi.fn(() => prepare.promise);
		const screen = render(EnvironmentPanel, {
			projectId: 'p1',
			environment: readyEnvironment({
				currentFingerprint: 'fp2',
				lastPreparedFingerprint: 'fp1',
				lastPrepareStatus: 'succeeded'
			}),
			onDetect: vi.fn(),
			onSave: vi.fn(),
			onPrepare,
			prepareEvents: [
				{
					id: 'event1',
					seq: 1,
					type: 'system',
					payload: { message: 'Installing dependencies' }
				}
			]
		});

		await expect.element(screen.getByText('Needs prepare')).toBeInTheDocument();
		await expect.element(screen.getByText('Installing dependencies')).toBeInTheDocument();

		await screen.getByRole('button', { name: /prepare/i }).click();
		expect(onPrepare).toHaveBeenCalledWith({ projectId: 'p1', profileId: 'env1', force: false });
		await expect.element(screen.getByRole('button', { name: /preparing/i })).toBeInTheDocument();

		prepare.resolve({});
		await expect.element(screen.getByRole('button', { name: /queued/i })).toBeInTheDocument();
	});

	it('saves sensible default commands for a new Node/Bun environment', async () => {
		const onSave = vi.fn().mockResolvedValue({});
		const screen = render(EnvironmentPanel, {
			projectId: 'p1',
			environment: null,
			onDetect: vi.fn(),
			onSave,
			onPrepare: vi.fn(),
			prepareEvents: []
		});

		await screen.getByRole('button', { name: /configure/i }).click();
		await screen.getByRole('button', { name: /save/i }).click();

		expect(onSave).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: 'p1',
				runtime: 'node',
				packageManager: 'bun',
				installCommand: 'bun install',
				testCommand: 'bun run test',
				buildCommand: 'bun run build',
				devCommand: 'bun run dev'
			})
		);
	});
});

describe('EnvironmentEditor', () => {
	it('resets local command edits when the project environment changes', async () => {
		const screen = render(EnvironmentEditor, {
			projectId: 'p1',
			environment: readyEnvironment({ id: 'env1', installCommand: 'bun install' }),
			onSave: vi.fn()
		});

		await screen.getByLabelText('Install command').fill('custom install');
		await screen.rerender({
			projectId: 'p2',
			environment: readyEnvironment({
				id: 'env2',
				installCommand: 'pnpm install',
				packageManager: 'pnpm'
			}),
			onSave: vi.fn()
		});

		await expect.element(screen.getByLabelText('Install command')).toHaveValue('pnpm install');
	});
});
