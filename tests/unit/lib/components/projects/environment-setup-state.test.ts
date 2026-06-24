import { describe, expect, it } from 'vitest';
import {
	computeEnvironmentSetupState,
	eventLabel,
	isPreparedEnvironment,
	mergePrepareEvents,
	type EnvironmentProfile,
	type PrepareEvent
} from '$lib/components/projects/environment-setup-state';

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
