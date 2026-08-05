import { prisma } from '$lib/server/prisma';
import { createAdmin } from 'sveltekit-admin';

export const admin = createAdmin({
  prisma,
  schemaPath: './prisma/schema.prisma',
  basePath: '/admin',
  exclude: ['Session', 'Account', 'Verification', 'OauthApplication', 'OauthAccessToken', 'OauthConsent'],
  models: {
    User: {
      hidden: ['password'],
      readonly: ['id', 'createdAt', 'updatedAt'],
      listFields: ['email', 'name', 'emailVerified', 'createdAt'],
      label: 'Users'
    },
    Organization: {
      hidden: ['webhookSecretEncrypted'],
      readonly: ['id', 'createdAt'],
      listFields: ['name', 'slug', 'createdAt'],
      label: 'Organizations'
    },
    Project: {
      readonly: ['id', 'createdAt', 'updatedAt'],
      listFields: ['name', 'owner', 'defaultBranch', 'private', 'createdAt'],
      label: 'Projects'
    },
    Run: {
      readonly: ['id', 'createdAt', 'updatedAt', 'startedAt', 'completedAt'],
      listFields: ['status', 'prompt', 'createdAt'],
      label: 'Runs'
    },
    Member: {
      readonly: ['id', 'createdAt'],
      listFields: ['role', 'createdAt'],
      label: 'Members'
    },
    Invitation: {
      readonly: ['id', 'createdAt'],
      listFields: ['email', 'role', 'status', 'expiresAt'],
      label: 'Invitations'
    },
    ClientOrganization: {
      readonly: ['id', 'createdAt', 'updatedAt'],
      listFields: ['name', 'slug', 'createdAt'],
      label: 'Client Organizations'
    },
    GithubTrigger: {
      readonly: ['id', 'createdAt', 'updatedAt'],
      listFields: ['name', 'eventType', 'enabled', 'createdAt'],
      label: 'GitHub Triggers'
    }
  },
  branding: {
    title: 'dotWeaver Admin',
    primaryColor: '#6366f1'
  },
  // Admin check: user must have admin role in any organization
  checkAdmin: async (user: any) => {
    if (!user?.id) return false;
    const member = await prisma.member.findFirst({
      where: { userId: user.id, role: 'admin' }
    });
    return !!member;
  }
});
