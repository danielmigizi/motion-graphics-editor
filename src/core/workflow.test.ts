import { describe, expect, it } from 'vitest';
import { routeWorkflow, workflowLine, WORKFLOW_IDS, WORKFLOWS } from './workflow';

describe('workflow router', () => {
  it('picks the first matching deliverable', () => {
    expect(routeWorkflow({ brief: 'Launch video for Relay, release notes your team reads.' })).toBe('product-launch');
    expect(routeWorkflow({ brief: 'A 6 second logo sting' })).toBe('short-sting');
    expect(routeWorkflow({ brief: 'Beat-sync this track, no narration', hasMusic: true, targetSeconds: 12 })).toBe('music-led');
    expect(routeWorkflow({ brief: 'A kinetic type piece about noise vs signal' })).toBe('kinetic-type');
    expect(routeWorkflow({ brief: 'Something custom for the offsite' })).toBe('general');
  });

  it('does not let a music bed steal a launch', () => {
    expect(routeWorkflow({ brief: 'Product launch with a music bed', hasMusic: true, targetSeconds: 24 })).toBe('product-launch');
  });

  it('names pack, templates and story for every route', () => {
    expect(WORKFLOW_IDS).toHaveLength(5);
    for (const id of WORKFLOW_IDS) {
      const line = workflowLine(id);
      expect(line).toContain(WORKFLOWS[id].pack);
      expect(line).toContain(WORKFLOWS[id].templates[0]);
      expect(line).toContain(WORKFLOWS[id].story);
    }
  });
});
