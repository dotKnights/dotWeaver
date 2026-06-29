export class ProjectEnvironmentServiceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ProjectEnvironmentServiceError';
	}
}
