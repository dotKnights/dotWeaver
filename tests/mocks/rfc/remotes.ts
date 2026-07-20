type QueryState<T> = {
	current: T;
	error: undefined;
	refresh: () => Promise<void>;
};

function queryState<T>(current: T): QueryState<T> {
	return {
		current,
		error: undefined,
		refresh: async () => undefined
	};
}

const emptyCommand = async () => ({});

export const listConnectors = () =>
	queryState({
		github: { connected: false, canDisconnect: false },
		google: {
			connected: false,
			canDisconnect: false,
			hasGmailScope: false,
			needsReconnect: false
		},
		hasPassword: false,
		githubOrgAccessUrl: ''
	});
export const disconnectGithub = emptyCommand;
export const disconnectGoogle = emptyCommand;

export const listMailThreads = () => queryState([]);
export const syncNextMailPage = emptyCommand;
export const getMailThread = () => queryState(null);

export const getPokeConnector = () =>
	queryState({ connected: false, enabled: false, lastNotifiedAt: null, lastError: null });
export const getPokeLoginState = () => queryState({ status: 'idle', loggedIn: false });
export const setPokeEnabled = emptyCommand;
export const startPokeLogin = emptyCommand;
export const deletePokeConnector = emptyCommand;

export const getProjectAgentConfig = () => queryState(undefined);
export const searchSkillsSh = () => queryState({ skills: [] });
export const getSkillsShSkill = () => queryState(null);
export const upsertProjectMcpServer = emptyCommand;
export const upsertProjectSkill = emptyCommand;
export const importSkillsShSkill = emptyCommand;
export const upsertProjectSecret = emptyCommand;
export const upsertProjectEnvVar = emptyCommand;
export const deleteProjectEnvVar = emptyCommand;
export const setProjectEnvVarEnabled = emptyCommand;
export const setProjectEnvVarSensitive = emptyCommand;
export const revealProjectEnvVar = emptyCommand;
export const importProjectEnvFile = emptyCommand;
export const deleteProjectMcpServer = emptyCommand;
export const deleteProjectSkill = emptyCommand;
export const deleteProjectSecret = emptyCommand;
export const setProjectMcpServerEnabled = emptyCommand;
export const setProjectSkillEnabled = emptyCommand;
export const importProjectMcpJson = emptyCommand;

export const getProjectEnvironmentServices = () => queryState([]);
export const createProjectEnvironmentService = emptyCommand;
export const provisionProjectEnvironmentService = emptyCommand;
export const setProjectEnvironmentServiceEnabled = emptyCommand;
export const updateProjectEnvironmentServiceEnvMappings = emptyCommand;

export const listGithubRepos = () => queryState({ connected: false, repos: [] });
export const listProjects = () => queryState([]);
export const getProject = () => queryState(null);
export const getProjectCapabilities = () =>
	queryState({
		'project.view': true,
		'project.manage_access': true,
		'project.config.view': true,
		'project.config.manage': true,
		'run.view': true,
		'run.create': true,
		'run.reply': true,
		'run.diff.view': true,
		'run.approve': true
	});
export const listProjectBranches = () => queryState([]);
export const importProject = emptyCommand;

export const getProjectEnvironment = () => queryState(null);
export const getProjectEnvironmentPrepareEvents = () => queryState([]);
export const detectProjectEnvironment = emptyCommand;
export const saveProjectEnvironment = emptyCommand;
export const prepareProjectEnvironment = emptyCommand;

export const startRun = emptyCommand;
export const cancelRun = emptyCommand;
export const answerRunInteraction = emptyCommand;
export const replyToRun = emptyCommand;
export const listRuns = () => queryState([]);
export const getRun = () => queryState(null);
export const getRunDiff = () => queryState(null);
export const approveRun = emptyCommand;

export const listMyTeams = () =>
	queryState({
		teams: [],
		activeOrganizationId: null,
		hasInternalTeams: false,
		hasClientAccess: false
	});
export const getTeam = () => queryState(null);
export const createTeam = emptyCommand;
export const inviteMember = emptyCommand;
export const acceptInvitation = emptyCommand;
export const cancelInvitation = emptyCommand;
export const setActiveTeam = emptyCommand;
export const removeMember = emptyCommand;

export const listClients = () => queryState([]);
export const createClient = emptyCommand;
export const inviteClient = emptyCommand;
export const removeClientContact = emptyCommand;
export const deleteClient = emptyCommand;
export const acceptClientInvitation = emptyCommand;
export const getProjectAccess = () => queryState([]);
export const upsertProjectAccess = emptyCommand;
export const removeProjectAccess = emptyCommand;
