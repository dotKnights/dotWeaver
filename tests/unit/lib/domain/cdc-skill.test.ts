import { describe, expect, it } from 'vitest';
import { CDC_MARKER_END, CDC_MARKER_START } from '../../../../src/lib/domain/cdc-document';
import { CDC_SKILL_NAME } from '../../../../src/lib/domain/run-mode';
import { CDC_SKILL_BODY, buildNativeCdcSkill } from '../../../../src/lib/domain/cdc-skill';

describe('cdc-skill domain', () => {
	it('exposes a SKILL.md body with valid frontmatter naming the cdc skill', () => {
		expect(CDC_SKILL_BODY.startsWith('---\n')).toBe(true);
		expect(CDC_SKILL_BODY).toMatch(/^---\nname: .+\ndescription: .+\n---/);
		expect(CDC_SKILL_BODY).toContain(`name: ${CDC_SKILL_NAME}`);
	});

	it('tells the agent to wrap the final CDC in the stable dotWeaver markers', () => {
		expect(CDC_SKILL_BODY).toContain(CDC_MARKER_START);
		expect(CDC_SKILL_BODY).toContain(CDC_MARKER_END);
	});

	it('ships the expected CDC template sections', () => {
		for (const heading of ['## Contexte', '## Objectifs', "## Critères d'acceptation"]) {
			expect(CDC_SKILL_BODY).toContain(heading);
		}
	});

	it('builds a native skill entry for the runtime agent config', () => {
		expect(buildNativeCdcSkill()).toEqual({
			name: CDC_SKILL_NAME,
			body: CDC_SKILL_BODY,
			files: []
		});
	});
});
