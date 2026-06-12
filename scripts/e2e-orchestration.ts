// Manual end-to-end harness for the run orchestration (DOT-16 P2B), no browser.
// Seeds a User + a public-repo Project + a queued Run, enqueues it, then polls the
// Run status until terminal. The worker (`bun run runner`, separate process) performs
// the actual clone → container → agent → commit → awaiting_review.
//
// Run with:  bun run runner:e2e   (uses vite.runner.config.ts so $lib/$env resolve)
import { randomUUID } from 'node:crypto';
import { prisma } from '$lib/server/prisma';
import { enqueueRun } from '$lib/server/queue';
import { agentBranch } from '$lib/server/workspace-paths';
import { RUN_STATUS, isWorkerDoneRunStatus } from '$lib/domain/run-status';

const ORG = 'org-e2e';
const USER = 'user-e2e';

await prisma.user.upsert({
	where: { id: USER },
	update: {},
	create: {
		id: USER,
		name: 'E2E User',
		email: 'e2e@example.com',
		emailVerified: true,
		createdAt: new Date(),
		updatedAt: new Date()
	}
});

const project = await prisma.project.upsert({
	where: { organizationId_githubRepoId: { organizationId: ORG, githubRepoId: 'hello-world' } },
	update: {},
	create: {
		organizationId: ORG,
		githubRepoId: 'hello-world',
		owner: 'octocat',
		name: 'Hello-World',
		defaultBranch: 'master',
		cloneUrl: 'https://github.com/octocat/Hello-World.git',
		private: false,
		importedById: USER
	}
});

const runId = randomUUID();
await prisma.run.create({
	data: {
		id: runId,
		projectId: project.id,
		organizationId: ORG,
		createdById: USER,
		prompt: 'Create a file AGENT_RAN.md containing exactly one line: the agent ran. Then stop.',
		agentBranch: agentBranch(runId),
		status: RUN_STATUS.QUEUED
	}
});
console.log(`SEEDED project=${project.id} run=${runId}`);

await enqueueRun(runId);
console.log('ENQUEUED — polling…');

for (let i = 0; i < 90; i++) {
	await new Promise((r) => setTimeout(r, 2000));
	const r = await prisma.run.findUnique({
		where: { id: runId },
		include: { _count: { select: { events: true } } }
	});
	if (!r) continue;
	console.log(
		`[${String(i).padStart(2)}] status=${r.status} base=${r.baseCommitSha?.slice(0, 7) ?? '-'} head=${r.headCommitSha?.slice(0, 7) ?? '-'} session=${r.sessionId?.slice(0, 8) ?? '-'} events=${r._count.events}`
	);
	if (isWorkerDoneRunStatus(r.status)) {
		console.log(`FINAL status=${r.status} error=${r.error ?? 'none'}`);
		break;
	}
}
process.exit(0);
