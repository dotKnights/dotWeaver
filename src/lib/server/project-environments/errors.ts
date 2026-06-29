export class ProjectEnvironmentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ProjectEnvironmentError';
	}
}
