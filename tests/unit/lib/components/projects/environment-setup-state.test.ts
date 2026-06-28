import { describe, expect, it } from 'vitest';
import {
	computeEnvironmentServicesSetupState,
	computeEnvironmentSetupState,
	eventLabel,
	isPreparedEnvironment,
	mergePrepareEvents,
	type EnvironmentProfile,
	type EnvironmentServiceSummary,
	type PrepareEvent
} from '$lib/components/projects/environment-setup-state';

function invalidServiceSummary(service: Record<string, unknown>): EnvironmentServiceSummary {
	return service as unknown as EnvironmentServiceSummary;
}

function env(overrides: Partial<EnvironmentProfile> = {}): EnvironmentProfile {
	return {
		id: 'env1',
		status: 'ready',
		runtime: 'node',
		packageManager: 'bun',
		installCommand: 'bun install',
		currentFingerprint: 'fp1',
		lastPreparedFingerprint: 'fp1',
		lastPrepareStatus: 'succeeded',
		lastPrepareError: null,
		warnings: [],
		...overrides
	};
}

describe('environment setup state', () => {
	it('marks a current ready profile as prepared', () => {
		expect(isPreparedEnvironment(env())).toBe(true);
		expect(computeEnvironmentSetupState(env()).prepare.status).toBe('ready');
		expect(computeEnvironmentSetupState(env()).primaryAction).toBe('open_project');
	});

	it('does not mark detected profiles as prepared even with matching fingerprints', () => {
		const state = computeEnvironmentSetupState(env({ status: 'detected' }));
		expect(isPreparedEnvironment(env({ status: 'detected' }))).toBe(false);
		expect(state.prepare.status).toBe('todo');
		expect(state.primaryAction).toBe('prepare');
	});

	it('makes prepare optional when no install command is configured', () => {
		const state = computeEnvironmentSetupState(
			env({
				status: 'detected',
				installCommand: '',
				lastPrepareStatus: 'never',
				lastPreparedFingerprint: null
			})
		);
		expect(state.prepare.status).toBe('optional');
		expect(state.primaryAction).toBe('open_project');
		expect(state.canOpenProject).toBe(true);
	});

	it('blocks opening when services still need provisioning', () => {
		const services: EnvironmentServiceSummary[] = [
			{ id: 'svc1', enabled: true, status: 'configured' }
		];
		const state = computeEnvironmentSetupState(env(), services);

		expect(state.services.status).toBe('todo');
		expect(state.services.label).toBe('Provision services before opening');
		expect(state.canOpenProject).toBe(false);
		expect(state.primaryAction).toBe('prepare');
	});

	it('keeps project opening available when prepared services are ready', () => {
		const services: EnvironmentServiceSummary[] = [{ id: 'svc1', enabled: true, status: 'ready' }];
		const state = computeEnvironmentSetupState(env(), services);

		expect(state.services.status).toBe('ready');
		expect(state.canOpenProject).toBe(true);
		expect(state.primaryAction).toBe('open_project');
	});

	it('computes setup state for services', () => {
		expect(computeEnvironmentServicesSetupState([])).toEqual({
			status: 'ready',
			label: 'No services configured',
			canOpenProject: true
		});
		expect(
			computeEnvironmentServicesSetupState([{ id: 'svc1', enabled: true, status: 'provisioning' }])
		).toMatchObject({ status: 'running', canOpenProject: false });
		expect(
			computeEnvironmentServicesSetupState([{ id: 'svc1', enabled: true, status: 'failed' }])
		).toMatchObject({ status: 'failed', canOpenProject: false });
		expect(
			computeEnvironmentServicesSetupState([{ id: 'svc1', enabled: false, status: 'disabled' }])
		).toMatchObject({ status: 'warning', canOpenProject: true });
		expect(
			computeEnvironmentServicesSetupState([
				invalidServiceSummary({ id: 'svc1', enabled: true, status: 'unknown' })
			])
		).toMatchObject({
			status: 'warning',
			label: 'Some services need attention',
			canOpenProject: false
		});
		expect(computeEnvironmentServicesSetupState([], { loading: true })).toMatchObject({
			status: 'running',
			label: 'Loading services',
			canOpenProject: false
		});
		expect(
			computeEnvironmentServicesSetupState([], { error: 'Could not load services' })
		).toMatchObject({
			status: 'failed',
			label: 'Could not load services',
			canOpenProject: false
		});
		expect(
			computeEnvironmentServicesSetupState([
				invalidServiceSummary({ id: 'svc1', enabled: true, status: 'unknown' }),
				{ id: 'svc2', enabled: false, status: 'disabled' }
			])
		).toMatchObject({
			status: 'warning',
			label: 'Some services need attention',
			canOpenProject: false
		});
	});

	it('blocks opening when active service env mappings are invalid', () => {
		const services: EnvironmentServiceSummary[] = [
			{
				id: 'svc1',
				enabled: true,
				status: 'ready',
				mappingErrors: ['Mapping DATABASE_URL references missing source field url']
			}
		];
		const state = computeEnvironmentSetupState(env(), services);

		expect(state.services.status).toBe('failed');
		expect(state.services.label).toBe('Service environment mappings need fixes');
		expect(state.canOpenProject).toBe(false);
		expect(state.primaryAction).toBe('prepare');
	});

	it('surfaces service env mapping warnings without blocking opening', () => {
		const services: EnvironmentServiceSummary[] = [
			{
				id: 'svc1',
				enabled: true,
				status: 'ready',
				mappingWarnings: ['Generated env DATABASE_URL is overridden']
			}
		];
		const state = computeEnvironmentSetupState(env(), services);

		expect(state.services.status).toBe('warning');
		expect(state.services.label).toBe('Service environment mappings have warnings');
		expect(state.canOpenProject).toBe(true);
		expect(state.primaryAction).toBe('open_project');
	});

	it('blocks invalid profiles even when no install command is configured', () => {
		const state = computeEnvironmentSetupState(
			env({
				status: 'invalid',
				installCommand: '',
				lastPrepareStatus: 'never',
				lastPreparedFingerprint: null
			})
		);
		expect(state.runtime.status).toBe('failed');
		expect(state.prepare.status).toBe('failed');
		expect(state.prepare.label).toBe('Environment profile is invalid');
		expect(state.primaryAction).not.toBe('open_project');
		expect(state.canOpenProject).toBe(false);
	});

	it('asks for detection when no profile exists', () => {
		const state = computeEnvironmentSetupState(null);
		expect(state.runtime.status).toBe('todo');
		expect(state.primaryAction).toBe('detect');
		expect(state.canOpenProject).toBe(false);
	});

	it('reports stale and failed prepare states', () => {
		expect(
			computeEnvironmentSetupState(
				env({ currentFingerprint: 'fp2', lastPreparedFingerprint: 'fp1' })
			).prepare.status
		).toBe('stale');
		expect(computeEnvironmentSetupState(env({ lastPrepareStatus: 'failed' })).prepare.status).toBe(
			'failed'
		);
	});

	it('extracts readable prepare event labels', () => {
		expect(eventLabel({ type: 'output', payload: { text: 'bun install' } })).toBe('bun install');
		expect(eventLabel({ type: 'error', payload: { message: 'failed' } })).toBe('failed');
		expect(eventLabel({ type: 'system', payload: 'plain text' })).toBe('plain text');
	});

	it('merges initial and live prepare events by seq', () => {
		const initial: PrepareEvent[] = [
			{ id: 'a', seq: 1, type: 'system', payload: { text: 'old' } },
			{ id: 'b', seq: 2, type: 'output', payload: { text: 'initial' } }
		];
		const live: PrepareEvent[] = [
			{ id: 'b-live', seq: 2, type: 'output', payload: { text: 'live replacement' } },
			{ id: 'c', seq: 3, type: 'result', payload: { status: 'succeeded' } }
		];

		expect(mergePrepareEvents(initial, live).map((event) => event.payload)).toEqual([
			{ text: 'old' },
			{ text: 'live replacement' },
			{ status: 'succeeded' }
		]);
	});

	it('preserves unsequenced prepare events by fallback key', () => {
		const initial: PrepareEvent[] = [
			{ id: 'a', type: 'system', payload: { text: 'unsequenced initial' } },
			{ id: 'same', type: 'output', payload: { text: 'initial replacement target' } },
			{ id: 'b', seq: 2, type: 'output', payload: { text: 'initial sequenced' } }
		];
		const live: PrepareEvent[] = [
			{ id: 'same', type: 'output', payload: { text: 'live replacement' } },
			{ id: 'b-live', seq: 2, type: 'output', payload: { text: 'live sequenced replacement' } },
			{ type: 'system', payload: { text: 'anonymous live' } }
		];

		expect(mergePrepareEvents(initial, live).map((event) => event.payload)).toEqual([
			{ text: 'unsequenced initial' },
			{ text: 'live replacement' },
			{ text: 'live sequenced replacement' },
			{ text: 'anonymous live' }
		]);
	});
});
