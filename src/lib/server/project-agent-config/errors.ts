export class ProjectAgentConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ProjectAgentConfigError';
	}
}
