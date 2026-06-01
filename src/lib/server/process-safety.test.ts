import { describe, it, expect, vi, afterEach } from 'vitest';
import { installProcessSafetyNet } from './process-safety';

afterEach(() => {
	process.removeAllListeners('unhandledRejection');
	process.removeAllListeners('uncaughtException');
	vi.restoreAllMocks();
});

describe('installProcessSafetyNet', () => {
	it('registers unhandledRejection + uncaughtException listeners once (idempotent)', () => {
		installProcessSafetyNet('test');
		installProcessSafetyNet('test');
		expect(process.listenerCount('unhandledRejection')).toBe(1);
		expect(process.listenerCount('uncaughtException')).toBe(1);
	});

	it('logs the rejection instead of rethrowing (no crash)', () => {
		const err = vi.spyOn(console, 'error').mockImplementation(() => {});
		installProcessSafetyNet('test');
		expect(() =>
			process.emit('unhandledRejection', new Error('boom'), Promise.resolve())
		).not.toThrow();
		expect(err).toHaveBeenCalled();
	});
});
